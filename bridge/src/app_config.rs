use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub port: Option<u16>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { port: Some(9000) }
    }
}

impl AppConfig {
    fn config_path() -> PathBuf {
        let base = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| PathBuf::from(h).join(".config"))
                    .unwrap_or_else(|_| PathBuf::from("."))
            });
        base.join("LMUPitwall").join("config.json")
    }

    pub fn load_or_create() -> Self {
        let path = Self::config_path();
        if let Ok(data) = std::fs::read(&path) {
            if let Ok(cfg) = serde_json::from_slice::<AppConfig>(&data) {
                return cfg;
            }
        }
        // File missing or corrupt — write default and return it.
        let default = AppConfig::default();
        let _ = default.save();
        default
    }

    fn save(&self) -> std::io::Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(self).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })?;
        std::fs::write(&tmp, &data)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn set_port(port: u16) -> std::io::Result<()> {
        let mut cfg = Self::load_or_create();
        cfg.port = Some(port);
        cfg.save()
    }
}
