//! JSON configuration file — electronics button bindings and default values.
//!
//! On first run, if no config.json exists next to the executable, a default
//! config with all bindings set to null is written so the user can fill it in.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Button binding types
// ---------------------------------------------------------------------------

/// A single input binding — either a keyboard key or a joystick button.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ButtonBinding {
    Keyboard { key: String },
    Joystick { device_index: u32, button: u32 },
}

/// All electronics bindings. Each field maps one direction of one control
/// to a single input. `null` in JSON → `None` → that direction is not tracked.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ElectronicsBindings {
    pub tc_increase:              Option<ButtonBinding>,
    pub tc_decrease:              Option<ButtonBinding>,
    pub tc_cut_increase:          Option<ButtonBinding>,
    pub tc_cut_decrease:          Option<ButtonBinding>,
    pub tc_slip_increase:         Option<ButtonBinding>,
    pub tc_slip_decrease:         Option<ButtonBinding>,
    pub abs_increase:             Option<ButtonBinding>,
    pub abs_decrease:             Option<ButtonBinding>,
    pub engine_map_increase:      Option<ButtonBinding>,
    pub engine_map_decrease:      Option<ButtonBinding>,
    pub farb_increase:            Option<ButtonBinding>,
    pub farb_decrease:            Option<ButtonBinding>,
    pub rarb_increase:            Option<ButtonBinding>,
    pub rarb_decrease:            Option<ButtonBinding>,
    pub brake_bias_increase:      Option<ButtonBinding>,
    pub brake_bias_decrease:      Option<ButtonBinding>,
    pub regen_increase:           Option<ButtonBinding>,
    pub regen_decrease:           Option<ButtonBinding>,
    pub brake_migration_increase: Option<ButtonBinding>,
    pub brake_migration_decrease: Option<ButtonBinding>,
}

impl ElectronicsBindings {
    /// Set a single binding by its string ID (matches config field name).
    pub fn set_binding(&mut self, id: &str, binding: Option<ButtonBinding>) {
        match id {
            "tc_increase"              => self.tc_increase              = binding,
            "tc_decrease"              => self.tc_decrease              = binding,
            "tc_cut_increase"          => self.tc_cut_increase          = binding,
            "tc_cut_decrease"          => self.tc_cut_decrease          = binding,
            "tc_slip_increase"         => self.tc_slip_increase         = binding,
            "tc_slip_decrease"         => self.tc_slip_decrease         = binding,
            "abs_increase"             => self.abs_increase             = binding,
            "abs_decrease"             => self.abs_decrease             = binding,
            "engine_map_increase"      => self.engine_map_increase      = binding,
            "engine_map_decrease"      => self.engine_map_decrease      = binding,
            "farb_increase"            => self.farb_increase            = binding,
            "farb_decrease"            => self.farb_decrease            = binding,
            "rarb_increase"            => self.rarb_increase            = binding,
            "rarb_decrease"            => self.rarb_decrease            = binding,
            "brake_bias_increase"      => self.brake_bias_increase      = binding,
            "brake_bias_decrease"      => self.brake_bias_decrease      = binding,
            "regen_increase"           => self.regen_increase           = binding,
            "regen_decrease"           => self.regen_decrease           = binding,
            "brake_migration_increase" => self.brake_migration_increase = binding,
            "brake_migration_decrease" => self.brake_migration_decrease = binding,
            _ => {}
        }
    }

    /// Convert to a HashMap keyed by binding ID string (for ConfigState messages).
    pub fn to_map(&self) -> std::collections::HashMap<String, Option<ButtonBinding>> {
        let mut map = std::collections::HashMap::new();
        macro_rules! ins {
            ($name:literal, $field:expr) => {
                map.insert($name.to_string(), $field.clone());
            };
        }
        ins!("tc_increase",              self.tc_increase);
        ins!("tc_decrease",              self.tc_decrease);
        ins!("tc_cut_increase",          self.tc_cut_increase);
        ins!("tc_cut_decrease",          self.tc_cut_decrease);
        ins!("tc_slip_increase",         self.tc_slip_increase);
        ins!("tc_slip_decrease",         self.tc_slip_decrease);
        ins!("abs_increase",             self.abs_increase);
        ins!("abs_decrease",             self.abs_decrease);
        ins!("engine_map_increase",      self.engine_map_increase);
        ins!("engine_map_decrease",      self.engine_map_decrease);
        ins!("farb_increase",            self.farb_increase);
        ins!("farb_decrease",            self.farb_decrease);
        ins!("rarb_increase",            self.rarb_increase);
        ins!("rarb_decrease",            self.rarb_decrease);
        ins!("brake_bias_increase",      self.brake_bias_increase);
        ins!("brake_bias_decrease",      self.brake_bias_decrease);
        ins!("regen_increase",           self.regen_increase);
        ins!("regen_decrease",           self.regen_decrease);
        ins!("brake_migration_increase", self.brake_migration_increase);
        ins!("brake_migration_decrease", self.brake_migration_decrease);
        map
    }

    /// Returns `true` if at least one binding is configured.
    pub fn any_configured(&self) -> bool {
        [
            &self.tc_increase,
            &self.tc_decrease,
            &self.tc_cut_increase,
            &self.tc_cut_decrease,
            &self.tc_slip_increase,
            &self.tc_slip_decrease,
            &self.abs_increase,
            &self.abs_decrease,
            &self.engine_map_increase,
            &self.engine_map_decrease,
            &self.farb_increase,
            &self.farb_decrease,
            &self.rarb_increase,
            &self.rarb_decrease,
            &self.brake_bias_increase,
            &self.brake_bias_decrease,
            &self.regen_increase,
            &self.regen_decrease,
            &self.brake_migration_increase,
            &self.brake_migration_decrease,
        ]
        .iter()
        .any(|b| b.is_some())
    }
}

// ---------------------------------------------------------------------------
// Default electronics values (used when no garage file is found)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElectronicsDefaults {
    pub tc:              i32,
    pub tc_cut:          i32,
    pub tc_slip:         i32,
    pub abs:             i32,
    pub engine_map:      i32,
    pub front_arb:       i32,
    pub rear_arb:        i32,
    pub brake_bias:      f64, // as percentage, e.g. 56.0
    pub regen:           i32,
    pub brake_migration: i32,
}

impl Default for ElectronicsDefaults {
    fn default() -> Self {
        Self {
            tc:              5,
            tc_cut:          5,
            tc_slip:         3,
            abs:             3,
            engine_map:      3,
            front_arb:       3,
            rear_arb:        3,
            brake_bias:      56.0,
            regen:           0,
            brake_migration: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub electronics_bindings: ElectronicsBindings,
    pub electronics_defaults: ElectronicsDefaults,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            electronics_bindings: ElectronicsBindings::default(),
            electronics_defaults: ElectronicsDefaults::default(),
        }
    }
}

impl AppConfig {
    /// Write current config to `path`. Returns `true` on success.
    pub fn save(&self, path: &str) -> bool {
        match serde_json::to_string_pretty(self) {
            Ok(s) => match std::fs::write(path, &s) {
                Ok(()) => {
                    tracing::info!("Config saved to {}", path);
                    true
                }
                Err(e) => {
                    tracing::warn!("Failed to save config to {}: {}", path, e);
                    false
                }
            },
            Err(e) => {
                tracing::warn!("Failed to serialize config: {}", e);
                false
            }
        }
    }

    /// Load config from `path`. If the file does not exist, writes a default
    /// config there and returns it. Parse errors fall back to defaults.
    pub fn load_or_create(path: &str) -> Self {
        let p = std::path::Path::new(path);
        if p.exists() {
            match std::fs::read_to_string(p) {
                Ok(s) => match serde_json::from_str::<AppConfig>(&s) {
                    Ok(cfg) => {
                        tracing::info!("Loaded config from {}", path);
                        return cfg;
                    }
                    Err(e) => tracing::warn!("Failed to parse {}: {} — using defaults", path, e),
                },
                Err(e) => tracing::warn!("Failed to read {}: {} — using defaults", path, e),
            }
        } else {
            let default = AppConfig::default();
            match serde_json::to_string_pretty(&default) {
                Ok(s) => match std::fs::write(p, s) {
                    Ok(()) => tracing::info!("Created default config at {}", path),
                    Err(e) => tracing::warn!("Could not write default config: {}", e),
                },
                Err(e) => tracing::warn!("Could not serialize default config: {}", e),
            }
            return default;
        }
        AppConfig::default()
    }
}
