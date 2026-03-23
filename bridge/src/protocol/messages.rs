use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::app_config::{ButtonBinding, ElectronicsDefaults};

/// WebSocket message protocol — MessagePack serialized
/// Task 4 will complete all message types

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

/// Diagnostic info for one HID game controller.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControllerDiag {
    pub index: u32,
    pub name: String,
    pub button_count: u32,
    pub connected: bool,
}

/// One entry in the recent input event log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputEventDiag {
    pub timestamp_ms: u64,  // ms since bridge start
    pub source: String,     // "keyboard" or "joystick:0"
    pub input: String,      // "F5" or "Button 15"
    pub action: String,     // "pressed"
    pub mapped_to: String,  // "tc_increase" (always mapped; unmapped events not tracked)
}

/// Tire snapshot for one wheel at S/F line crossing (telemetry at lap completion).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WheelSnapshot {
    pub wear: f64,                        // 0.0 (new) – 1.0 (destroyed)
    pub surface_temp: [f64; 3],           // inner/mid/outer surface temp (Celsius)
    pub carcass_temp: f64,                // carcass temperature (Celsius)
    pub inner_layer_temp: [f64; 3],       // inner layer temperatures (Celsius)
    pub pressure: f64,                    // tire pressure (kPa)
    pub flat: bool,
    pub detached: bool,
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
    pub last_sector3: f64,              // -1.0 if invalid
    pub gap_to_leader: f64,            // seconds behind leader
    pub laps_behind_leader: i32,
    pub gap_ahead: f64,                // seconds to car ahead
    pub num_pitstops: i32,
    pub in_pits: bool,
    pub finish_status: i8,             // 0=none,1=finished,2=DNF,3=DQ
    pub fuel_remaining: f64,           // litres; -1.0 if no telemetry
    pub fuel_capacity: f64,
    pub tire_compound_front: u8,
    pub tire_compound_rear: u8,
    pub wheels: [WheelSnapshot; 4],    // FL, FR, RL, RR
    pub lap_start_et: f64,
    pub speed_ms: f64,                 // speed at S/F crossing (m/s)
    pub has_telemetry: bool,           // false = scoring data only, no per-wheel data
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
    pub last_sector1: f64,      // last S1 time
    pub last_sector2: f64,      // last S1+S2 cumulative time
    pub cur_sector1: f64,       // current S1 time (if S1 already passed this lap)
    pub cur_sector2: f64,       // current S1+S2 cumulative time (if S2 already passed)
    pub best_sector1: f64,      // personal best S1
    pub best_sector2: f64,      // personal best S1+S2
    pub lap_start_et: f64,      // session ET when this lap started
    // Car identification
    pub car_number: i32,        // slot/car ID (used as car number)
    pub car_name: String,       // vehicle model name (e.g. "Porsche 963 LMDh")
    // Derived sector 3 times (calculated: lap_time - sector2_cumulative)
    pub last_sector3: f64,      // last S3 time; -1.0 if invalid
    pub best_sector3: f64,      // best S3 time; -1.0 if invalid
    // World position (from mPos — metres in rF2 world space)
    pub pos_x: f64,             // mPos.x — world X coordinate
    pub pos_z: f64,             // mPos.z — world Z coordinate (forward axis in rF2)
    // Race gap (seconds / laps behind leader)
    pub time_behind_leader: f64,  // mTimeBehindLeader (s); 0.0 for leader
    pub laps_behind_leader: i32,  // mLapsBehindLeader; 0 = on lead lap
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
        lap_start_et: f64,     // session ET when current lap started (for current lap calc)
        // Fuel strategy (computed by FuelTracker)
        fuel_avg_consumption: f64,   // L/lap rolling median; 0 = no valid data yet
        fuel_avg_sample_count: u32,  // number of fuel-consumption samples (0–10)
        fuel_laps_remaining: f64,    // estimated laps on current fuel; f64::INFINITY if no avg
        fuel_stint_number: u32,      // 1-based stint counter
        fuel_stint_laps: u32,        // laps completed in current stint (including outlap)
        fuel_stint_consumption: f64, // total fuel used since stint start
        fuel_recommended: f64,       // kept for protocol compat; always 0.0
        fuel_pit_detected: bool,     // true for ~3s after pit stop detected
        fuel_avg_lap_time: f64,      // rolling median lap time (s); 0 = no valid data yet
        // Virtual Energy history from REST API (strategy/usage) — None if unavailable
        // Each entry is one lap's VE fraction (0.0–1.0). Last entry = current VE level.
        ve_history: Option<Vec<f64>>,
        // Whether this car supports VE (from VM_VIRTUAL_ENERGY.available in garage API).
        // None = garage data not yet fetched.
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

    /// Low frequency: ~5Hz — electronics / driver aids (button counting)
    ///
    /// Values are tracked by counting steering-wheel button presses since
    /// session start (or last reset). `buttons_configured` is false when
    /// all bindings in config.json are null — the frontend shows a setup hint.
    ElectronicsUpdate {
        // Button-counted values (from ElectronicsTracker)
        tc:                  i32,   // traction control level
        tc_cut:              i32,   // TC cut level
        tc_slip:             i32,   // TC slip threshold
        abs:                 i32,   // ABS level
        engine_map:          i32,   // engine/motor map number
        front_arb:           i32,   // front anti-roll bar
        rear_arb:            i32,   // rear anti-roll bar
        brake_bias:          f64,   // button-counted brake bias (%) e.g. 56.0
        regen:               i32,   // regen level
        brake_migration:     i32,   // brake migration step
        brake_migration_max: i32,   // max step (from range config)
        // From telemetry (raw sensor, not button counted)
        brake_bias_front:    f64,   // front brake bias (0.0–1.0) from mRearBrakeBias
        // From LMU extended buffer (hybrid cars only)
        battery_pct:         f64,   // battery charge (0.0–1.0); 0 if not hybrid
        energy_pct:          f64,   // energy store   (0.0–1.0); 0 if not hybrid
        // Config status
        buttons_configured:  bool,  // true if at least one binding is set in config.json
        // In-game display labels from garage API (e.g. "front_arb" → "P4", "engine_map" → "40kW").
        // Empty map when no garage fetch has succeeded yet.
        garage_labels:       HashMap<String, String>,
    },

    /// Vehicle status: damage + race flags — ~5Hz
    VehicleStatusUpdate {
        // --- Damage (player vehicle, from telemetry buffer) ---
        overheating:           bool,       // engine overheating indicator
        any_detached:          bool,       // any body part detached
        dent_severity:         [u8; 8],    // 8 body locations: 0=none, 1=dented, 2=very dented
        last_impact_magnitude: f64,        // magnitude of last collision
        last_impact_et:        f64,        // session time of last collision
        tire_flat:             [bool; 4],  // FL, FR, RL, RR — flat tyre
        tire_detached:         [bool; 4],  // FL, FR, RL, RR — detached tyre
        // --- Race flags (from scoring + rules buffers) ---
        yellow_flag_state:    i32,         // rF2 enum: -1=no scoring, 0=none, 1=pending, 2=pits closed, 3=pit lead lap, 4=pits open, 5=last lap, 6=resume, 7=race halt
        sector_flags:         [i32; 3],    // local yellow per sector (S1, S2, S3): 0=clear, >0=yellow
        start_light:          u8,          // 0=off, 1-5=red lights, 6=green
        game_phase:           u8,          // 0=garage, 5=green, 6=full-caution, 7=stopped, 8=over
        player_flag:          u8,          // flag shown to player: 0=green,1=blue,2=yellow,3=white,4=checkered,5=red,6=black
        player_under_yellow:  bool,        // mUnderYellow for player vehicle
        player_sector:        i32,         // player's current sector: 1=S1, 2=S2, 0=S3, -1=unknown
        safety_car_active:    bool,        // safety car currently deployed
        safety_car_exists:    bool,        // safety car configured for this session
    },

    /// Event-based
    ConnectionStatus {
        game_connected: bool,
        plugin_version: String,
    },

    /// Sent to a client on connect + after any config change.
    ConfigState {
        bindings: HashMap<String, Option<ButtonBinding>>,
        defaults: ElectronicsDefaults,
    },

    /// Sent when a button press was captured during binding capture mode.
    BindingCaptured {
        binding_id: String,
        binding: ButtonBinding,
    },

    /// Sent when binding capture timed out (10 s) without a button press.
    BindingTimeout {
        binding_id: String,
    },

    /// Sent after a SaveConfig command completes.
    ConfigSaved {
        success: bool,
    },

    /// All-drivers lap snapshot — sent when any car crosses the S/F line,
    /// and once immediately on client connect as initial state.
    /// Contains the latest snapshot per driver (updated at each S/F crossing).
    AllDriversUpdate {
        session_type: String,
        session_time: f64,
        drivers: Vec<DriverLapSnapshot>,
    },

    /// Input diagnostics — sent every 500 ms and on client connect.
    InputDiagnostics {
        controllers: Vec<ControllerDiag>,
        recent_events: Vec<InputEventDiag>,
        capture_mode: bool,
    },
}

// ---------------------------------------------------------------------------
// Client → Bridge commands (JSON text frames)
// ---------------------------------------------------------------------------

/// Commands sent from the browser dashboard to the bridge over WebSocket text frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum ClientCommand {
    /// Start listening for the next button press and bind it to `binding_id`.
    StartBindingCapture { binding_id: String },
    /// Abort the current binding capture without changing anything.
    CancelBindingCapture,
    /// Remove the binding for `binding_id`.
    ClearBinding { binding_id: String },
    /// Update electronics default values (applied on next session reset).
    UpdateDefaults { defaults: ElectronicsDefaults },
    /// Write current config (bindings + defaults) to disk.
    SaveConfig,
}
