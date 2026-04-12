use serde::{Deserialize, Serialize};

/// Available car/track combinations the user can choose from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuelCalcOptions {
    pub tracks: Vec<TrackOption>,
    /// All distinct game versions present in the DB, newest first.
    pub game_versions: Vec<String>,
    /// Version of the newest session — used as default filter.
    pub current_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackOption {
    pub track_venue: String,
    pub track_course: Option<String>,
    /// Track length in metres.
    pub track_length: Option<f64>,
    /// All car combinations seen on this track (player laps, race sessions only).
    pub cars: Vec<CarOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CarOption {
    pub car_class: Option<String>,
    /// `drivers.car_type` value, e.g. "Porsche 963 LMDh".
    pub car_name: Option<String>,
    pub session_count: u32,
    pub total_laps: u32,
    /// Distinct FuelMult values available for this track+car combo, ascending.
    pub fuel_mult_options: Vec<f64>,
    /// FuelMult of the most recent session for this track+car combo.
    pub default_fuel_mult: Option<f64>,
}

/// Full fuel/VE calculation result for one track + car + race distance.
///
/// All fuel and VE values are in **percent** (0–100), not raw fractions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuelCalcResult {
    pub track_venue: String,
    pub car_class: Option<String>,
    /// `drivers.car_type` value used for this calculation.
    pub car_name: String,

    // ── Data quality ────────────────────────────────────────────────────────
    pub sessions_used: u32,
    pub laps_used: u32,
    /// "low" (<10 laps), "medium" (10–50), "high" (>50).
    pub confidence: String,
    /// Human-readable description of the version filter applied.
    pub version_filter: String,
    /// `fuel_mult` from the most recent matching session.
    pub fuel_mult: f64,

    // ── Race distance ────────────────────────────────────────────────────────
    /// Average lap time in seconds (from historical data, excluding outlaps/inlaps).
    pub avg_lap_time_secs: Option<f64>,
    /// Estimated race laps — only set when `race_minutes` was provided.
    pub estimated_laps: Option<u32>,
    /// The resolved race lap count used for all calculations.
    pub race_laps: u32,
    /// Buffer laps added on top of race_laps for start fuel/VE calculation.
    pub buffer_laps: u32,

    // ── Fuel (% of tank — raw DB fraction × 100) ────────────────────────────
    pub avg_fuel_pct_per_lap: f64,
    pub fuel_std_dev_pct: f64,
    pub total_fuel_needed_pct: f64,
    /// Laps per fuel stint at avg consumption (floor(100 / avg_fuel_pct_per_lap)).
    pub fuel_stint_laps: Option<u32>,
    pub fuel_pit_stops: Option<u32>,

    // ── Virtual Energy (% — raw DB fraction × 100) ──────────────────────────
    pub has_ve: bool,
    pub avg_ve_pct_per_lap: Option<f64>,
    pub ve_std_dev_pct: Option<f64>,
    /// Laps before VE depletes (floor(100 / avg_ve_pct_per_lap)).
    pub ve_stint_laps: Option<u32>,
    pub ve_pit_stops: Option<u32>,

    // ── Combined ────────────────────────────────────────────────────────────
    /// min(fuel_stint_laps, ve_stint_laps).
    pub effective_stint_laps: Option<u32>,
    pub total_pit_stops: Option<u32>,
    /// Which resource limits stint length: "fuel" | "ve".
    pub limiting_factor: Option<String>,

    // ── Recommended start values (% — 0–100) ───────────────────────────────
    /// `(race_laps + buffer_laps) × avg_fuel_pct_per_lap`, capped at 100.
    pub recommended_start_fuel_pct: Option<f64>,
    /// `(race_laps + buffer_laps) × avg_ve_pct_per_lap`, capped at 100. None if no VE.
    pub recommended_start_ve_pct: Option<f64>,
}
