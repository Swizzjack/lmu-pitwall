//! LMU REST API client — reads garage setup values for electronics initialization.
//!
//! Endpoint: GET http://localhost:6397/rest/garage/getPlayerGarageData
//!
//! Each control value in the response carries its current `value`, `minValue`,
//! `maxValue` and `stringValue` (the display label shown in-game). When
//! `available == false` or `stringValue` is "N/A"/"N/V" the control is not
//! supported by the current car and the field is skipped.
//!
//! On non-Windows builds this always returns `None` — the API is only
//! available when LMU is running on Windows.

const GARAGE_URL: &str        = "http://localhost:6397/rest/garage/getPlayerGarageData";
const GAME_STATE_URL: &str    = "http://localhost:6397/rest/sessions/GetGameState";
const STRATEGY_USAGE_URL: &str = "http://localhost:6397/rest/strategy/usage";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single garage control value with its valid range and in-game display string.
#[derive(Debug, Clone)]
pub struct GarageValue {
    /// Current numeric level (e.g. 8 for TC level 8).
    pub value:        i32,
    /// Minimum valid level for this car.
    pub min_value:    i32,
    /// Maximum valid level for this car.
    pub max_value:    i32,
    /// In-game display label (e.g. "P4", "40kW", "8").
    pub string_value: String,
    /// `false` if the control is unavailable for the current car (N/A, N/V).
    pub available:    bool,
}

impl Default for GarageValue {
    fn default() -> Self {
        Self {
            value:        0,
            min_value:    0,
            max_value:    0,
            string_value: String::new(),
            available:    false,
        }
    }
}

/// Snapshot of relevant fields from the LMU GetGameState endpoint.
#[derive(Debug, Clone, Default)]
pub struct GameState {
    /// Current multi-stint state string from the API (e.g. "DRIVING", "MONITOR_MENU").
    pub multi_stint_state: String,
}

/// All electronics garage values fetched from the LMU REST API.
#[derive(Debug, Clone, Default)]
pub struct GarageData {
    pub tc:              GarageValue,
    pub tc_cut:          GarageValue,
    pub tc_slip:         GarageValue,
    pub abs:             GarageValue,
    pub engine_map:      GarageValue,
    pub front_arb:       GarageValue,
    pub rear_arb:        GarageValue,
    /// Brake bias — `string_value` is "52.3:47.7"; `value` is parsed front %.
    pub brake_bias:      GarageValue,
    pub regen:           GarageValue,
    pub brake_migration: GarageValue,
    /// Whether this car uses Virtual Energy (from VM_VIRTUAL_ENERGY.available).
    /// `None` if the field was absent in the API response.
    pub ve_available:    Option<bool>,
}

// ---------------------------------------------------------------------------
// Public API (delegates to platform impl)
// ---------------------------------------------------------------------------

/// Fetch the full VE (virtual energy) history for the given player from
/// `strategy/usage` (blocking, 2 s timeout).
///
/// Returns the per-lap VE values as a `Vec<f64>` (0.0–1.0 each).
/// Returns `None` if LMU is not running, the API is unreachable, the
/// player name is not found, or the history is empty.
pub fn fetch_strategy_ve(player_name: &str) -> Option<Vec<f64>> {
    imp::fetch_strategy_ve(player_name)
}

/// Fetch garage data from the LMU REST API (blocking, 2 s timeout).
///
/// Call from a dedicated blocking thread (e.g. `tokio::task::spawn_blocking`).
/// Returns `None` if LMU is not running, the API is unreachable, or JSON
/// parsing fails.
pub fn fetch_garage_data() -> Option<GarageData> {
    imp::fetch()
}

/// Fetch the current game state from the LMU REST API (blocking, 2 s timeout).
///
/// Returns `None` if LMU is not running or the API is unreachable.
pub fn fetch_game_state() -> Option<GameState> {
    imp::fetch_game_state()
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::{GameState, GarageData, GarageValue, GAME_STATE_URL, GARAGE_URL, STRATEGY_USAGE_URL};

    pub fn fetch_strategy_ve(player_name: &str) -> Option<Vec<f64>> {
        let response = ureq::get(STRATEGY_USAGE_URL)
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .map_err(|e| tracing::debug!("Strategy API unavailable: {}", e))
            .ok()?;

        let json: serde_json::Value = response
            .into_json()
            .map_err(|e| tracing::warn!("Strategy API JSON parse error: {}", e))
            .ok()?;

        // Response: { "DriverName": [{ "ve": 1.0, ... }, ...] }
        let entries = json.get(player_name)?.as_array()?;
        let history: Vec<f64> = entries.iter()
            .filter_map(|e| e.get("ve")?.as_f64())
            .collect();

        if history.is_empty() {
            return None;
        }

        tracing::debug!("Strategy API: {} VE entries for '{}', last={:.3}", history.len(), player_name, history.last().unwrap());
        Some(history)
    }

    pub fn fetch_game_state() -> Option<GameState> {
        let response = ureq::get(GAME_STATE_URL)
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .map_err(|e| tracing::warn!("GetGameState API unavailable: {}", e))
            .ok()?;

        let json: serde_json::Value = response
            .into_json()
            .map_err(|e| tracing::warn!("GetGameState JSON parse error: {}", e))
            .ok()?;

        let multi_stint_state = json.get("MultiStintState")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        Some(GameState { multi_stint_state })
    }

    pub fn fetch() -> Option<GarageData> {
        let response = ureq::get(GARAGE_URL)
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .map_err(|e| tracing::warn!("Garage API unavailable: {}", e))
            .ok()?;

        let json: serde_json::Value = response
            .into_json()
            .map_err(|e| tracing::warn!("Garage API JSON parse error: {}", e))
            .ok()?;

        tracing::info!("Garage API: data received");

        let mut data = GarageData::default();
        data.tc              = extract_int(&json, "VM_TRACTIONCONTROLMAP",        (0, 12));
        data.tc_cut          = extract_int(&json, "VM_TRACTIONCONTROLPOWERCUTMAP", (0, 12));
        data.tc_slip         = extract_int(&json, "VM_TRACTIONCONTROLSLIPANGLEMAP",(0, 12));
        data.abs             = extract_int(&json, "VM_ANTILOCKBRAKESYSTEMMAP",     (0, 12));
        data.engine_map      = extract_int(&json, "VM_ELECTRIC_MOTOR_MAP",         (1,  6));
        data.front_arb       = extract_int(&json, "VM_FRONT_ANTISWAY",             (1,  6));
        data.rear_arb        = extract_int(&json, "VM_REAR_ANTISWAY",              (1,  6));
        data.brake_bias      = extract_brake_bias(&json);
        data.regen           = extract_int(&json, "VM_REGEN_LEVEL",                (0, 11));
        data.brake_migration = extract_int(&json, "VM_BRAKE_MIGRATION",            (0,  6));
        data.ve_available    = json.get("VM_VIRTUAL_ENERGY")
            .and_then(|v| v.get("available"))
            .and_then(|v| v.as_bool());

        tracing::debug!("Garage API: VM_VIRTUAL_ENERGY.available = {:?}", data.ve_available);
        Some(data)
    }

    /// Returns true when the string value indicates this control is unsupported.
    fn is_na(s: &str) -> bool {
        s == "N/A" || s == "N/V"
    }

    /// Extract an integer control. `fallback_range` is used if min/max are absent.
    fn extract_int(
        json:           &serde_json::Value,
        key:            &str,
        fallback_range: (i32, i32),
    ) -> GarageValue {
        let entry = match json.get(key) {
            Some(v) => v,
            None    => return GarageValue::default(),
        };
        let string_val = entry.get("stringValue")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let available = entry.get("available").and_then(|v| v.as_bool()).unwrap_or(false)
            && !is_na(&string_val);

        GarageValue {
            value:        entry.get("value")   .and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            min_value:    entry.get("minValue").and_then(|v| v.as_i64())
                              .map(|n| n as i32).unwrap_or(fallback_range.0),
            max_value:    entry.get("maxValue").and_then(|v| v.as_i64())
                              .map(|n| n as i32).unwrap_or(fallback_range.1),
            string_value: string_val,
            available,
        }
    }

    /// Extract brake balance. The API stringValue is "52.3:47.7" (front:rear).
    fn extract_brake_bias(json: &serde_json::Value) -> GarageValue {
        let entry = match json.get("VM_BRAKE_BALANCE") {
            Some(v) => v,
            None    => return GarageValue::default(),
        };
        let string_val = entry.get("stringValue")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let available = entry.get("available").and_then(|v| v.as_bool()).unwrap_or(false)
            && !is_na(&string_val);

        // Parse front percentage from "52.3:47.7" → store as integer (×10 if needed,
        // but ElectronicsTracker.apply_garage_data re-parses from string_value).
        let front_i32 = parse_bb_front(&string_val).unwrap_or(56);

        GarageValue {
            value:        front_i32,
            min_value:    45,   // wider than the 50–65 default so clamp works
            max_value:    65,
            string_value: string_val,
            available,
        }
    }

    /// "52.3:47.7" → 52 (integer front %)
    fn parse_bb_front(s: &str) -> Option<i32> {
        let front_str = s.split(':').next()?;
        let front_f: f64 = front_str.trim().parse().ok()?;
        Some(front_f.round() as i32)
    }
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{GameState, GarageData};

    pub fn fetch_strategy_ve(_player_name: &str) -> Option<Vec<f64>> {
        None
    }

    pub fn fetch_game_state() -> Option<GameState> {
        None
    }

    pub fn fetch() -> Option<GarageData> {
        None
    }
}
