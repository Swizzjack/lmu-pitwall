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
  carcass_temp: number
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
  // Virtual Energy (0.0 = no VE / not a hybrid; >0 = fraction 0.0–1.0)
  virtual_energy: number
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
  compound_index: number
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
  tire_compound_front_name: string
  tire_compound_rear_name: string
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
  fuel_avg_consumption: number    // L/lap rolling median; 0 = no valid data yet
  fuel_avg_sample_count: number   // number of fuel-consumption samples (0–10)
  fuel_laps_remaining: number     // estimated laps remaining; Infinity if no avg
  fuel_stint_number: number       // 1-based stint counter
  fuel_stint_laps: number         // laps completed in current stint (including outlap)
  fuel_stint_consumption: number  // total fuel used since stint start
  fuel_recommended: number        // kept for compat; always 0.0
  fuel_pit_detected: boolean      // true for ~3s after pit stop detected
  fuel_avg_lap_time: number       // rolling median lap time (s); 0 = no valid data yet
  ve_history: number[] | null     // per-lap VE values from REST API (0–1 each); null = unavailable
  ve_available: boolean | null    // true if car supports VE; null = not yet determined
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
  tc: number
  tc_max: number
  tc_cut: number
  tc_cut_max: number
  tc_slip: number
  tc_slip_max: number
  abs: number
  abs_max: number
  engine_map: number
  engine_map_max: number
  front_arb: number
  front_arb_max: number
  rear_arb: number
  rear_arb_max: number
  brake_bias: number           // front bias percent, e.g. 56.0
  regen: number                // kW
  brake_migration: number
  brake_migration_max: number
  battery_pct: number          // 0.0–1.0
  soc: number                  // state of charge
  virtual_energy: number       // virtual energy
  tc_active: boolean           // TC intervening right now
  abs_active: boolean          // ABS intervening right now
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
  yellow_flag_state: number  // -1=no scoring, 0=none, 1=pending, 2=pits closed, 3=pit lead lap, 4=pits open, 5=last lap, 6=resume, 7=race halt
  sector_flags: [number, number, number]  // S1, S2, S3 local yellow
  start_light: number        // 0=off, 1-5=red lights, 6=green
  game_phase: number         // 0=garage, 5=green, 6=full-caution, 7=stopped, 8=over
  player_flag: number        // mFlag: SDK only uses 0=no flag (green), 6=blue
  individual_phase: number   // mIndividualPhase: 10=under yellow — authoritative per-vehicle yellow indicator
  player_under_yellow: boolean   // mUnderYellow: FCY only (crossed S/F under FCY)
  player_sector: number          // 1=S1, 2=S2, 0=S3, -1=unknown
  safety_car_active: boolean
  safety_car_exists: boolean
}

export interface ConnectionStatus {
  type: 'ConnectionStatus'
  game_connected: boolean
  plugin_version: string
}

export type ServerMessage =
  | TelemetryUpdate
  | ScoringUpdate
  | SessionInfo
  | ElectronicsUpdate
  | VehicleStatusUpdate
  | ConnectionStatus
  | AllDriversUpdate
