//! Application configuration — placeholder after electronics bindings removal.
//!
//! The button-binding system was removed in LMU v1.3 because electronics values
//! are now read directly from shared memory telemetry (mTC, mABS, mMotorMap, etc.).

/// Top-level application config (currently empty; kept for future settings).
#[derive(Debug, Clone, Default)]
pub struct AppConfig;

impl AppConfig {
    pub fn load_or_create(_path: &str) -> Self {
        Self
    }
}
