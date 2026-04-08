use serde::{Deserialize, Serialize};

/// WebSocket message protocol — MessagePack serialized

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TireData {
    pub temp_inner: f64,
    pub temp_mid: f64,
    pub temp_outer: f64,
    pub carcass_temp: f64,
    pub pressure: f64,
    pub wear: f64,
    pub brake_temp: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherData {
    pub air_temp: f64,
    pub track_temp: f64,
    pub rain_intensity: f64,
}

/// Tire snapshot for one wheel at S/F line crossing (telemetry at lap completion).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WheelSnapshot {
    pub wear: f64,                  // 0.0 (new) – 1.0 (destroyed)
    pub surface_temp: [f64; 3],     // inner/mid/outer surface temp (Celsius)
    pub carcass_temp: f64,          // carcass temperature (Celsius)
    pub inner_layer_temp: [f64; 3], // inner layer temperatures (Celsius)
    pub pressure: f64,              // tire pressure (kPa)
    pub flat: bool,
    pub detached: bool,
    pub compound_index: u8, // per-wheel compound index (mCompoundIndex)
}

/// Snapshot of one driver's state at S/F line crossing (lap completion).
/// Also sent for all drivers on client connect as initial state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverLapSnapshot {
    pub id: i32,
    pub driver_name: String,
    pub vehicle_name: String,
    pub class_name: String,
    pub position: i32,
    pub total_laps: i32,
    pub last_lap_time: f64,
    pub best_lap_time: f64,
    pub last_sector1: f64,
    pub last_sector2: f64,
    pub last_sector3: f64,  // -1.0 if invalid
    pub gap_to_leader: f64, // seconds behind leader
    pub laps_behind_leader: i32,
    pub gap_ahead: f64, // seconds to car ahead
    pub num_pitstops: i32,
    pub in_pits: bool,
    pub finish_status: i8,   // 0=none,1=finished,2=DNF,3=DQ
    pub fuel_remaining: f64, // litres; -1.0 if no telemetry
    pub fuel_capacity: f64,
    pub tire_compound_front: u8,
    pub tire_compound_rear: u8,
    pub tire_compound_front_name: String,
    pub tire_compound_rear_name: String,
    pub wheels: [WheelSnapshot; 4], // FL, FR, RL, RR
    pub lap_start_et: f64,
    pub speed_ms: f64,       // speed at S/F crossing (m/s)
    pub has_telemetry: bool, // false = scoring data only, no per-wheel data
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VehicleScoring {
    pub id: i32,
    pub driver_name: String,
    pub team_name: String,
    pub vehicle_class: String,
    pub position: i32,
    pub lap_dist: f64,
    pub total_laps: i32,
    pub best_lap_time: f64,
    pub last_lap_time: f64,
    pub in_pits: bool,
    // Sector times (seconds; -1.0 = invalid/not yet completed)
    pub last_sector1: f64, // last S1 time
    pub last_sector2: f64, // last S1+S2 cumulative time
    pub cur_sector1: f64,  // current S1 time (if S1 already passed this lap)
    pub cur_sector2: f64,  // current S1+S2 cumulative time (if S2 already passed)
    pub best_sector1: f64, // personal best S1
    pub best_sector2: f64, // personal best S1+S2
    pub lap_start_et: f64, // session ET when this lap started
    // Car identification
    pub car_number: i32,  // slot/car ID (used as car number)
    pub car_name: String, // vehicle model name (e.g. "Porsche 963 LMDh")
    // Derived sector 3 times (calculated: lap_time - sector2_cumulative)
    pub last_sector3: f64, // last S3 time; -1.0 if invalid
    pub best_sector3: f64, // best S3 time; -1.0 if invalid
    // World position (from mPos — metres in rF2 world space)
    pub pos_x: f64, // mPos.x — world X coordinate
    pub pos_z: f64, // mPos.z — world Z coordinate (forward axis in rF2)
    // Race gap (seconds / laps behind leader)
    pub time_behind_leader: f64, // mTimeBehindLeader (s); 0.0 for leader
    pub laps_behind_leader: i32, // mLapsBehindLeader; 0 = on lead lap
    // Virtual Energy (0.0 = no VE / not a hybrid; >0 = fraction 0.0–1.0)
    pub virtual_energy: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    /// High frequency: ~30Hz
    TelemetryUpdate {
        speed_ms: f64,
        rpm: f64,
        max_rpm: f64,
        gear: i32,
        throttle: f64,
        brake: f64,
        clutch: f64,
        steering: f64,
        fuel: f64,
        fuel_capacity: f64,
        water_temp: f64,
        oil_temp: f64,
        tires: [TireData; 4],
        position: Vec3,
        velocity: Vec3,
        local_accel: Vec3,
        delta_best: f64,
        current_et: f64,
        lap_start_et: f64, // session ET when current lap started (for current lap calc)
        // Fuel strategy (computed by FuelTracker)
        fuel_avg_consumption: f64, // L/lap rolling median; 0 = no valid data yet
        fuel_avg_sample_count: u32, // number of fuel-consumption samples (0–10)
        fuel_laps_remaining: f64,  // estimated laps on current fuel; f64::INFINITY if no avg
        fuel_stint_number: u32,    // 1-based stint counter
        fuel_stint_laps: u32,      // laps completed in current stint (including outlap)
        fuel_stint_consumption: f64, // total fuel used since stint start
        fuel_recommended: f64,     // kept for protocol compat; always 0.0
        fuel_pit_detected: bool,   // true for ~3s after pit stop detected
        fuel_avg_lap_time: f64,    // rolling median lap time (s); 0 = no valid data yet
        // Virtual Energy history from REST API (strategy/usage) — None if unavailable
        // Each entry is one lap's VE fraction (0.0–1.0). Last entry = current VE level.
        ve_history: Option<Vec<f64>>,
        // Whether this car supports VE.
        // None = not yet determined.
        ve_available: Option<bool>,
    },

    /// Medium frequency: ~5Hz
    ScoringUpdate {
        session_type: String,
        session_time: f64,
        num_vehicles: i32,
        vehicles: Vec<VehicleScoring>,
        player_vehicle_id: i32,
    },

    /// Low frequency: ~1Hz
    SessionInfo {
        track_name: String,
        track_length: f64,
        weather: WeatherData,
        session_laps: i32,
        session_minutes: f64,
    },

    /// Low frequency: ~5Hz — electronics / driver aids (native telemetry)
    ElectronicsUpdate {
        tc: u8,
        tc_max: u8,
        tc_cut: u8,
        tc_cut_max: u8,
        tc_slip: u8,
        tc_slip_max: u8,
        abs: u8,
        abs_max: u8,
        engine_map: u8,
        engine_map_max: u8,
        front_arb: u8,
        front_arb_max: u8,
        rear_arb: u8,
        rear_arb_max: u8,
        brake_bias: f64, // front bias percent
        regen: f32,      // kW
        brake_migration: u8,
        brake_migration_max: u8,
        battery_pct: f64,    // 0.0–1.0
        soc: f32,            // state of charge
        virtual_energy: f32, // virtual energy
        tc_active: bool,     // TC intervening right now
        abs_active: bool,    // ABS intervening right now
    },

    /// Vehicle status: damage + race flags — ~5Hz
    VehicleStatusUpdate {
        // --- Damage (player vehicle, from telemetry buffer) ---
        overheating: bool,          // engine overheating indicator
        any_detached: bool,         // any body part detached
        dent_severity: [u8; 8],     // 8 body locations: 0=none, 1=dented, 2=very dented
        last_impact_magnitude: f64, // magnitude of last collision
        last_impact_et: f64,        // session time of last collision
        tire_flat: [bool; 4],       // FL, FR, RL, RR — flat tyre
        tire_detached: [bool; 4],   // FL, FR, RL, RR — detached tyre
        // --- Race flags (from scoring + rules buffers) ---
        yellow_flag_state: i32, // rF2 enum: -1=no scoring, 0=none, 1=pending, 2=pits closed, 3=pit lead lap, 4=pits open, 5=last lap, 6=resume, 7=race halt
        sector_flags: [i32; 3], // local yellow per sector (S1, S2, S3): 0=clear, >0=yellow
        start_light: u8,        // 0=off, 1-5=red lights, 6=green
        game_phase: u8,         // 0=garage, 5=green, 6=full-caution, 7=stopped, 8=over
        player_flag: u8,        // mFlag for player: SDK only uses 0=no flag (green), 6=blue
        individual_phase: u8,   // mIndividualPhase: 10=under yellow, 11=under blue (unused)
        player_under_yellow: bool, // mUnderYellow for player vehicle (FCY only)
        player_sector: i32,     // player's current sector: 1=S1, 2=S2, 0=S3, -1=unknown
        safety_car_active: bool, // safety car currently deployed
        safety_car_exists: bool, // safety car configured for this session
    },

    /// Event-based
    ConnectionStatus {
        game_connected: bool,
        plugin_version: String,
    },

    /// All-drivers lap snapshot — sent when any car crosses the S/F line,
    /// and once immediately on client connect as initial state.
    /// Contains the latest snapshot per driver (updated at each S/F crossing).
    AllDriversUpdate {
        session_type: String,
        session_time: f64,
        drivers: Vec<DriverLapSnapshot>,
    },

    // -----------------------------------------------------------------------
    // Post-race results responses
    // -----------------------------------------------------------------------
    /// Response to `PostRaceInit` — full session list + import stats.
    PostRaceSessions {
        sessions: Vec<PostRaceSessionMeta>,
        total_sessions: usize,
        new_imported: usize,
        files_found: usize,
        import_errors: usize,
    },

    /// Response to `PostRaceSessionDetail` — driver summaries (no per-lap data).
    PostRaceSessionDetail {
        session_id: i64,
        drivers: Vec<PostRaceDriverSummary>,
    },

    /// Response to `PostRaceDriverLaps` — every lap for one driver.
    PostRaceDriverLaps {
        driver_id: i64,
        laps: Vec<PostRaceLapData>,
    },

    /// Response to `PostRaceCompare` — per-lap comparison across multiple drivers.
    PostRaceCompare {
        reference_driver_id: i64,
        laps: Vec<PostRaceComparedLap>,
    },

    /// Response to `PostRaceStintSummary` — aggregated stint data for one driver.
    PostRaceStintSummary {
        driver_id: i64,
        stints: Vec<PostRaceStintData>,
    },

    /// Sent when a post-race command fails (e.g. DB not yet initialized).
    PostRaceError { message: String },
}

// ---------------------------------------------------------------------------
// Post-race response payload structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRaceSessionMeta {
    pub id: i64,
    pub track_venue: Option<String>,
    pub track_course: Option<String>,
    pub track_event: Option<String>,
    pub date_time: Option<String>,
    pub session_type: String,
    pub game_version: Option<String>,
    pub race_laps: Option<u32>,
    pub driver_count: i64,
    pub total_laps: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRaceDriverSummary {
    pub id: i64,
    pub name: String,
    pub car_type: Option<String>,
    pub car_class: Option<String>,
    pub car_number: Option<u32>,
    pub team_name: Option<String>,
    pub is_player: bool,
    pub position: Option<u32>,
    pub class_position: Option<u32>,
    pub best_lap_time: Option<f64>,
    pub total_laps: Option<u32>,
    pub pitstops: Option<u32>,
    pub finish_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRaceLapData {
    pub lap_num: u32,
    pub position: Option<u32>,
    pub lap_time: Option<f64>,
    pub s1: Option<f64>,
    pub s2: Option<f64>,
    pub s3: Option<f64>,
    pub top_speed: Option<f64>,
    pub fuel_level: Option<f64>,
    pub fuel_used: Option<f64>,
    pub tw_fl: Option<f64>,
    pub tw_fr: Option<f64>,
    pub tw_rl: Option<f64>,
    pub tw_rr: Option<f64>,
    pub compound_fl: Option<String>,
    pub compound_fr: Option<String>,
    pub compound_rl: Option<String>,
    pub compound_rr: Option<String>,
    pub is_pit: bool,
    pub stint_number: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRaceDriverLapEntry {
    pub driver_id: i64,
    pub lap_time: Option<f64>,
    /// Seconds relative to the first (reference) driver in the list.
    pub delta: Option<f64>,
    pub s1: Option<f64>,
    pub s2: Option<f64>,
    pub s3: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRaceComparedLap {
    pub lap_num: u32,
    pub drivers: Vec<PostRaceDriverLapEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRaceStintData {
    pub stint_number: u32,
    pub lap_count: usize,
    pub avg_pace: Option<f64>,
    pub best_lap: Option<f64>,
    pub worst_lap: Option<f64>,
    pub fuel_start: Option<f64>,
    pub fuel_end: Option<f64>,
    pub fuel_consumed: Option<f64>,
    pub tw_fl_start: Option<f64>,
    pub tw_fr_start: Option<f64>,
    pub tw_rl_start: Option<f64>,
    pub tw_rr_start: Option<f64>,
    pub tw_fl_end: Option<f64>,
    pub tw_fr_end: Option<f64>,
    pub tw_rl_end: Option<f64>,
    pub tw_rr_end: Option<f64>,
    pub compound: Option<String>,
}

// ---------------------------------------------------------------------------
// Client → Bridge commands (JSON text frames)
// ---------------------------------------------------------------------------

/// Commands sent from the browser dashboard to the bridge over WebSocket text frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum ClientCommand {
    /// Trigger lazy DB init + delta import; respond with full session list.
    PostRaceInit,
    /// Fetch all drivers for a session (no lap detail).
    PostRaceSessionDetail { session_id: i64 },
    /// Fetch all laps for a single driver.
    PostRaceDriverLaps { driver_id: i64 },
    /// Lap-by-lap comparison for multiple drivers with deltas to the first.
    PostRaceCompare { driver_ids: Vec<i64> },
    /// Per-stint aggregated summary for a driver.
    PostRaceStintSummary { driver_id: i64 },
}
