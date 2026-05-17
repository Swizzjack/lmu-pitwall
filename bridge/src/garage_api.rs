//! LMU REST API client — reads strategy VE history, wearables damage, and weather forecast.
//!
//! Endpoints:
//!   GET http://localhost:6397/rest/strategy/usage
//!   GET http://localhost:6397/rest/garage/UIScreen/RepairAndRefuel
//!   GET http://localhost:6397/rest/sessions/weather
//!
//! On non-Windows builds these always return `None` — the API is only
//! available when LMU is running on Windows.

const STRATEGY_USAGE_URL: &str = "http://localhost:6397/rest/strategy/usage";
const REPAIR_AND_REFUEL_URL: &str = "http://localhost:6397/rest/garage/UIScreen/RepairAndRefuel";
const WEATHER_FORECAST_URL: &str = "http://localhost:6397/rest/sessions/weather";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

pub use crate::protocol::messages::WeatherForecastNode;

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

/// Fetch weather forecast for the current session type (blocking, 2 s timeout).
/// `session` is the rF2 mSession integer (0=testday, 1-4=practice, 5-8=qual, 9=warmup, 10-13=race).
/// Returns 5 nodes covering 0%, 25%, 50%, 75%, 100% of session length.
pub fn fetch_weather_forecast(session: i32) -> Option<Vec<WeatherForecastNode>> {
    imp::fetch_weather_forecast(session)
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::{STRATEGY_USAGE_URL, REPAIR_AND_REFUEL_URL, WEATHER_FORECAST_URL, WearablesSnapshot, WeatherForecastNode};

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

    pub fn fetch_weather_forecast(session: i32) -> Option<Vec<WeatherForecastNode>> {
        let session_key = match session {
            0..=4 => "PRACTICE",
            5..=8 => "QUALIFY",
            _     => "RACE",  // 9=warmup, 10-13=race → all use RACE forecast
        };

        let response = ureq::get(WEATHER_FORECAST_URL)
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .map_err(|e| tracing::warn!("Weather forecast API unavailable: {}", e))
            .ok()?;

        let json: serde_json::Value = response
            .into_json()
            .map_err(|e| tracing::warn!("Weather forecast JSON parse error: {}", e))
            .ok()?;

        tracing::debug!("Weather forecast raw JSON: {}", json);

        // LMU REST API always uses UPPERCASE keys (confirmed against TinyPedal source).
        let session_data = match json.get(session_key) {
            Some(d) => d,
            None => {
                let available = json.as_object()
                    .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
                    .unwrap_or_else(|| "<not a JSON object>".to_string());
                tracing::warn!(
                    "Weather forecast: session key '{}' not found. Top-level keys: [{}]",
                    session_key, available
                );
                return None;
            }
        };

        // Node names are always UPPERCASE in the LMU REST API (confirmed against TinyPedal source).
        const NODE_NAMES: [&str; 5] = ["START", "NODE_25", "NODE_50", "NODE_75", "FINISH"];
        let nodes: Vec<WeatherForecastNode> = NODE_NAMES.iter()
            .filter_map(|name| {
                let node = session_data.get(*name)?;
                let sky_type    = node.get("WNV_SKY")?.get("currentValue")?.as_f64()? as i32;
                let temperature = node.get("WNV_TEMPERATURE")?.get("currentValue")?.as_f64()?;
                let rain_raw    = node.get("WNV_RAIN_CHANCE")?.get("currentValue")?.as_f64()?;
                // LMU returns rain chance as a percentage (0–100); normalise to 0.0–1.0.
                let rain_chance = (rain_raw * 0.01).clamp(0.0, 1.0);
                Some(WeatherForecastNode { sky_type, temperature, rain_chance })
            })
            .collect();

        if nodes.is_empty() {
            let available = session_data.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "<not a JSON object>".to_string());
            tracing::warn!(
                "Weather forecast: no nodes parsed for session '{}'. Node-level keys: [{}]",
                session_key, available
            );
            return None;
        }

        tracing::debug!("Weather forecast: {} nodes for session key '{}'", nodes.len(), session_key);
        Some(nodes)
    }
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{WearablesSnapshot, WeatherForecastNode};

    pub fn fetch_strategy_ve(_player_name: &str) -> Option<Vec<f64>> {
        None
    }

    pub fn fetch_wearables() -> Option<WearablesSnapshot> {
        None
    }

    pub fn fetch_weather_forecast(_session: i32) -> Option<Vec<WeatherForecastNode>> {
        None
    }
}
