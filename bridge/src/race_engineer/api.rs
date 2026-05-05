use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn};

use crate::protocol::messages::{
    ClientCommand, EngineerVoiceStatus, ServerMessage,
};

use super::audio::{pcm_to_wav, wav_to_base64};
use super::config;
use super::piper_binary;
use super::rules::dispatcher::EngineerBehavior;
use super::rules::{FrequencyLevel};
use super::tts_engine::{SynthesisRequest, TtsError};
use super::voice_manager;
use super::DownloadProgress;
use super::RaceEngineerService;

/// Dispatch an engineer ClientCommand.
///
/// Long-running operations (install, synthesize) are spawned as background
/// tasks that broadcast progress/results to all clients. Returns immediately.
///
/// `audio_broadcaster` is used exclusively for `EngineerAudio` messages so
/// that clients registered as `display_only` do not receive WAV payloads.
pub async fn handle_command(
    cmd: ClientCommand,
    service: Arc<RaceEngineerService>,
    broadcaster: broadcast::Sender<Arc<ServerMessage>>,
    audio_broadcaster: broadcast::Sender<Arc<ServerMessage>>,
) {
    match cmd {
        ClientCommand::EngineerGetStatus => {
            let msg = build_status();
            broadcast_msg(&broadcaster, msg);
        }

        ClientCommand::EngineerInstallPiper => {
            tokio::spawn(async move {
                run_install_piper(broadcaster).await;
            });
        }

        ClientCommand::EngineerInstallVoice { voice_id } => {
            tokio::spawn(async move {
                run_install_voice(voice_id, broadcaster).await;
            });
        }

        ClientCommand::EngineerUninstallVoice { voice_id } => {
            match voice_manager::uninstall_voice(&voice_id) {
                Ok(()) => broadcast_msg(
                    &broadcaster,
                    ServerMessage::EngineerInstallComplete {
                        target: "voice".to_string(),
                        target_id: Some(voice_id),
                        success: true,
                        error: None,
                    },
                ),
                Err(e) => {
                    warn!("Failed to uninstall voice {voice_id}: {e}");
                    broadcast_msg(
                        &broadcaster,
                        ServerMessage::EngineerInstallComplete {
                            target: "voice".to_string(),
                            target_id: Some(voice_id),
                            success: false,
                            error: Some(e.to_string()),
                        },
                    );
                }
            }
        }

        ClientCommand::EngineerSynthesize {
            voice_id,
            text,
            request_id,
        } => {
            tokio::spawn(async move {
                run_synthesize(service, audio_broadcaster, voice_id, text, request_id).await;
            });
        }

        ClientCommand::EngineerUpdateBehavior {
            enabled,
            frequency,
            mute_in_qualifying,
            debug_all_rules_in_practice,
            active_voice_id,
            pilot_name,
            mute_name,
        } => {
            info!(
                "Behavior updated: enabled={enabled}, frequency={frequency}, \
                 mute_qual={mute_in_qualifying}, debug_practice={debug_all_rules_in_practice}, \
                 voice={:?}, pilot={:?}, mute_name={mute_name}",
                active_voice_id, pilot_name
            );
            let behavior = EngineerBehavior {
                enabled,
                frequency: FrequencyLevel::from_str(&frequency),
                mute_in_qualifying,
                debug_all_rules_in_practice,
                active_voice: active_voice_id,
                pilot_name: pilot_name.filter(|n| !n.is_empty()),
                mute_name,
            };
            service.dispatcher.lock().await.update_behavior(behavior);
        }

        _ => {}
    }
}

// ---------------------------------------------------------------------------

fn build_status() -> ServerMessage {
    let piper_installed = piper_binary::is_installed();
    let voices = voice_manager::list_voices()
        .into_iter()
        .map(|v| EngineerVoiceStatus {
            voice_id: v.voice_id,
            installed: v.installed,
        })
        .collect();
    ServerMessage::EngineerStatus {
        piper_installed,
        piper_version: config::PIPER_VERSION,
        voices,
    }
}

async fn run_install_piper(broadcaster: broadcast::Sender<Arc<ServerMessage>>) {
    info!("Starting Piper installation");
    let (tx, mut rx) = mpsc::channel::<DownloadProgress>(64);

    let broadcaster2 = broadcaster.clone();
    tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            broadcast_msg(
                &broadcaster2,
                ServerMessage::EngineerInstallProgress {
                    target: p.target,
                    target_id: p.target_id,
                    bytes_downloaded: p.bytes_downloaded,
                    bytes_total: p.bytes_total,
                    stage: p.stage,
                },
            );
        }
    });

    match piper_binary::install(tx).await {
        Ok(()) => {
            info!("Piper installation complete");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerInstallComplete {
                    target: "piper".to_string(),
                    target_id: None,
                    success: true,
                    error: None,
                },
            );
        }
        Err(e) => {
            warn!("Piper installation failed: {e}");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerInstallComplete {
                    target: "piper".to_string(),
                    target_id: None,
                    success: false,
                    error: Some(e.to_string()),
                },
            );
        }
    }
}

async fn run_install_voice(voice_id: String, broadcaster: broadcast::Sender<Arc<ServerMessage>>) {
    info!("Starting voice installation: {voice_id}");
    let (tx, mut rx) = mpsc::channel::<DownloadProgress>(64);

    let broadcaster2 = broadcaster.clone();
    let vid2 = voice_id.clone();
    tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            broadcast_msg(
                &broadcaster2,
                ServerMessage::EngineerInstallProgress {
                    target: p.target,
                    target_id: p.target_id,
                    bytes_downloaded: p.bytes_downloaded,
                    bytes_total: p.bytes_total,
                    stage: p.stage,
                },
            );
        }
    });

    match voice_manager::install_voice(&voice_id, tx).await {
        Ok(()) => {
            info!("Voice {voice_id} installation complete");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerInstallComplete {
                    target: "voice".to_string(),
                    target_id: Some(voice_id),
                    success: true,
                    error: None,
                },
            );
        }
        Err(e) => {
            warn!("Voice {voice_id} installation failed: {e}");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerInstallComplete {
                    target: "voice".to_string(),
                    target_id: Some(voice_id),
                    success: false,
                    error: Some(e.to_string()),
                },
            );
        }
    }
}

async fn run_synthesize(
    service: Arc<RaceEngineerService>,
    broadcaster: broadcast::Sender<Arc<ServerMessage>>,
    voice_id: String,
    text: String,
    request_id: String,
) {
    info!("Synthesizing for voice={voice_id} request_id={request_id}");

    let req = SynthesisRequest {
        text: text.clone(),
        voice_id: voice_id.clone(),
    };

    let mut engine = service.engine.lock().await;
    match engine.synthesize(req).await {
        Ok(result) => {
            let wav = pcm_to_wav(&result.pcm, result.sample_rate);
            let wav_base64 = wav_to_base64(&wav);
            let n = broadcaster.receiver_count();
            debug!("Engineer audio broadcast to {n} audio clients");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerAudio {
                    request_id,
                    priority: "info".to_string(),
                    wav_base64,
                    sample_rate: result.sample_rate,
                    duration_ms: result.duration_ms,
                    text,
                },
            );
        }
        Err(TtsError::VoiceNotInstalled(id)) => {
            warn!("Synthesis failed: voice not installed: {id}");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerError {
                    message: format!("Voice not installed: {id}"),
                },
            );
        }
        Err(TtsError::PiperNotInstalled) => {
            warn!("Synthesis failed: piper not installed");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerError {
                    message: "Piper not installed".to_string(),
                },
            );
        }
        Err(e) => {
            warn!("Synthesis error: {e}");
            broadcast_msg(
                &broadcaster,
                ServerMessage::EngineerError {
                    message: e.to_string(),
                },
            );
        }
    }
}

fn broadcast_msg(tx: &broadcast::Sender<Arc<ServerMessage>>, msg: ServerMessage) {
    let _ = tx.send(Arc::new(msg));
}
