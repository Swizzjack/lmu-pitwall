use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tracing::{debug, warn};

use super::paths::{piper_exe, voice_config, voice_model};
use super::piper_binary::is_installed as piper_installed;
use super::voice_manager::is_installed as voice_installed;

fn read_sample_rate(voice_id: &str) -> Option<u32> {
    let cfg = voice_config(voice_id);
    let text = std::fs::read_to_string(cfg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json["audio"]["sample_rate"].as_u64().map(|v| v as u32)
}

pub struct TtsEngine {
    current_voice: Option<String>,
    piper_process: Option<Child>,
    last_used: Instant,
}

pub struct SynthesisRequest {
    pub text: String,
    pub voice_id: String,
}

pub struct SynthesisResult {
    pub pcm: Vec<u8>,
    pub sample_rate: u32,
    pub duration_ms: u32,
}

#[derive(Debug)]
pub enum TtsError {
    PiperNotInstalled,
    VoiceNotInstalled(String),
    SynthesisFailed(anyhow::Error),
}

impl std::fmt::Display for TtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TtsError::PiperNotInstalled => write!(f, "Piper is not installed"),
            TtsError::VoiceNotInstalled(id) => write!(f, "Voice not installed: {id}"),
            TtsError::SynthesisFailed(e) => write!(f, "Synthesis failed: {e}"),
        }
    }
}

impl From<anyhow::Error> for TtsError {
    fn from(e: anyhow::Error) -> Self {
        TtsError::SynthesisFailed(e)
    }
}

impl TtsEngine {
    pub fn new() -> Self {
        Self {
            current_voice: None,
            piper_process: None,
            last_used: Instant::now(),
        }
    }

    pub async fn synthesize(&mut self, req: SynthesisRequest) -> Result<SynthesisResult, TtsError> {
        if !piper_installed() {
            return Err(TtsError::PiperNotInstalled);
        }
        if !voice_installed(&req.voice_id) {
            return Err(TtsError::VoiceNotInstalled(req.voice_id.clone()));
        }

        // Kill existing process if voice changed or idle >30s
        let voice_changed = self.current_voice.as_deref() != Some(&req.voice_id);
        let idle_too_long = self.last_used.elapsed().as_secs() > 30;

        if voice_changed || idle_too_long {
            self.shutdown();
        }

        let pcm = self.run_synthesis(&req.voice_id, &req.text).await?;

        self.current_voice = Some(req.voice_id.clone());
        self.last_used = Instant::now();

        let sample_rate = read_sample_rate(&req.voice_id).unwrap_or(22050);
        let num_samples = pcm.len() / 2;
        let duration_ms = (num_samples as u64 * 1000 / sample_rate as u64) as u32;

        Ok(SynthesisResult {
            pcm,
            sample_rate,
            duration_ms,
        })
    }

    async fn run_synthesis(&mut self, voice_id: &str, text: &str) -> Result<Vec<u8>, TtsError> {
        let piper = piper_exe();
        let model = voice_model(voice_id);

        let mut cmd = Command::new(&piper);
        cmd.arg("--model")
            .arg(&model)
            .arg("--output-raw")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().context("Failed to spawn piper.exe")?;

        // Write text to stdin; EOF signals piper to synthesize and exit
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .await
                .context("Failed to write to piper stdin")?;
            // Drop stdin → EOF
        }

        // Read PCM from stdout with timeout
        let mut pcm = Vec::new();
        if let Some(mut stdout) = child.stdout.take() {
            let read_future = stdout.read_to_end(&mut pcm);
            match tokio::time::timeout(std::time::Duration::from_secs(10), read_future).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    let _ = child.kill().await;
                    return Err(TtsError::SynthesisFailed(
                        anyhow!("Piper stdout read error: {e}"),
                    ));
                }
                Err(_) => {
                    let _ = child.kill().await;
                    return Err(TtsError::SynthesisFailed(anyhow!(
                        "Piper synthesis timed out"
                    )));
                }
            }
        }

        let _ = child.wait().await;

        if pcm.is_empty() {
            return Err(TtsError::SynthesisFailed(anyhow!(
                "Piper produced no audio output"
            )));
        }

        debug!("Synthesized {} PCM bytes for voice {voice_id}", pcm.len());
        Ok(pcm)
    }

    pub fn shutdown(&mut self) {
        if let Some(mut child) = self.piper_process.take() {
            // Fire-and-forget kill; process will be reaped by OS
            let _ = child.start_kill();
        }
        self.current_voice = None;
    }
}
