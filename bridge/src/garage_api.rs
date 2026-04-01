//! LMU REST API client — reads strategy VE history for the Fuel widget.
//!
//! Endpoint: GET http://localhost:6397/rest/strategy/usage
//!
//! On non-Windows builds this always returns `None` — the API is only
//! available when LMU is running on Windows.

const STRATEGY_USAGE_URL: &str = "http://localhost:6397/rest/strategy/usage";

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

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod imp {
    use super::STRATEGY_USAGE_URL;

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
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn fetch_strategy_ve(_player_name: &str) -> Option<Vec<f64>> {
        None
    }
}
