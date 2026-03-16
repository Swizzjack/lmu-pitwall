// TypeScript types matching the Rust bridge protocol (messages.rs)
// Enum is serialized with #[serde(tag = "type")] + rmp_serde::to_vec_named

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface TireData {
  temp_inner: number
  temp_mid: number
  temp_outer: number
  pressure: number
  wear: number
  brake_temp: number
}

export interface WeatherData {
  air_temp: number
  track_temp: number
  rain_intensity: number
}

export interface VehicleScoring {
  id: number
  driver_name: string
  team_name: string
  vehicle_class: string
  position: number
  lap_dist: number
  total_laps: number
  best_lap_time: number
  last_lap_time: number
  in_pits: boolean
  // Sector times (-1.0 = not yet completed / invalid)
  last_sector1: number      // last S1 time
  last_sector2: number      // last S1+S2 cumulative
  cur_sector1: number       // current lap S1 (if already passed)
  cur_sector2: number       // current lap S1+S2 (if already passed)
  best_sector1: number      // personal best S1
  best_sector2: number      // personal best S1+S2
  lap_start_et: number      // session ET when this lap started
  // Car identification
  car_number: number        // slot/car ID used as car number
  car_name: string          // vehicle model name
  // Derived sector 3 times (-1.0 = invalid)
  last_sector3: number      // last S3 = last_lap - last_sector2
  best_sector3: number      // best S3 = best_lap - best_sector2
  // World position in rF2 coordinate space (metres)
  pos_x: number             // mPos.x — world X coordinate
  pos_z: number             // mPos.z — world Z coordinate (forward axis in rF2)
  // Race gap
  time_behind_leader: number  // mTimeBehindLeader (s); 0.0 for leader
  laps_behind_leader: number  // mLapsBehindLeader; 0 = on lead lap
}

// ---------------------------------------------------------------------------
// All-drivers lap snapshot (bridge task: AllDriversUpdate)
// ---------------------------------------------------------------------------

export interface WheelSnapshot {
  wear: number                              // 0.0 (new) – 1.0 (destroyed)
  surface_temp: [number, number, number]    // inner/mid/outer surface temp (°C)
  carcass_temp: number                      // carcass temperature (°C)
  inner_layer_temp: [number, number, number] // inner-layer temps (°C)
  pressure: number                          // tire pressure (kPa)
  flat: boolean
  detached: boolean
}

export interface DriverLapSnapshot {
  id: number
  driver_name: string
  vehicle_name: string
  class_name: string
  position: number
  total_laps: number
  last_lap_time: number          // seconds; ≤0 = no completed lap
  best_lap_time: number          // seconds; ≤0 = none
  last_sector1: number           // S1 time (s); -1 = invalid
  last_sector2: number           // S1+S2 cumulative (s); -1 = invalid
  last_sector3: number           // S3 individual (s); -1 = invalid
  gap_to_leader: number          // seconds behind leader
  laps_behind_leader: number     // 0 = on lead lap
  gap_ahead: number              // seconds to car ahead
  num_pitstops: number
  in_pits: boolean
  finish_status: number          // 0=none, 1=finished, 2=dnf, 3=dq
  fuel_remaining: number         // litres; -1 = no telemetry
  fuel_capacity: number
  tire_compound_front: number
  tire_compound_rear: number
  wheels: [WheelSnapshot, WheelSnapshot, WheelSnapshot, WheelSnapshot] // FL, FR, RL, RR
  lap_start_et: number
  speed_ms: number
  has_telemetry: boolean
}

export interface AllDriversUpdate {
  type: 'AllDriversUpdate'
  session_type: string
  session_time: number
  drivers: DriverLapSnapshot[]
}

export interface TelemetryUpdate {
  type: 'TelemetryUpdate'
  speed_ms: number
  rpm: number
  max_rpm: number
  gear: number
  throttle: number
  brake: number
  clutch: number
  steering: number
  fuel: number
  fuel_capacity: number
  water_temp: number
  oil_temp: number
  tires: [TireData, TireData, TireData, TireData]  // FL, FR, RL, RR
  position: Vec3
  velocity: Vec3
  local_accel: Vec3
  delta_best: number
  current_et: number
  lap_start_et: number     // session ET when current lap started
  // Fuel strategy (computed by bridge FuelTracker)
  fuel_avg_consumption: number    // L/lap rolling avg (5 laps); 0 = no data
  fuel_laps_remaining: number     // estimated laps remaining; Infinity if no avg
  fuel_stint_number: number       // 1-based stint counter
  fuel_stint_laps: number         // laps completed in current stint
  fuel_stint_consumption: number  // total fuel used since stint start
  fuel_recommended: number        // fuel needed for rest of session + 0.5 lap reserve; 0 if unknown
  fuel_pit_detected: boolean      // true for ~3s after pit stop detected
}

export interface ScoringUpdate {
  type: 'ScoringUpdate'
  session_type: string
  session_time: number
  num_vehicles: number
  vehicles: VehicleScoring[]
  player_vehicle_id: number
}

export interface SessionInfo {
  type: 'SessionInfo'
  track_name: string
  track_length: number
  weather: WeatherData
  session_laps: number
  session_minutes: number
}

export interface ElectronicsUpdate {
  type: 'ElectronicsUpdate'
  // Button-counted values
  tc: number
  tc_cut: number
  tc_slip: number
  abs: number
  engine_map: number
  front_arb: number
  rear_arb: number
  brake_bias: number          // button-counted bias in %, e.g. 56.0
  regen: number
  brake_migration: number
  brake_migration_max: number
  // From telemetry (raw sensor)
  brake_bias_front: number    // 0.0–1.0
  // From LMU extended (hybrid cars only)
  battery_pct: number         // 0.0–1.0; 0 if not hybrid
  energy_pct: number          // 0.0–1.0; 0 if not hybrid
  // Config status
  buttons_configured: boolean // false → show setup hint
  // In-game display labels from garage API (e.g. "front_arb" → "P4", "engine_map" → "40kW")
  // Empty object when no garage data has been fetched yet
  garage_labels: Record<string, string>
}

export interface VehicleStatusUpdate {
  type: 'VehicleStatusUpdate'
  // Damage (player vehicle, from telemetry)
  overheating: boolean
  any_detached: boolean
  dent_severity: [number, number, number, number, number, number, number, number] // 8 body zones
  last_impact_magnitude: number
  last_impact_et: number
  tire_flat: [boolean, boolean, boolean, boolean]      // FL, FR, RL, RR
  tire_detached: [boolean, boolean, boolean, boolean]  // FL, FR, RL, RR
  // Race flags (from scoring + rules)
  yellow_flag_state: number  // -1=none, 0=pending, 1=pits closed, 2=pits open, 3=last lap, 4=resume, 5=race halt
  sector_flags: [number, number, number]  // S1, S2, S3 local yellow
  start_light: number        // 0=off, 1-5=red lights, 6=green
  game_phase: number         // 0=garage, 5=green, 6=full-caution, 7=stopped, 8=over
  player_flag: number        // 0=green,1=blue,2=yellow,3=white,4=checkered,5=red,6=black
  player_under_yellow: boolean   // mUnderYellow from rF2
  player_sector: number          // 1=S1, 2=S2, 0=S3, -1=unknown
  safety_car_active: boolean
  safety_car_exists: boolean
}

export interface ConnectionStatus {
  type: 'ConnectionStatus'
  game_connected: boolean
  plugin_version: string
}

// ---------------------------------------------------------------------------
// Electronics config types (Settings / Binding UI)
// ---------------------------------------------------------------------------

export type InputBinding =
  | { type: 'keyboard'; key: string }
  | { type: 'joystick'; device_index: number; button: number }

export interface ElectronicsDefaults {
  tc: number
  tc_cut: number
  tc_slip: number
  abs: number
  engine_map: number
  front_arb: number
  rear_arb: number
  brake_bias: number   // percentage, e.g. 56.0
  regen: number
  brake_migration: number
}

export interface ConfigState {
  type: 'ConfigState'
  bindings: Record<string, InputBinding | null>
  defaults: ElectronicsDefaults
}

export interface BindingCaptured {
  type: 'BindingCaptured'
  binding_id: string
  binding: InputBinding
}

export interface BindingTimeout {
  type: 'BindingTimeout'
  binding_id: string
}

export interface ConfigSaved {
  type: 'ConfigSaved'
  success: boolean
}

export interface ControllerDiag {
  index: number
  name: string
  button_count: number
  connected: boolean
}

export interface InputEventDiag {
  timestamp_ms: number
  source: string    // "keyboard" | "joystick:0"
  input: string     // "F5" | "Button 15"
  action: string    // "pressed"
  mapped_to: string // "tc_increase"
}

export interface InputDiagnostics {
  type: 'InputDiagnostics'
  controllers: ControllerDiag[]
  recent_events: InputEventDiag[]
  capture_mode: boolean
}

export type ServerMessage =
  | TelemetryUpdate
  | ScoringUpdate
  | SessionInfo
  | ElectronicsUpdate
  | VehicleStatusUpdate
  | ConnectionStatus
  | AllDriversUpdate
  | ConfigState
  | BindingCaptured
  | BindingTimeout
  | ConfigSaved
  | InputDiagnostics

// ---------------------------------------------------------------------------
// Client → Bridge commands (sent as JSON text frames)
// ---------------------------------------------------------------------------

export type ClientCommand =
  | { command: 'start_binding_capture'; binding_id: string }
  | { command: 'cancel_binding_capture' }
  | { command: 'clear_binding'; binding_id: string }
  | { command: 'update_defaults'; defaults: ElectronicsDefaults }
  | { command: 'save_config' }
