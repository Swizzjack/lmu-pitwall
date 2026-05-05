pub mod api;
pub mod audio;
pub mod config;
pub mod paths;
pub mod piper_binary;
pub mod rules;
pub mod state;
pub mod tts_engine;
pub mod voice_manager;

use tokio::sync::Mutex;
use tracing::info;

use rules::dispatcher::{build_default_rules, EngineerBehavior, RuleDispatcher};
use state::StateAggregator;
use tts_engine::TtsEngine;

/// Shared progress event emitted during Piper/voice downloads.
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    /// "downloading" | "extracting" | "validating"
    pub stage: String,
    /// "piper" | "voice"
    pub target: String,
    pub target_id: Option<String>,
}

pub struct RaceEngineerService {
    pub engine: Mutex<TtsEngine>,
    pub dispatcher: Mutex<RuleDispatcher>,
    pub aggregator: Mutex<StateAggregator>,
}

impl RaceEngineerService {
    pub fn new() -> Self {
        let piper_ok = piper_binary::is_installed();
        let voices: Vec<_> = voice_manager::list_voices()
            .iter()
            .filter(|v| v.installed)
            .map(|v| v.voice_id.clone())
            .collect();

        info!(
            "RaceEngineerService: piper_installed={piper_ok}, voices_installed={:?}",
            voices
        );

        let rules = build_default_rules();
        info!("RuleDispatcher initialized with {} rules", rules.len());
        let behavior = EngineerBehavior::default();

        Self {
            engine: Mutex::new(TtsEngine::new()),
            dispatcher: Mutex::new(RuleDispatcher::new(rules, behavior)),
            aggregator: Mutex::new(StateAggregator::new()),
        }
    }
}
