use std::io::{Read, Write};

use anyhow::{anyhow, Context, Result};
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::config;
use super::paths::{piper_dir, piper_exe};
use super::DownloadProgress;

pub fn is_installed() -> bool {
    piper_exe().exists()
}

pub async fn install(progress_tx: mpsc::Sender<DownloadProgress>) -> Result<()> {
    let download_url = config::PIPER_WINDOWS_ZIP_URL;
    info!("Downloading Piper {} from {}", config::PIPER_VERSION, download_url);

    let piper_dir = piper_dir();
    std::fs::create_dir_all(&piper_dir)
        .context("Failed to create piper directory")?;

    let tmp_zip = piper_dir.join("piper_download.zip.tmp");
    download_file(&download_url, &tmp_zip, &progress_tx, "piper", None).await?;

    let _ = progress_tx.send(DownloadProgress {
        bytes_downloaded: 0,
        bytes_total: None,
        stage: "extracting".to_string(),
        target: "piper".to_string(),
        target_id: None,
    }).await;

    tokio::task::spawn_blocking({
        let tmp_zip = tmp_zip.clone();
        let piper_dir = piper_dir.clone();
        move || extract_zip(&tmp_zip, &piper_dir)
    })
    .await
    .context("Extract task panicked")??;

    let _ = std::fs::remove_file(&tmp_zip);

    let _ = progress_tx.send(DownloadProgress {
        bytes_downloaded: 0,
        bytes_total: None,
        stage: "validating".to_string(),
        target: "piper".to_string(),
        target_id: None,
    }).await;

    if !piper_exe().exists() {
        return Err(anyhow!("piper.exe not found after extraction"));
    }

    info!("Piper installed to {:?}", piper_dir);
    Ok(())
}

fn extract_zip(zip_path: &std::path::Path, dest: &std::path::Path) -> Result<()> {
    let file = std::fs::File::open(zip_path).context("Failed to open zip")?;
    let mut archive = zip::ZipArchive::new(file).context("Failed to parse zip")?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let entry_path = match entry.enclosed_name() {
            Some(p) => p.to_owned(),
            None => continue,
        };

        // Strip leading "piper/" directory if present
        let stripped = entry_path
            .components()
            .skip(1)
            .collect::<std::path::PathBuf>();
        let out_path = if stripped.as_os_str().is_empty() {
            continue;
        } else {
            dest.join(&stripped)
        };

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .with_context(|| format!("Failed to create {:?}", out_path))?;
            let mut buf = [0u8; 65536];
            loop {
                let n = entry.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out_file.write_all(&buf[..n])?;
            }
        }
    }

    Ok(())
}

pub async fn download_file(
    url: &str,
    dest: &std::path::Path,
    progress_tx: &mpsc::Sender<DownloadProgress>,
    target: &str,
    target_id: Option<&str>,
) -> Result<()> {
    let url = url.to_string();
    let dest = dest.to_path_buf();
    let target = target.to_string();
    let target_id = target_id.map(|s| s.to_string());
    let progress_tx = progress_tx.clone();

    tokio::task::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .call()
            .with_context(|| format!("HTTP GET failed: {url}"))?;

        let total = resp
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok());

        let mut reader = resp.into_reader();
        let mut file =
            std::fs::File::create(&dest).with_context(|| format!("Cannot create {:?}", dest))?;

        let mut buf = [0u8; 65536];
        let mut downloaded = 0u64;

        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            downloaded += n as u64;
            let _ = progress_tx.blocking_send(DownloadProgress {
                bytes_downloaded: downloaded,
                bytes_total: total,
                stage: "downloading".to_string(),
                target: target.clone(),
                target_id: target_id.clone(),
            });
        }

        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("Download task panicked")??;

    Ok(())
}
