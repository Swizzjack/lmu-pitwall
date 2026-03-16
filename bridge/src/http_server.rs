//! Combined HTTP + WebSocket server on a single port.
//!
//! - Incoming connection has `Upgrade: websocket` → handed to the WS handler.
//! - All other HTTP GET requests → static files embedded via rust-embed.
//! - Unknown paths fall back to `index.html` for SPA client-side routing.
//! - CORS headers are set so Android/remote browsers can connect freely.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

use crate::assets::Asset;
use crate::websocket::server::WebSocketServer;

/// Bind on `0.0.0.0:port` and serve HTTP + WebSocket connections.
pub async fn run(ws: Arc<WebSocketServer>, port: u16) -> Result<()> {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await?;
    info!(
        "Dashboard available at http://0.0.0.0:{} — open http://localhost:{} in your browser",
        port, port
    );

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let ws = ws.clone();
                tokio::spawn(async move {
                    handle_connection(stream, peer, ws).await;
                });
            }
            Err(e) => {
                warn!("TCP accept error: {}", e);
            }
        }
    }
}

async fn handle_connection(stream: TcpStream, peer: SocketAddr, ws: Arc<WebSocketServer>) {
    // Peek without consuming so the WS handshake can re-read the same bytes.
    let mut buf = [0u8; 4096];
    let n = match stream.peek(&mut buf).await {
        Ok(n) => n,
        Err(e) => {
            debug!("Peek error from {}: {}", peer, e);
            return;
        }
    };

    let preview = String::from_utf8_lossy(&buf[..n]).to_lowercase();

    if preview.contains("upgrade: websocket") {
        // WebSocket upgrade — tokio-tungstenite will re-read the request.
        ws.accept_client(stream, peer);
    } else {
        if let Err(e) = handle_http(stream).await {
            debug!("HTTP handler error from {}: {}", peer, e);
        }
    }
}

// ---------------------------------------------------------------------------
// Minimal HTTP/1.1 static-file handler
// ---------------------------------------------------------------------------

async fn handle_http(mut stream: TcpStream) -> Result<()> {
    // Read until end of HTTP headers (\r\n\r\n).
    let mut request = Vec::with_capacity(2048);
    let mut buf = [0u8; 4096];

    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        request.extend_from_slice(&buf[..n]);
        if request.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if request.len() > 32_768 {
            send_response(&mut stream, 413, "text/plain", b"Request Too Large", &[]).await?;
            return Ok(());
        }
    }

    let request_str = String::from_utf8_lossy(&request);

    // Only handle GET (and HEAD/OPTIONS for CORS preflight).
    let method = request_str
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or("")
        .to_uppercase();

    let path = parse_path(&request_str);

    if method == "OPTIONS" {
        // CORS preflight
        let cors = [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
            ("Access-Control-Allow-Headers", "*"),
        ];
        send_response(&mut stream, 204, "text/plain", b"", &cors).await?;
        return Ok(());
    }

    // API routes
    if path == "/api/version" {
        let body = format!(r#"{{"version":"{}"}}"#, env!("CARGO_PKG_VERSION"));
        let cors = [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, OPTIONS"),
        ];
        send_response(&mut stream, 200, "application/json", body.as_bytes(), &cors).await?;
        return Ok(());
    }

    if path == "/api/shutdown" && method == "POST" {
        let cors = [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ];
        send_response(&mut stream, 200, "application/json", b"{\"ok\":true}", &cors).await?;
        // Response is written — exit cleanly so the new instance can take over the port.
        std::process::exit(0);
    }

    serve_static(&mut stream, &path).await
}

fn parse_path(request: &str) -> String {
    let first_line = request.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.splitn(3, ' ').collect();
    if parts.len() >= 2 {
        parts[1].split('?').next().unwrap_or("/").to_string()
    } else {
        "/".to_string()
    }
}

async fn serve_static(stream: &mut TcpStream, path: &str) -> Result<()> {
    let file_path = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    let cors = [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, OPTIONS"),
    ];

    if let Some(file) = Asset::get(file_path) {
        let mime = mime_type(file_path);
        // Add cache headers for hashed assets (everything under assets/)
        let cache = if file_path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        let mut headers: Vec<(&str, &str)> = cors.to_vec();
        headers.push(("Cache-Control", cache));
        send_response(stream, 200, mime, &file.data, &headers).await
    } else {
        // SPA fallback: serve index.html for any unrecognised path
        if let Some(index) = Asset::get("index.html") {
            let mut headers: Vec<(&str, &str)> = cors.to_vec();
            headers.push(("Cache-Control", "no-cache"));
            send_response(
                stream,
                200,
                "text/html; charset=utf-8",
                &index.data,
                &headers,
            )
            .await
        } else {
            send_response(stream, 404, "text/plain", b"Not Found", &cors).await
        }
    }
}

fn mime_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn send_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) -> Result<()> {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        404 => "Not Found",
        413 => "Request Entity Too Large",
        _ => "Unknown",
    };

    let mut response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        status, status_text, content_type, body.len()
    );
    for (name, value) in extra_headers {
        response.push_str(&format!("{}: {}\r\n", name, value));
    }
    response.push_str("\r\n");

    stream.write_all(response.as_bytes()).await?;
    stream.write_all(body).await?;
    Ok(())
}
