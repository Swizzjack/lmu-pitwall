use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::post_race::api::handle_command;
use crate::protocol::messages::{ClientCommand, ServerMessage};

/// Broadcast channel capacity — number of queued messages per slow client
/// before older messages are dropped (lagged receiver).
const BROADCAST_CAPACITY: usize = 128;

/// Wire serialization format negotiated per-client via query parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// MessagePack binary — primary format, compact and fast.
    MsgPack,
    /// JSON text — enabled via `?format=json`, useful for debugging.
    Json,
}

/// WebSocket broadcast server.
///
/// Accepts clients on `ws://0.0.0.0:<port>` and fans out every
/// [`ServerMessage`] sent via [`broadcast`] to all connected clients.
pub struct WebSocketServer {
    port: u16,
    tx: broadcast::Sender<Arc<ServerMessage>>,
    /// Live count of connected WebSocket clients.
    client_count: Arc<AtomicUsize>,
    /// Watch channel — subscribers receive the new count on every change.
    count_tx: watch::Sender<usize>,
    /// Latest AllDriversUpdate — sent immediately to newly connecting clients.
    all_drivers_rx: watch::Receiver<Option<ServerMessage>>,
}

impl WebSocketServer {
    pub fn new(port: u16, all_drivers_rx: watch::Receiver<Option<ServerMessage>>) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (count_tx, _) = watch::channel(0usize);
        WebSocketServer {
            port,
            tx,
            client_count: Arc::new(AtomicUsize::new(0)),
            count_tx,
            all_drivers_rx,
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Subscribe to client-count changes.
    pub fn client_count_rx(&self) -> watch::Receiver<usize> {
        self.count_tx.subscribe()
    }

    /// Returns a cloned sender for broadcasting from another task.
    pub fn broadcaster(&self) -> broadcast::Sender<Arc<ServerMessage>> {
        self.tx.clone()
    }

    /// Send a message to every connected client.
    pub fn broadcast(&self, msg: ServerMessage) -> usize {
        match self.tx.send(Arc::new(msg)) {
            Ok(n) => n,
            Err(_) => 0,
        }
    }

    /// Accept a single WebSocket client from an already-accepted `TcpStream`.
    pub fn accept_client(&self, stream: TcpStream, peer: SocketAddr) {
        info!("New WebSocket connection from {}", peer);
        let rx = self.tx.subscribe();

        let count = self.client_count.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.count_tx.send(count);

        tokio::spawn(handle_client(
            stream,
            peer,
            rx,
            self.client_count.clone(),
            self.count_tx.clone(),
            self.all_drivers_rx.clone(),
        ));
    }
}

// ---------------------------------------------------------------------------
// Per-client handler
// ---------------------------------------------------------------------------

async fn handle_client(
    stream: TcpStream,
    peer: SocketAddr,
    mut rx: broadcast::Receiver<Arc<ServerMessage>>,
    client_count: Arc<AtomicUsize>,
    count_tx: watch::Sender<usize>,
    all_drivers_rx: watch::Receiver<Option<ServerMessage>>,
) {
    let is_json = Arc::new(AtomicBool::new(false));
    let is_json_cb = is_json.clone();

    let ws =
        match tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, resp: Response| {
            let json_requested = req
                .uri()
                .query()
                .map(|q| q.split('&').any(|p| p == "format=json"))
                .unwrap_or(false);
            if json_requested {
                is_json_cb.store(true, Ordering::Relaxed);
            }
            Ok(resp)
        })
        .await
        {
            Ok(ws) => ws,
            Err(e) => {
                warn!("WebSocket handshake failed for {}: {}", peer, e);
                return;
            }
        };

    let fmt = if is_json.load(Ordering::Relaxed) {
        Format::Json
    } else {
        Format::MsgPack
    };
    info!("Client {} connected (format: {:?})", peer, fmt);

    let (mut sink, mut incoming) = ws.split();

    // Send the latest AllDriversUpdate snapshot immediately on connect so the
    // frontend doesn't wait until the next car crosses the S/F line.
    {
        let latest = all_drivers_rx.borrow().clone();
        if let Some(msg) = latest {
            if let Ok(ws_msg) = serialize(&msg, fmt) {
                let _ = sink.send(ws_msg).await;
            }
        }
    }

    loop {
        tokio::select! {
            // Outbound: receive broadcast message and forward to this client.
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
                        match serialize(&msg, fmt) {
                            Ok(ws_msg) => {
                                if let Err(e) = sink.send(ws_msg).await {
                                    debug!("Send to {} failed: {}", peer, e);
                                    break;
                                }
                            }
                            Err(e) => {
                                warn!("Serialization error for {}: {}", peer, e);
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(dropped)) => {
                        warn!(
                            "Client {} is too slow, dropped {} messages",
                            peer, dropped
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }

            // Inbound: dispatch text commands; close and drop everything else.
            frame = incoming.next() => {
                match frame {
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("Client {} sent close", peer);
                        break;
                    }
                    Some(Err(e)) => {
                        debug!("Client {} connection error: {}", peer, e);
                        break;
                    }
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientCommand>(&text) {
                            Ok(cmd) => {
                                let response = tokio::task::spawn_blocking(move || {
                                    handle_command(cmd)
                                })
                                .await;
                                match response {
                                    Ok(msg) => {
                                        match serialize(&msg, fmt) {
                                            Ok(ws_msg) => {
                                                if let Err(e) = sink.send(ws_msg).await {
                                                    debug!(
                                                        "Send to {} failed: {}",
                                                        peer, e
                                                    );
                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                warn!(
                                                    "Serialization error for {}: {}",
                                                    peer, e
                                                );
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        warn!(
                                            "Post-race task panicked for {}: {}",
                                            peer, e
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                warn!(
                                    "Unparseable client command from {}: {}",
                                    peer, e
                                );
                            }
                        }
                    }
                    Some(Ok(_)) => {
                        // Binary and other frames ignored.
                    }
                }
            }
        }
    }

    let prev = client_count.fetch_sub(1, Ordering::Relaxed);
    let new_count = prev.saturating_sub(1);
    let _ = count_tx.send(new_count);
    info!("Client {} disconnected ({} remaining)", peer, new_count);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

fn serialize(msg: &ServerMessage, fmt: Format) -> Result<Message> {
    match fmt {
        Format::MsgPack => {
            let bytes = rmp_serde::to_vec_named(msg)?;
            Ok(Message::Binary(bytes.into()))
        }
        Format::Json => {
            let text = serde_json::to_string(msg)?;
            Ok(Message::Text(text.into()))
        }
    }
}
