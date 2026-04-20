use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use tokio::sync::mpsc;
use tracing::info;

use super::config::VOICES;
use super::paths::{voice_config, voice_model, voices_dir};
use super::piper_binary::download_file;
use super::DownloadProgress;

pub struct VoiceInstallStatus {
    pub voice_id: String,
    pub installed: bool,
    pub model_path: Option<PathBuf>,
    pub config_path: Option<PathBuf>,
}

pub fn list_voices() -> Vec<VoiceInstallStatus> {
    VOICES
        .iter()
        .map(|v| {
            let model = voice_model(v.id);
            let cfg = voice_config(v.id);
            let installed = model.exists() && cfg.exists();
            VoiceInstallStatus {
                voice_id: v.id.to_string(),
                installed,
                model_path: installed.then(|| model),
                config_path: installed.then(|| cfg),
            }
        })
        .collect()
}

pub fn is_installed(voice_id: &str) -> bool {
    voice_model(voice_id).exists() && voice_config(voice_id).exists()
}

pub async fn install_voice(
    voice_id: &str,
    progress_tx: mpsc::Sender<DownloadProgress>,
) -> Result<()> {
    let def = VOICES
        .iter()
        .find(|v| v.id == voice_id)
        .ok_or_else(|| anyhow!("Unknown voice: {voice_id}"))?;

    let voices_dir = voices_dir();
    std::fs::create_dir_all(&voices_dir).context("Failed to create voices directory")?;

    let model_tmp = voices_dir.join(format!("{voice_id}.onnx.tmp"));
    let config_tmp = voices_dir.join(format!("{voice_id}.onnx.json.tmp"));

    let cleanup = |model_tmp: &std::path::Path, config_tmp: &std::path::Path| {
        let _ = std::fs::remove_file(model_tmp);
        let _ = std::fs::remove_file(config_tmp);
    };

    // Download model and config sequentially (ureq is blocking, avoids thread contention)
    download_file(def.model_url, &model_tmp, &progress_tx, "voice", Some(voice_id))
        .await
        .inspect_err(|_| cleanup(&model_tmp, &config_tmp))?;

    download_file(def.config_url, &config_tmp, &progress_tx, "voice", Some(voice_id))
        .await
        .inspect_err(|_| cleanup(&model_tmp, &config_tmp))?;

    let _ = progress_tx.send(DownloadProgress {
        bytes_downloaded: 0,
        bytes_total: None,
        stage: "validating".to_string(),
        target: "voice".to_string(),
        target_id: Some(voice_id.to_string()),
    }).await;

    // Validate sizes
    let model_size = std::fs::metadata(&model_tmp)
        .map(|m| m.len())
        .unwrap_or(0);
    let config_size = std::fs::metadata(&config_tmp)
        .map(|m| m.len())
        .unwrap_or(0);

    if model_size < 10 * 1024 * 1024 {
        cleanup(&model_tmp, &config_tmp);
        return Err(anyhow!(
            "Voice model too small ({model_size} bytes) — likely a 404 page"
        ));
    }
    if config_size > 1024 * 1024 {
        cleanup(&model_tmp, &config_tmp);
        return Err(anyhow!(
            "Voice config too large ({config_size} bytes) — unexpected content"
        ));
    }

    // Atomic rename
    std::fs::rename(&model_tmp, voice_model(voice_id))
        .inspect_err(|_| cleanup(&model_tmp, &config_tmp))
        .context("Failed to rename model file")?;
    std::fs::rename(&config_tmp, voice_config(voice_id))
        .context("Failed to rename config file")?;

    info!("Voice {voice_id} installed successfully");
    Ok(())
}

pub fn uninstall_voice(voice_id: &str) -> Result<()> {
    let model = voice_model(voice_id);
    let cfg = voice_config(voice_id);

    if model.exists() {
        std::fs::remove_file(&model)
            .with_context(|| format!("Failed to remove {:?}", model))?;
    }
    if cfg.exists() {
        std::fs::remove_file(&cfg)
            .with_context(|| format!("Failed to remove {:?}", cfg))?;
    }

    info!("Voice {voice_id} uninstalled");
    Ok(())
}
