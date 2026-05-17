import { create } from 'zustand'
import type {
  TireData,
  Vec3,
  WeatherData,
  VehicleScoring,
  DriverLapSnapshot,
  ServerMessage,
  ElectronicsUpdate,
  VehicleStatusUpdate,
  VersionInfo,
} from '../types/telemetry'
import type { ConnectionStatus } from '../hooks/useWebSocket'

// ---------------------------------------------------------------------------
// Lap history
// ---------------------------------------------------------------------------

export interface LapEntry {
  lapNumber: number  // 0 = outlap, 1 = first timed lap, etc.
  lapTime: number    // full lap seconds; -1 = invalid
  s1: number         // S1 individual seconds; -1 = invalid
  s2: number         // S2 individual seconds; -1 = invalid
  s3: number         // S3 individual seconds; -1 = invalid
}

export interface WeatherSnapshot {
  ts: number           // Date.now() — wall clock ms
  rain_intensity: number
  track_temp: number
  air_temp: number
  dark_cloud: number
}

// ---------------------------------------------------------------------------
// State sections
// ---------------------------------------------------------------------------

interface TelemetrySection {
  speed_ms: number
  speed_kmh: number           // derived: speed_ms * 3.6
  rpm: number
  max_rpm: number
  rpm_pct: number             // derived: rpm / max_rpm (0–1)
  gear: number                // -1 = reverse, 0 = neutral, 1–8
  gear_label: string          // derived: 'R' | 'N' | '1'…'8'
  throttle: number            // 0–1
  brake: number               // 0–1
  clutch: number              // 0–1
  steering: number            // -1 to +1
  fuel: number                // litres
  fuel_capacity: number       // litres
  fuel_pct: number            // derived: fuel / fuel_capacity (0–1)
  water_temp: number
  oil_temp: number
  tires: [TireData, TireData, TireData, TireData] | null  // FL, FR, RL, RR
  local_accel: Vec3
  delta_best: number
  current_et: number
  lap_start_et: number
  // Fuel strategy
  fuel_avg_consumption: number
  fuel_avg_sample_count: number
  fuel_laps_remaining: number
  fuel_stint_number: number
  fuel_stint_laps: number
  fuel_stint_consumption: number
  fuel_recommended: number
  fuel_pit_detected: boolean
  fuel_avg_lap_time: number
  ve_history: number[] | null
  ve_available: boolean | null
}

interface ScoringSection {
  session_type: string
  session_time: number
  num_vehicles: number
  vehicles: VehicleScoring[]
  player_vehicle_id: number
}

interface SessionSection {
  track_name: string
  track_length: number
  weather: WeatherData | null
  session_laps: number
  session_minutes: number
}

// Omit the 'type' discriminator — we only store the data
type ElectronicsSection = Omit<ElectronicsUpdate, 'type'>
type VehicleStatusSection = Omit<VehicleStatusUpdate, 'type'>

interface AllDriversSection {
  session_type: string
  session_time: number
  drivers: DriverLapSnapshot[]
  lastUpdated: number  // Date.now() timestamp; 0 = never received
}

interface ConnectionSection {
  status: ConnectionStatus
  game_connected: boolean
  plugin_version: string
}

type VersionInfoSection = Omit<VersionInfo, 'type'> | null

// ---------------------------------------------------------------------------
// Full store shape
// ---------------------------------------------------------------------------

interface TelemetryStore {
  telemetry: TelemetrySection
  scoring: ScoringSection
  session: SessionSection
  electronics: ElectronicsSection
  vehicleStatus: VehicleStatusSection
  allDrivers: AllDriversSection
  connection: ConnectionSection
  versionInfo: VersionInfoSection
  lapHistory: LapEntry[]
  weatherHistory: WeatherSnapshot[]
  _lapTracking: { prevTotalLaps: number; prevPlayerId: number }

  // Actions
  setConnection: (status: ConnectionStatus) => void
  applyMessage: (msg: ServerMessage) => void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaultTire: TireData = {
  temp_inner: 0,
  temp_mid: 0,
  temp_outer: 0,
  carcass_temp: 0,
  pressure: 0,
  wear: 0,
  brake_temp: 0,
}

const defaultTelemetry: TelemetrySection = {
  speed_ms: 0,
  speed_kmh: 0,
  rpm: 0,
  max_rpm: 9000,
  rpm_pct: 0,
  gear: 0,
  gear_label: 'N',
  throttle: 0,
  brake: 0,
  clutch: 0,
  steering: 0,
  fuel: 0,
  fuel_capacity: 100,
  fuel_pct: 0,
  water_temp: 0,
  oil_temp: 0,
  tires: [defaultTire, defaultTire, defaultTire, defaultTire],
  local_accel: { x: 0, y: 0, z: 0 },
  delta_best: 0,
  current_et: 0,
  lap_start_et: 0,
  fuel_avg_consumption: 0,
  fuel_avg_sample_count: 0,
  fuel_laps_remaining: Infinity,
  fuel_stint_number: 1,
  fuel_stint_laps: 0,
  fuel_stint_consumption: 0,
  fuel_recommended: 0,
  fuel_pit_detected: false,
  fuel_avg_lap_time: 0,
  ve_history: null,
  ve_available: null,
}

const defaultScoring: ScoringSection = {
  session_type: '',
  session_time: 0,
  num_vehicles: 0,
  vehicles: [],
  player_vehicle_id: -1,
}

const defaultSession: SessionSection = {
  track_name: '',
  track_length: 0,
  weather: null,
  session_laps: 0,
  session_minutes: 0,
}

const defaultElectronics: ElectronicsSection = {
  tc: 0,
  tc_max: 0,
  tc_cut: 0,
  tc_cut_max: 0,
  tc_slip: 0,
  tc_slip_max: 0,
  abs: 0,
  abs_max: 0,
  engine_map: 0,
  engine_map_max: 0,
  front_arb: 0,
  front_arb_max: 0,
  rear_arb: 0,
  rear_arb_max: 0,
  brake_bias: 56.0,
  regen: 0,
  brake_migration: 0,
  brake_migration_max: 0,
  battery_pct: 0,
  soc: 0,
  virtual_energy: 0,
  tc_active: false,
  abs_active: false,
}

const defaultVehicleStatus: VehicleStatusSection = {
  overheating: false,
  any_detached: false,
  dent_severity: [0, 0, 0, 0, 0, 0, 0, 0],
  last_impact_magnitude: 0,
  last_impact_et: 0,
  tire_flat: [false, false, false, false],
  tire_detached: [false, false, false, false],
  aero_damage: -1,
  brake_wear: [-1, -1, -1, -1],
  suspension_damage: [-1, -1, -1, -1],
  yellow_flag_state: -1,
  sector_flags: [0, 0, 0],
  start_light: 0,
  game_phase: 0,
  player_flag: 0,
  individual_phase: 0,
  player_under_yellow: false,
  player_sector: -1,
  safety_car_active: false,
  safety_car_exists: false,
}

const defaultConnection: ConnectionSection = {
  status: 'disconnected',
  game_connected: false,
  plugin_version: '',
}

const defaultAllDrivers: AllDriversSection = {
  session_type: '',
  session_time: 0,
  drivers: [],
  lastUpdated: 0,
}

// ---------------------------------------------------------------------------
// Helpers for derived values
// ---------------------------------------------------------------------------

function gearLabel(gear: number): string {
  if (gear === -1) return 'R'
  if (gear === 0) return 'N'
  return String(gear)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTelemetryStore = create<TelemetryStore>((set) => ({
  telemetry: defaultTelemetry,
  scoring: defaultScoring,
  session: defaultSession,
  electronics: defaultElectronics,
  vehicleStatus: defaultVehicleStatus,
  allDrivers: defaultAllDrivers,
  connection: defaultConnection,
  versionInfo: null,
  lapHistory: [],
  weatherHistory: [],
  _lapTracking: { prevTotalLaps: -1, prevPlayerId: -1 },

  setConnection: (status) =>
    set((state) => ({
      connection: { ...state.connection, status },
    })),

  applyMessage: (msg) => {
    switch (msg.type) {
      case 'TelemetryUpdate':
        set({
          telemetry: {
            speed_ms: msg.speed_ms,
            speed_kmh: msg.speed_ms * 3.6,
            rpm: msg.rpm,
            max_rpm: msg.max_rpm,
            rpm_pct: msg.max_rpm > 0 ? msg.rpm / msg.max_rpm : 0,
            gear: msg.gear,
            gear_label: gearLabel(msg.gear),
            throttle: msg.throttle,
            brake: msg.brake,
            clutch: msg.clutch,
            steering: msg.steering,
            fuel: msg.fuel,
            fuel_capacity: msg.fuel_capacity,
            fuel_pct: msg.fuel_capacity > 0 ? msg.fuel / msg.fuel_capacity : 0,
            water_temp: msg.water_temp,
            oil_temp: msg.oil_temp,
            tires: msg.tires,
            local_accel: msg.local_accel,
            delta_best: msg.delta_best,
            current_et: msg.current_et,
            lap_start_et: msg.lap_start_et,
            fuel_avg_consumption: msg.fuel_avg_consumption,
            fuel_avg_sample_count: msg.fuel_avg_sample_count,
            fuel_laps_remaining: msg.fuel_laps_remaining,
            fuel_stint_number: msg.fuel_stint_number,
            fuel_stint_laps: msg.fuel_stint_laps,
            fuel_stint_consumption: msg.fuel_stint_consumption,
            fuel_recommended: msg.fuel_recommended,
            fuel_pit_detected: msg.fuel_pit_detected,
            fuel_avg_lap_time: msg.fuel_avg_lap_time,
            ve_history: msg.ve_history ?? null,
            ve_available: msg.ve_available ?? null,
          },
        })
        break

      case 'ScoringUpdate':
        set((state) => {
          const player = msg.vehicles.find((v) => v.id === msg.player_vehicle_id)
          let { lapHistory, _lapTracking: tracking } = state

          if (player) {
            const { prevTotalLaps, prevPlayerId } = tracking
            if (player.id !== prevPlayerId || player.total_laps < prevTotalLaps) {
              // New session or player reset: clear history
              lapHistory = []
              tracking = { prevTotalLaps: player.total_laps, prevPlayerId: player.id }
            } else if (player.total_laps > prevTotalLaps) {
              // A lap was completed — prevTotalLaps is the just-completed lap number
              const s1 = player.last_sector1
              const s2cum = player.last_sector2
              const s2 = (s2cum > 0 && s1 > 0) ? s2cum - s1 : -1
              const s3 = (player.last_lap_time > 0 && s2cum > 0) ? player.last_lap_time - s2cum : -1
              const entry: LapEntry = {
                lapNumber: prevTotalLaps,
                lapTime: player.last_lap_time,
                s1,
                s2,
                s3,
              }
              lapHistory = [...lapHistory, entry]
              tracking = { prevTotalLaps: player.total_laps, prevPlayerId: player.id }
            }
          }

          return {
            scoring: {
              session_type: msg.session_type,
              session_time: msg.session_time,
              num_vehicles: msg.num_vehicles,
              vehicles: msg.vehicles,
              player_vehicle_id: msg.player_vehicle_id,
            },
            lapHistory,
            _lapTracking: tracking,
          }
        })
        break

      case 'SessionInfo':
        set((state) => {
          // Sample weather history at most once every 30 s (max 40 entries = 20 min)
          const SAMPLE_INTERVAL_MS = 30_000
          const MAX_HISTORY = 40
          let weatherHistory = state.weatherHistory
          if (msg.weather) {
            const now = Date.now()
            const last = weatherHistory[weatherHistory.length - 1]
            if (!last || now - last.ts >= SAMPLE_INTERVAL_MS) {
              const snap: WeatherSnapshot = {
                ts: now,
                rain_intensity: msg.weather.rain_intensity,
                track_temp:     msg.weather.track_temp,
                air_temp:       msg.weather.air_temp,
                dark_cloud:     msg.weather.dark_cloud,
              }
              weatherHistory = [...weatherHistory, snap].slice(-MAX_HISTORY)
            }
          }
          return {
            session: {
              track_name:      msg.track_name,
              track_length:    msg.track_length,
              weather:         msg.weather,
              session_laps:    msg.session_laps,
              session_minutes: msg.session_minutes,
            },
            weatherHistory,
          }
        })
        break

      case 'ElectronicsUpdate':
        set({
          electronics: {
            tc: msg.tc,
            tc_max: msg.tc_max,
            tc_cut: msg.tc_cut,
            tc_cut_max: msg.tc_cut_max,
            tc_slip: msg.tc_slip,
            tc_slip_max: msg.tc_slip_max,
            abs: msg.abs,
            abs_max: msg.abs_max,
            engine_map: msg.engine_map,
            engine_map_max: msg.engine_map_max,
            front_arb: msg.front_arb,
            front_arb_max: msg.front_arb_max,
            rear_arb: msg.rear_arb,
            rear_arb_max: msg.rear_arb_max,
            brake_bias: msg.brake_bias,
            regen: msg.regen,
            brake_migration: msg.brake_migration,
            brake_migration_max: msg.brake_migration_max,
            battery_pct: msg.battery_pct,
            soc: msg.soc,
            virtual_energy: msg.virtual_energy,
            tc_active: msg.tc_active,
            abs_active: msg.abs_active,
          },
        })
        break

      case 'VehicleStatusUpdate':
        set({
          vehicleStatus: {
            overheating:           msg.overheating,
            any_detached:          msg.any_detached,
            dent_severity:         msg.dent_severity,
            last_impact_magnitude: msg.last_impact_magnitude,
            last_impact_et:        msg.last_impact_et,
            tire_flat:             msg.tire_flat,
            tire_detached:         msg.tire_detached,
            aero_damage:           msg.aero_damage,
            brake_wear:            msg.brake_wear,
            suspension_damage:     msg.suspension_damage,
            yellow_flag_state:     msg.yellow_flag_state,
            sector_flags:          msg.sector_flags,
            start_light:           msg.start_light,
            game_phase:            msg.game_phase,
            player_flag:           msg.player_flag,
            individual_phase:      msg.individual_phase,
            player_under_yellow:   msg.player_under_yellow,
            player_sector:         msg.player_sector,
            safety_car_active:     msg.safety_car_active,
            safety_car_exists:     msg.safety_car_exists,
          },
        })
        break

      case 'ConnectionStatus':
        set((state) => ({
          connection: {
            ...state.connection,
            game_connected: msg.game_connected,
            plugin_version: msg.plugin_version,
          },
        }))
        break

      case 'AllDriversUpdate':
        set({
          allDrivers: {
            session_type: msg.session_type,
            session_time: msg.session_time,
            drivers: msg.drivers,
            lastUpdated: Date.now(),
          },
        })
        break

      case 'VersionInfo':
        set({
          versionInfo: {
            current_version: msg.current_version,
            latest_version: msg.latest_version,
            download_url: msg.download_url,
            update_available: msg.update_available,
          },
        })
        break
    }
  },
}))
