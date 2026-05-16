//! LMU REST API client — reads strategy VE history and wearables damage.
//!
//! Endpoints:
//!   GET http://localhost:6397/rest/strategy/usage
//!   GET http://localhost:6397/rest/garage/UIScreen/RepairAndRefuel
//!
//! On non-Windows builds these always return `None` — the API is only
//! available when LMU is running on Windows.

const STRATEGY_USAGE_URL: &str = "http://localhost:6397/rest/strategy/usage";
const REPAIR_AND_REFUEL_URL: &str = "http://localhost:6397/rest/garage/UIScreen/RepairAndRefuel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Wearables snapshot from `/rest/garage/UIScreen/RepairAndRefuel`.
/// All values are fractions 0.0 (no damage/wear) to 1.0 (destroyed).
/// -1.0 means the field was absent or the API is unavailable.
#[derive(Debug, Clone, Copy)]
pub struct WearablesSnapshot {
    /// Aerodynamic body damage (0.0–1.0).
    pub aero_damage: f64,
    /// Brake wear per wheel: [FL, FR, RL, RR] (0.0–1.0).
    pub brake_wear: [f64; 4],
    /// Suspension damage per wheel: [FL, FR, RL, RR] (0.0–1.0).
    pub suspension_damage: [f64; 4],
}

impl Default for WearablesSnapshot {
    fn default() -> Self {
        Self { aero_damage: -1.0, brake_wear: [-1.0; 4], suspension_damage: [-1.0; 4] }
    }
}

// ---------------------------------------------------------------------------
// Public API
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

/// Fetch wearables damage from RepairAndRefuel endpoint (blocking, 2 s timeout).
pub fn fetch_wearables() -> Option<WearablesSnapshot> {
    imp::fetch_wearables()
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::{STRATEGY_USAGE_URL, REPAIR_AND_REFUEL_URL, WearablesSnapshot};

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

        tracing::debug!(
            "Strategy API: {} VE entries for '{}', last={:.3}",
            history.len(), player_name, history.last().unwrap()
        );
        Some(history)
    }

    pub fn fetch_wearables() -> Option<WearablesSnapshot> {
        let response = ureq::get(REPAIR_AND_REFUEL_URL)
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .map_err(|e| tracing::debug!("RepairAndRefuel API unavailable: {}", e))
            .ok()?;

        let json: serde_json::Value = response
            .into_json()
            .map_err(|e| tracing::warn!("RepairAndRefuel API JSON parse error: {}", e))
            .ok()?;

        let w = json.get("wearables")?;

        let aero_damage = w
            .get("body").and_then(|b| b.get("aero")).and_then(|v| v.as_f64())
            .unwrap_or(-1.0);

        let brake_wear = parse_wheel_array(w.get("brakes"));
        let suspension_damage = parse_wheel_array(w.get("suspension"));

        tracing::debug!(
            "Wearables: aero={:.3} brakes={:?} susp={:?}",
            aero_damage, brake_wear, suspension_damage
        );

        Some(WearablesSnapshot { aero_damage, brake_wear, suspension_damage })
    }

    fn parse_wheel_array(val: Option<&serde_json::Value>) -> [f64; 4] {
        val.and_then(|v| v.as_array())
            .and_then(|arr| {
                if arr.len() >= 4 {
                    Some([
                        arr[0].as_f64().unwrap_or(-1.0),
                        arr[1].as_f64().unwrap_or(-1.0),
                        arr[2].as_f64().unwrap_or(-1.0),
                        arr[3].as_f64().unwrap_or(-1.0),
                    ])
                } else {
                    None
                }
            })
            .unwrap_or([-1.0; 4])
    }
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::WearablesSnapshot;

    pub fn fetch_strategy_ve(_player_name: &str) -> Option<Vec<f64>> {
        None
    }

    pub fn fetch_wearables() -> Option<WearablesSnapshot> {
        None
    }
}
