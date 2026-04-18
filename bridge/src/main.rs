// On Windows: suppress the console window entirely (GUI subsystem)
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod assets;
mod config;
mod electronics;
mod fuel;
mod fuel_calculator;
mod garage_api;
mod http_server;
mod lap_tracker;
mod post_race;
mod protocol;
mod race_engineer;
mod rest_api;
mod shared_memory;
mod websocket;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use clap::Parser;
use tokio::sync::{RwLock, watch};
use tokio::time::MissedTickBehavior;
use tracing::{info, warn};

use config::Config;
use electronics::ElectronicsSnapshot;
use fuel::{FuelSnapshot, FuelTracker};
use lap_tracker::LapTracker;
use protocol::messages::{ServerMessage, TireData, Vec3, VehicleScoring, WeatherData};
use shared_memory::reader::SharedMemoryReader;
use shared_memory::types::{bytes_to_str, rF2RulesBuffer, rF2ScoringBuffer, rF2TelemetryBuffer, MAX_MAPPED_VEHICLES};

static LAST_DELTA_LOG: AtomicU64 = AtomicU64::new(0);
use websocket::server::WebSocketServer;

// ---------------------------------------------------------------------------
// Shared state — written by polling task, read by broadcaster task
// ---------------------------------------------------------------------------

struct TelemetryState {
    telemetry: Option<rF2TelemetryBuffer>,
    scoring: Option<rF2ScoringBuffer>,
    rules: Option<rF2RulesBuffer>,
    is_connected: bool,
    electronics: ElectronicsSnapshot,
    /// Per-lap VE history from strategy/usage REST API; None = data unavailable.
    ve_history: Option<Vec<f64>>,
    /// Whether this car supports Virtual Energy (derived from telemetry).
    /// None = not yet determined.
    ve_available: Option<bool>,
}

impl TelemetryState {
    fn new() -> Self {
        Self {
            telemetry: None,
            scoring: None,
            rules: None,
            is_connected: false,
            electronics: ElectronicsSnapshot::default(),
            ve_history: None,
            ve_available: None,
        }
    }
}

// ---------------------------------------------------------------------------
// rF2 → ServerMessage transformations
// ---------------------------------------------------------------------------

fn session_type_str(session: i32) -> &'static str {
    match session {
        0 => "TestDay",
        1..=4 => "Practice",
        5..=8 => "Qualifying",
        9 => "Warmup",
        10..=13 => "Race",
        _ => "Unknown",
    }
}

/// Extract a TelemetryUpdate for the given player slot ID (or first vehicle as fallback).
fn build_telemetry_update(
    tel: &rF2TelemetryBuffer,
    player_id: i32,
    fuel: &FuelSnapshot,
    ve_history: Option<Vec<f64>>,
    ve_available: Option<bool>,
) -> Option<ServerMessage> {
    let num = (tel.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
    if num == 0 {
        return None;
    }

    let veh = tel.mVehicles[..num]
        .iter()
        .find(|v| v.mID == player_id)
        .unwrap_or(&tel.mVehicles[0]);

    let lv = veh.mLocalVel;
    let speed_ms = (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z).sqrt();

    // delta_best is now a named field in LMU v1.3 TelemInfoV01.
    let delta_best = veh.mDeltaBest;
    let elapsed_time = veh.mElapsedTime;
    let lap_start_et = veh.mLapStartET;

    // Debug log every 5 seconds (throttled via AtomicU64 second-counter)
    let now_secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last = LAST_DELTA_LOG.load(Ordering::Relaxed);
    if now_secs.saturating_sub(last) >= 5 {
        LAST_DELTA_LOG.store(now_secs, Ordering::Relaxed);
        tracing::debug!(
            "delta_best={:.3}s  elapsed={:.3}s  lap_start_et={:.3}s",
            delta_best,
            elapsed_time,
            lap_start_et,
        );
    }

    Some(ServerMessage::TelemetryUpdate {
        speed_ms,
        rpm:          veh.mEngineRPM,
        max_rpm:      veh.mEngineMaxRPM,
        gear:         veh.mGear,
        throttle:     veh.mFilteredThrottle,
        brake:        veh.mFilteredBrake,
        clutch:       veh.mFilteredClutch,
        steering:     veh.mFilteredSteering,
        fuel:         veh.mFuel,
        fuel_capacity: veh.mFuelCapacity,
        water_temp:   veh.mEngineWaterTemp,
        oil_temp:     veh.mEngineOilTemp,
        // Tire temps are in Kelvin — convert to Celsius
        tires: [0usize, 1, 2, 3].map(|i| TireData {
            temp_inner:   veh.mWheels[i].mTemperature[0] - 273.15,
            temp_mid:     veh.mWheels[i].mTemperature[1] - 273.15,
            temp_outer:   veh.mWheels[i].mTemperature[2] - 273.15,
            carcass_temp: veh.mWheels[i].mTireCarcassTemperature - 273.15,
            pressure:     veh.mWheels[i].mPressure,
            wear:       veh.mWheels[i].mWear,
            brake_temp: veh.mWheels[i].mBrakeTemp - 273.15,
        }),
        position:    Vec3 { x: veh.mPos.x,      y: veh.mPos.y,      z: veh.mPos.z },
        velocity:    Vec3 { x: lv.x,             y: lv.y,            z: lv.z },
        local_accel: Vec3 { x: veh.mLocalAccel.x, y: veh.mLocalAccel.y, z: veh.mLocalAccel.z },
        delta_best,
        current_et:   elapsed_time,
        lap_start_et: lap_start_et,
        // Fuel strategy
        fuel_avg_consumption:   fuel.avg_consumption,
        fuel_avg_sample_count:  fuel.sample_count,
        fuel_laps_remaining:    fuel.laps_remaining,
        fuel_stint_number:      fuel.stint_number,
        fuel_stint_laps:        fuel.stint_laps,
        fuel_stint_consumption: fuel.stint_consumption,
        fuel_recommended:       fuel.recommended,
        fuel_pit_detected:      fuel.pit_detected,
        fuel_avg_lap_time:      fuel.avg_lap_time,
        ve_history,
        ve_available,
    })
}

/// Build a ScoringUpdate and return the player slot ID found in scoring data.
fn build_scoring_update(sc: &rF2ScoringBuffer, tel: Option<&rF2TelemetryBuffer>) -> (ServerMessage, i32) {
    let info = &sc.mScoringInfo;
    let num = (info.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
    let mut player_id = -1i32;

    // Build a lookup: vehicle ID → mVirtualEnergy from telemetry buffer
    let ve_map: std::collections::HashMap<i32, f32> = tel.map(|t| {
        let tel_num = (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
        t.mVehicles[..tel_num]
            .iter()
            .map(|tv| (tv.mID, tv.mVirtualEnergy))
            .collect()
    }).unwrap_or_default();

    let vehicles: Vec<VehicleScoring> = sc.mVehicles[..num]
        .iter()
        .map(|v| {
            if v.mIsPlayer != 0 {
                player_id = v.mID;
            }
            VehicleScoring {
                id:           v.mID,
                driver_name:  bytes_to_str(&v.mDriverName).to_string(),
                team_name:    String::new(), // not in rF2VehicleScoring
                vehicle_class: bytes_to_str(&v.mVehicleClass).to_string(),
                position:     v.mPlace as i32,
                lap_dist:     v.mLapDist,
                total_laps:   v.mTotalLaps as i32,
                best_lap_time: v.mBestLapTime,
                last_lap_time: v.mLastLapTime,
                in_pits:      v.mInPits != 0,
                last_sector1:  v.mLastSector1,
                last_sector2:  v.mLastSector2,
                cur_sector1:   v.mCurSector1,
                cur_sector2:   v.mCurSector2,
                best_sector1:  v.mBestSector1,
                best_sector2:  v.mBestSector2,
                lap_start_et:  v.mLapStartET,
                car_number:    v.mID,
                car_name:      bytes_to_str(&v.mVehicleName).to_string(),
                last_sector3:  if v.mLastLapTime > 0.0 && v.mLastSector2 > 0.0 {
                    v.mLastLapTime - v.mLastSector2
                } else {
                    -1.0
                },
                best_sector3:  if v.mBestLapTime > 0.0 && v.mBestSector2 > 0.0 {
                    v.mBestLapTime - v.mBestSector2
                } else {
                    -1.0
                },
                pos_x: v.mPos.x,
                pos_z: v.mPos.z,
                time_behind_leader: v.mTimeBehindLeader,
                laps_behind_leader: v.mLapsBehindLeader,
                virtual_energy: *ve_map.get(&v.mID).unwrap_or(&0.0),
            }
        })
        .collect();

    let msg = ServerMessage::ScoringUpdate {
        session_type:      session_type_str(info.mSession).to_string(),
        session_time:      info.mCurrentET,
        num_vehicles:      info.mNumVehicles,
        vehicles,
        player_vehicle_id: player_id,
    };
    (msg, player_id)
}

fn build_electronics_update(snap: &ElectronicsSnapshot) -> ServerMessage {
    ServerMessage::ElectronicsUpdate {
        tc: snap.tc,
        tc_max: snap.tc_max,
        tc_cut: snap.tc_cut,
        tc_cut_max: snap.tc_cut_max,
        tc_slip: snap.tc_slip,
        tc_slip_max: snap.tc_slip_max,
        abs: snap.abs,
        abs_max: snap.abs_max,
        engine_map: snap.engine_map,
        engine_map_max: snap.engine_map_max,
        front_arb: snap.front_arb,
        front_arb_max: snap.front_arb_max,
        rear_arb: snap.rear_arb,
        rear_arb_max: snap.rear_arb_max,
        brake_bias: snap.brake_bias,
        regen: snap.regen,
        brake_migration: snap.brake_migration,
        brake_migration_max: snap.brake_migration_max,
        battery_pct: snap.battery_pct,
        soc: snap.soc,
        virtual_energy: snap.virtual_energy,
        tc_active: snap.tc_active,
        abs_active: snap.abs_active,
    }
}

fn build_session_info(sc: &rF2ScoringBuffer) -> ServerMessage {
    let info = &sc.mScoringInfo;
    ServerMessage::SessionInfo {
        track_name:      bytes_to_str(&info.mTrackName).to_string(),
        track_length:    info.mLapDist,
        weather: WeatherData {
            air_temp:       info.mAmbientTemp,
            track_temp:     info.mTrackTemp,
            rain_intensity: info.mRaining,
        },
        // Filter mMaxLaps: time-based races use 999999, uninitialized can be INT32_MAX.
        // Only send a valid lap count when it's a genuine lap-limited session.
        session_laps:    if info.mMaxLaps > 0 && info.mMaxLaps < 999_000 { info.mMaxLaps } else { 0 },
        session_minutes: if info.mEndET > 0.0 { info.mEndET / 60.0 } else { 0.0 },
    }
}

fn build_vehicle_status(
    tel: Option<&rF2TelemetryBuffer>,
    sc:  Option<&rF2ScoringBuffer>,
    rules: Option<&rF2RulesBuffer>,
    player_id: i32,
) -> ServerMessage {
    // --- Damage from telemetry ---
    let (overheating, any_detached, dent_severity, last_impact_magnitude, last_impact_et,
         tire_flat, tire_detached) = tel
        .and_then(|t| {
            let num = (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
            if num == 0 { return None; }
            let veh = t.mVehicles[..num]
                .iter()
                .find(|v| v.mID == player_id)
                .unwrap_or(&t.mVehicles[0]);
            Some((
                veh.mOverheating != 0,
                veh.mDetached != 0,
                veh.mDentSeverity,
                veh.mLastImpactMagnitude,
                veh.mLastImpactET,
                [
                    veh.mWheels[0].mFlat != 0,
                    veh.mWheels[1].mFlat != 0,
                    veh.mWheels[2].mFlat != 0,
                    veh.mWheels[3].mFlat != 0,
                ],
                [
                    veh.mWheels[0].mDetached != 0,
                    veh.mWheels[1].mDetached != 0,
                    veh.mWheels[2].mDetached != 0,
                    veh.mWheels[3].mDetached != 0,
                ],
            ))
        })
        .unwrap_or((false, false, [0u8; 8], 0.0, 0.0, [false; 4], [false; 4]));

    // --- Flags from scoring ---
    let (yellow_flag_state, sector_flags, start_light, game_phase, player_flag, individual_phase, player_under_yellow, player_sector) =
        sc.map(|sc| {
            let info = &sc.mScoringInfo;
            let num = (info.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
            let (pflag, iphase, punder, psector) = sc.mVehicles[..num]
                .iter()
                .find(|v| v.mID == player_id || v.mIsPlayer != 0)
                .map(|v| (v.mFlag, v.mIndividualPhase, v.mUnderYellow != 0, v.mSector))
                .unwrap_or((0, 0, false, -1));
            // NOTE: Do NOT derive yellow state from mSectorFlag alone — LMU leaves
            // mSectorFlag non-zero even during green-flag conditions.
            // Use mIndividualPhase==10 (under yellow) as the authoritative per-vehicle indicator.
            (
                info.mYellowFlagState as i32,
                [
                    info.mSectorFlag[0] as i32,
                    info.mSectorFlag[1] as i32,
                    info.mSectorFlag[2] as i32,
                ],
                info.mStartLight,
                info.mGamePhase,
                pflag,
                iphase,
                punder,
                psector as i32,
            )
        })
        .unwrap_or((-1, [0; 3], 0, 0, 0, 0, false, -1));

    // --- Safety car from rules buffer ---
    let (safety_car_active, safety_car_exists) = rules
        .map(|r| (r.mRules.mSafetyCarActive != 0, r.mRules.mSafetyCarExists != 0))
        .unwrap_or((false, false));

    ServerMessage::VehicleStatusUpdate {
        overheating,
        any_detached,
        dent_severity,
        last_impact_magnitude,
        last_impact_et,
        tire_flat,
        tire_detached,
        yellow_flag_state,
        sector_flags,
        start_light,
        game_phase,
        player_flag,
        individual_phase,
        player_under_yellow,
        player_sector,
        safety_car_active,
        safety_car_exists,
    }
}


// ---------------------------------------------------------------------------
// Task 1 + 3: Shared memory polling (50 Hz) + health check / reconnect (0.5 Hz)
//
// Owns the SharedMemoryReader. Writes into Arc<RwLock<TelemetryState>>.
// Broadcasts ConnectionStatus events via the WebSocket server.
// ---------------------------------------------------------------------------

async fn task_polling(
    state: Arc<RwLock<TelemetryState>>,
    ws: Arc<WebSocketServer>,
    ws_port: u16,
) {
    let mut reader = SharedMemoryReader::new();
    let mut was_connected = false;

    // Track session identity for VE history clearing: "<session>/<track_name>"
    let mut last_session_key = String::new();

    // Channel for strategy/usage VE fetch results.
    let (strategy_tx, mut strategy_rx) = tokio::sync::mpsc::channel::<Vec<f64>>(4);

    let mut poll_ticker = tokio::time::interval(Duration::from_millis(20)); // 50 Hz
    poll_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Health check fires immediately on first tick, then every 2 seconds.
    let mut health_ticker = tokio::time::interval(Duration::from_secs(2));
    health_ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    // strategy/usage VE poll every 3 seconds.
    let mut strategy_ticker = tokio::time::interval(Duration::from_secs(3));
    strategy_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Player name for strategy/usage lookup (extracted from scoring).
    let mut last_player_name = String::new();

    info!("Waiting for Le Mans Ultimate...");

    loop {
        tokio::select! {
            // --- 50 Hz polling ---
            _ = poll_ticker.tick() => {
                // Shared memory reads only make sense when the game is running.
                if !reader.is_connected() {
                    continue;
                }

                let tel   = reader.read_telemetry();
                let sc    = reader.read_scoring();
                let rules = reader.read_rules();

                // Build electronics snapshot directly from telemetry.
                let player_id_from_sc = sc.as_ref().and_then(|s| {
                    let num = (s.mScoringInfo.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                    s.mVehicles[..num].iter().find(|v| v.mIsPlayer != 0).map(|v| v.mID)
                }).unwrap_or(-1);

                let electronics = tel.as_ref().and_then(|t| {
                    let num = (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                    t.mVehicles[..num]
                        .iter()
                        .find(|v| v.mID == player_id_from_sc || player_id_from_sc == -1)
                        .or_else(|| t.mVehicles.get(0))
                        .map(ElectronicsSnapshot::from_telemetry)
                }).unwrap_or_default();

                // Derive ve_available from telemetry.
                let ve_available = tel.as_ref().and_then(|t| {
                    let num = (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                    t.mVehicles[..num]
                        .iter()
                        .find(|v| v.mID == player_id_from_sc || player_id_from_sc == -1)
                        .map(|v| v.mVirtualEnergy > 0.0 || v.mBatteryChargeFraction > 0.0)
                });

                // Session-change detection → clear VE history + track player name.
                if let Some(ref sc_data) = sc {
                    let key = format!(
                        "{}/{}",
                        sc_data.mScoringInfo.mSession,
                        bytes_to_str(&sc_data.mScoringInfo.mTrackName),
                    );
                    if !last_session_key.is_empty() && key != last_session_key {
                        info!("Session changed — clearing VE history");
                        state.write().await.ve_history = None;
                    }
                    last_session_key = key;

                    // Track player name for strategy/usage lookup.
                    let num_vehs = (sc_data.mScoringInfo.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                    if let Some(name) = sc_data.mVehicles[..num_vehs]
                        .iter()
                        .find(|v| v.mIsPlayer != 0)
                        .map(|v| bytes_to_str(&v.mDriverName).to_string())
                    {
                        if !name.is_empty() {
                            last_player_name = name;
                        }
                    }
                }

                let mut s = state.write().await;
                s.telemetry   = tel;
                s.scoring     = sc;
                s.rules       = rules;
                s.electronics = electronics;
                if let Some(v) = ve_available {
                    s.ve_available = Some(v);
                }
            }

            // --- strategy/usage VE poll (0.33 Hz) ---
            _ = strategy_ticker.tick() => {
                if reader.is_connected() && !last_player_name.is_empty() {
                    let name = last_player_name.clone();
                    let tx = strategy_tx.clone();
                    tokio::task::spawn_blocking(move || {
                        if let Some(ve) = garage_api::fetch_strategy_ve(&name) {
                            let _ = tx.blocking_send(ve);
                        }
                    });
                }
            }

            // --- strategy/usage VE result ---
            Some(history) = strategy_rx.recv() => {
                state.write().await.ve_history = Some(history);
            }

            // --- 0.5 Hz health check / reconnect ---
            _ = health_ticker.tick() => {
                // Close and re-open: the only reliable way to detect LMU
                // start/stop without polling process lists.
                reader.close();
                let now_connected = reader.open();

                match (was_connected, now_connected) {
                    (false, true) => {
                        // LMU just started (or bridge started while LMU was already running).
                        info!("Connected to Le Mans Ultimate shared memory — broadcasting on ws://0.0.0.0:{}", ws_port);
                        ws.broadcast(ServerMessage::ConnectionStatus {
                            game_connected: true,
                            plugin_version: String::from("rF2SharedMemoryMapPlugin"),
                        });
                        state.write().await.is_connected = true;
                        was_connected = true;
                    }
                    (true, false) => {
                        // LMU exited or plugin unloaded.
                        warn!("Lost connection to Le Mans Ultimate — waiting for reconnect");
                        ws.broadcast(ServerMessage::ConnectionStatus {
                            game_connected: false,
                            plugin_version: String::new(),
                        });
                        let mut s = state.write().await;
                        s.is_connected = false;
                        s.telemetry    = None;
                        s.scoring      = None;
                        s.rules        = None;
                        s.ve_history   = None;
                        s.ve_available = None;
                        was_connected  = false;
                        last_player_name = String::new();
                    }
                    _ => {} // no change in connection state
                }
            }
        }
    }

}


// ---------------------------------------------------------------------------
// Task 2: WebSocket broadcaster — rate-limited per message type
//
// Telemetry : configurable (default 30 Hz)
// Scoring   : configurable (default  5 Hz)
// SessionInfo: fixed        1 Hz
// ---------------------------------------------------------------------------

async fn task_broadcaster(
    state: Arc<RwLock<TelemetryState>>,
    ws: Arc<WebSocketServer>,
    telemetry_fps: u32,
    scoring_fps: u32,
    all_drivers_tx: tokio::sync::watch::Sender<Option<ServerMessage>>,
    engineer_service: Arc<race_engineer::RaceEngineerService>,
) {
    let tel_interval         = Duration::from_millis(1000 / telemetry_fps.max(1) as u64);
    let scoring_interval     = Duration::from_millis(1000 / scoring_fps.max(1) as u64);
    let session_interval     = Duration::from_secs(1);
    let electronics_interval = Duration::from_millis(200); // 5 Hz

    // Initialise to a point in the past so we send immediately on first connect.
    let epoch = Instant::now();
    let mut last_tel         = epoch - tel_interval;
    let mut last_scoring     = epoch - scoring_interval;
    let mut last_session     = epoch - session_interval;
    let mut last_electronics = epoch - electronics_interval;

    let mut player_id: i32 = -1;

    // Fuel strategy tracker — lives here for the lifetime of the broadcaster task.
    let mut fuel_tracker = FuelTracker::new();
    let mut fuel_snapshot = FuelSnapshot::default();
    let mut fuel_session_key = String::new();

    // Template registry for rule-fired TTS synthesis.
    let engineer_templates = race_engineer::rules::templates::TemplateRegistry::new();
    // Audio broadcast sender — only audio-role clients receive EngineerAudio.
    let audio_broadcaster = ws.audio_broadcaster();

    // All-drivers lap snapshot tracker.
    let mut lap_tracker = LapTracker::new();

    // Race engineer 10 Hz throttle.
    let mut last_engineer_tick = Instant::now() - Duration::from_millis(100);
    let mut had_drivers_snapshot = false;

    // Tick at 2× the fastest rate so we never miss a window.
    let tick_ms = (500 / telemetry_fps.max(1)).max(1) as u64;
    let mut ticker = tokio::time::interval(Duration::from_millis(tick_ms));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;

        let now = Instant::now();
        let send_tel         = now.duration_since(last_tel)         >= tel_interval;
        let send_scoring     = now.duration_since(last_scoring)     >= scoring_interval;
        let send_session     = now.duration_since(last_session)     >= session_interval;
        let send_electronics = now.duration_since(last_electronics) >= electronics_interval;

        // Hold the read lock only long enough to clone the messages.
        let (tel_msg, sc_result, session_msg, electronics_msg, status_msg, all_drivers_result) = {
            let s = state.read().await;
            if !s.is_connected {
                continue;
            }

            // Session-change detection for fuel tracker reset.
            if let Some(ref sc) = s.scoring {
                let key = format!(
                    "{}/{}",
                    sc.mScoringInfo.mSession,
                    bytes_to_str(&sc.mScoringInfo.mTrackName),
                );
                if !fuel_session_key.is_empty() && key != fuel_session_key {
                    fuel_tracker = FuelTracker::new();
                    fuel_snapshot = FuelSnapshot::default();
                    info!("Session changed — fuel tracker reset");
                }
                fuel_session_key = key;
            }

            // Update fuel tracker on every telemetry tick (needs mutable access outside lock).
            if send_tel {
                if let (Some(ref tel), Some(ref sc)) = (&s.telemetry, &s.scoring) {
                    let num_tel = (tel.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                    let num_sc  = (sc.mScoringInfo.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);

                    let current_fuel = tel.mVehicles[..num_tel]
                        .iter()
                        .find(|v| v.mID == player_id)
                        .unwrap_or_else(|| &tel.mVehicles[0])
                        .mFuel;

                    let player_sc = sc.mVehicles[..num_sc]
                        .iter()
                        .find(|v| v.mID == player_id || v.mIsPlayer != 0);

                    let current_lap = player_sc
                        .map(|v| v.mTotalLaps as i32)
                        .unwrap_or(0);

                    let in_pits = player_sc
                        .map(|v| v.mInPits != 0)
                        .unwrap_or(false);

                    let last_lap_time = player_sc
                        .map(|v| v.mLastLapTime)
                        .unwrap_or(-1.0);

                    let max_laps = sc.mScoringInfo.mMaxLaps;
                    let session_laps_remaining = if max_laps > 0 && max_laps < 999_000 {
                        (max_laps - current_lap).max(0)
                    } else {
                        -1
                    };

                    fuel_snapshot = fuel_tracker.update(current_fuel, current_lap, in_pits, session_laps_remaining, last_lap_time);
                }
            }

            let tel_msg = if send_tel {
                s.telemetry.as_ref().and_then(|t| build_telemetry_update(t, player_id, &fuel_snapshot, s.ve_history.clone(), s.ve_available))
            } else {
                None
            };

            let sc_result: Option<(ServerMessage, i32)> = if send_scoring {
                s.scoring.as_ref().map(|sc| build_scoring_update(sc, s.telemetry.as_ref()))
            } else {
                None
            };

            let session_msg = if send_session {
                s.scoring.as_ref().map(build_session_info)
            } else {
                None
            };

            let status_msg: Option<ServerMessage> = if send_scoring {
                Some(build_vehicle_status(
                    s.telemetry.as_ref(),
                    s.scoring.as_ref(),
                    s.rules.as_ref(),
                    player_id,
                ))
            } else {
                None
            };

            let electronics_msg: Option<ServerMessage> = if send_electronics {
                Some(build_electronics_update(&s.electronics))
            } else {
                None
            };

            // Lap tracker: detect S/F crossings and build AllDriversUpdate.
            // Called inside the lock to avoid cloning large buffers.
            let all_drivers_result: Option<(ServerMessage, bool)> = if send_scoring {
                if let Some(ref sc) = s.scoring {
                    let session_type = session_type_str(sc.mScoringInfo.mSession);
                    let any_new = lap_tracker.process(sc, s.telemetry.as_ref());
                    let first_snapshot = !had_drivers_snapshot && lap_tracker.has_snapshots();
                    if lap_tracker.has_snapshots() {
                        lap_tracker
                            .build_message(session_type, sc.mScoringInfo.mCurrentET)
                            .map(|m| (m, any_new || first_snapshot))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            (tel_msg, sc_result, session_msg, electronics_msg, status_msg, all_drivers_result)
        };
        // Lock released — now broadcast without holding it.

        if let Some((sc_msg, pid)) = sc_result {
            player_id = pid;
            ws.broadcast(sc_msg);
            last_scoring = now;
        }

        if let Some(msg) = status_msg {
            ws.broadcast(msg);
        }

        if let Some(msg) = tel_msg {
            ws.broadcast(msg);
            last_tel = now;
        }

        if let Some(msg) = session_msg {
            ws.broadcast(msg);
            last_session = now;
        }

        if let Some(msg) = electronics_msg {
            ws.broadcast(msg);
            last_electronics = now;
        }

        // AllDriversUpdate: always update watch (for on-connect sends),
        // broadcast to connected clients on lap crossing or initial populate.
        if let Some((all_drivers_msg, should_broadcast)) = all_drivers_result {
            had_drivers_snapshot = true;
            if should_broadcast {
                // Clone before moving into watch so we can also broadcast.
                let _ = all_drivers_tx.send(Some(all_drivers_msg.clone()));
                ws.broadcast(all_drivers_msg);
            } else {
                // Update the watch silently (position/gap refreshes).
                let _ = all_drivers_tx.send(Some(all_drivers_msg));
            }
        }

        // --- Race engineer 10 Hz tick ---
        if now.duration_since(last_engineer_tick) >= Duration::from_millis(100) {
            last_engineer_tick = now;

            let s = state.read().await;
            if s.is_connected {
                let safety_car_active = s.rules.as_ref()
                    .map(|r| r.mRules.mSafetyCarActive != 0)
                    .unwrap_or(false);
                let ve_available = s.ve_available;

                let mut aggregator = engineer_service.aggregator.lock().await;
                let current = aggregator.build_state(
                    s.scoring.as_ref(),
                    s.telemetry.as_ref(),
                    &fuel_snapshot,
                    safety_car_active,
                    ve_available,
                );
                drop(s); // release read lock before dispatcher

                let prev = aggregator.previous().cloned();
                let mut dispatcher = engineer_service.dispatcher.lock().await;
                let events = dispatcher.tick(&current, prev.as_ref());
                let active_voice = dispatcher.behavior.active_voice.clone();
                drop(dispatcher);

                aggregator.advance(current);
                drop(aggregator);

                // TTS synthesis for rule-fired events.
                for event in events {
                    let text = match engineer_templates.render(event.template_key, &event.params) {
                        Some(t) => t,
                        None => {
                            warn!(
                                "Engineer: unknown template key '{}' for rule '{}'",
                                event.template_key, event.rule_id
                            );
                            continue;
                        }
                    };

                    let voice_id = match active_voice.clone() {
                        Some(v) => v,
                        None => {
                            warn!(
                                "Engineer: no active voice set — dropping event rule='{}'",
                                event.rule_id
                            );
                            continue;
                        }
                    };

                    info!(
                        "Processing event: rule={} text={}",
                        event.rule_id, text
                    );

                    let priority_str = event.priority.as_str().to_string();
                    let rule_id = event.rule_id;
                    let svc = engineer_service.clone();
                    let audio_tx = audio_broadcaster.clone();

                    tokio::spawn(async move {
                        use crate::race_engineer::audio::{pcm_to_wav, wav_to_base64};
                        use crate::race_engineer::tts_engine::{SynthesisRequest, TtsError};

                        let req = SynthesisRequest {
                            text: text.clone(),
                            voice_id,
                        };
                        let mut engine = svc.engine.lock().await;
                        match engine.synthesize(req).await {
                            Ok(result) => {
                                let wav = pcm_to_wav(&result.pcm, result.sample_rate);
                                let wav_base64 = wav_to_base64(&wav);
                                let n = audio_tx.receiver_count();
                                info!("Engineer audio broadcast to {n} audio clients");
                                let _ = audio_tx.send(Arc::new(ServerMessage::EngineerAudio {
                                    request_id: format!("rule_{rule_id}"),
                                    priority: priority_str,
                                    wav_base64,
                                    sample_rate: result.sample_rate,
                                    duration_ms: result.duration_ms,
                                    text,
                                }));
                            }
                            Err(TtsError::VoiceNotInstalled(id)) => {
                                warn!("Engineer synthesis failed (rule={rule_id}): voice not installed: {id}");
                            }
                            Err(TtsError::PiperNotInstalled) => {
                                warn!("Engineer synthesis failed (rule={rule_id}): piper not installed");
                            }
                            Err(e) => {
                                warn!("Engineer synthesis failed (rule={rule_id}): {e}");
                            }
                        }
                    });
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let config = Config::parse();

    // Single-instance guard: if the port already responds, check whether it is
    // the same version or an older one.
    //  • Same/newer version already running → exit silently (no duplicate tab).
    //  • Older version running → signal it to shut down, wait for the port to
    //    free up, then fall through to start the new server normally.
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", config.ws_port).parse()?;
    if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
        let version_url = format!("http://127.0.0.1:{}/api/version", config.ws_port);
        let running_version = ureq::get(&version_url)
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
            .and_then(|j| j["version"].as_str().map(|v| v.to_string()));

        let older_version_running = running_version
            .as_deref()
            .map(|v| version_older(v, env!("CARGO_PKG_VERSION")))
            .unwrap_or(false);

        if older_version_running {
            // Shut down the old instance and wait for the port to become free.
            let shutdown_url = format!("http://127.0.0.1:{}/api/shutdown", config.ws_port);
            let _ = ureq::post(&shutdown_url).call();

            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                std::thread::sleep(Duration::from_millis(200));
                if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_err() {
                    break; // Port is free — we can take over.
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(()); // Old process didn't exit in time — give up.
                }
            }
            // Fall through: start the server normally and open the browser below.
        } else {
            // Same or newer version already running — exit silently.
            return Ok(());
        }
    }

    // Determine exe directory for the log file
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    // Overwrite log file each run (delete if exists, then recreate)
    let log_path = exe_dir.join("lmu-pitwall.log");
    let _ = std::fs::remove_file(&log_path);

    let file_appender = tracing_appender::rolling::never(&exe_dir, "lmu-pitwall.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);

    {
        use tracing_subscriber::{fmt, prelude::*, EnvFilter};
        tracing_subscriber::registry()
            .with(
                fmt::layer()
                    .with_writer(std::io::stdout)
                    .with_filter(EnvFilter::new(&config.log_level)),
            )
            .with(
                fmt::layer()
                    .with_writer(file_writer)
                    .with_ansi(false)
                    .with_filter(EnvFilter::new("debug")),
            )
            .init();
    }

    info!("LMU Bridge v{}", env!("CARGO_PKG_VERSION"));
    info!(
        "Config: port={} telemetry_fps={} scoring_fps={}",
        config.ws_port, config.telemetry_fps, config.scoring_fps
    );

    // Watch channel for latest AllDriversUpdate (sent to new clients on connect).
    let (all_drivers_tx, all_drivers_rx) =
        tokio::sync::watch::channel::<Option<ServerMessage>>(None);

    // Watch channel for VersionInfo (sent to new clients on connect once check completes).
    let (version_info_tx, version_info_rx) =
        tokio::sync::watch::channel::<Option<ServerMessage>>(None);

    let state = Arc::new(RwLock::new(TelemetryState::new()));
    let engineer_service = Arc::new(race_engineer::RaceEngineerService::new());
    let ws    = Arc::new(WebSocketServer::new(config.ws_port, all_drivers_rx, version_info_rx, engineer_service.clone()));

    // Task 1 + 3: Shared memory polling + health check
    {
        let state = state.clone();
        let ws    = ws.clone();
        let port  = config.ws_port;
        tokio::spawn(async move { task_polling(state, ws, port).await });
    }

    // Task 2: Rate-limited WebSocket broadcaster
    {
        let state           = state.clone();
        let ws              = ws.clone();
        let tel_fps         = config.telemetry_fps;
        let scoring_fps     = config.scoring_fps;
        let engineer_svc    = engineer_service.clone();
        tokio::spawn(async move {
            task_broadcaster(state, ws, tel_fps, scoring_fps, all_drivers_tx, engineer_svc).await
        });
    }

    // Combined HTTP + WebSocket server
    {
        let ws   = ws.clone();
        let port = config.ws_port;
        tokio::spawn(async move {
            if let Err(e) = http_server::run(ws, port).await {
                tracing::error!("HTTP server error: {}", e);
            }
        });
    }

    // Optionally open the browser after a short delay to let the server bind.
    if !config.no_browser {
        let url = format!("http://localhost:{}", config.ws_port);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Err(e) = open::that(&url) {
                warn!("Could not open browser ({}): {}", url, e);
            } else {
                info!("Opened browser at {}", url);
            }
        });
    }

    // GitHub update check — runs once in background, broadcasts VersionInfo.
    {
        let ws_broadcaster = ws.broadcaster();
        tokio::spawn(async move {
            // Small delay so startup completes before the HTTP call.
            tokio::time::sleep(Duration::from_secs(3)).await;

            let current = env!("CARGO_PKG_VERSION").to_string();
            let result = tokio::task::spawn_blocking(|| check_github_version()).await;

            let msg = match result {
                Ok(Ok((latest, download_url))) => {
                    let update_available = version_older(&current, &latest);
                    info!(
                        "Version check: current={} latest={} update_available={}",
                        current, latest, update_available
                    );
                    ServerMessage::VersionInfo {
                        current_version: current,
                        latest_version: latest,
                        download_url,
                        update_available,
                    }
                }
                Ok(Err(e)) => {
                    warn!("GitHub version check failed: {}", e);
                    return;
                }
                Err(e) => {
                    warn!("GitHub version check task panicked: {}", e);
                    return;
                }
            };

            let _ = version_info_tx.send(Some(msg.clone()));
            ws_broadcaster.send(std::sync::Arc::new(msg)).ok();
        });
    }

    // Auto-shutdown when the browser window is closed.
    //
    // Waits for the first client to connect, then watches the client count.
    // When the count drops to 0 (last tab closed), a 45-second grace period
    // starts so that a normal page refresh doesn't trigger a shutdown.
    // If no client reconnects within that window, the process exits.
    {
        let count_rx = ws.client_count_rx();
        tokio::spawn(async move {
            auto_shutdown(count_rx).await;
            info!("Auto-shutdown: browser closed — goodbye.");
            std::process::exit(0);
        });
    }

    // Graceful shutdown: wait for Ctrl+C (auto-shutdown uses process::exit).
    tokio::signal::ctrl_c().await?;
    info!("Shutting down LMU Bridge — goodbye.");

    Ok(())
}

// ---------------------------------------------------------------------------
// Auto-shutdown: exit when all browser tabs have been closed
// ---------------------------------------------------------------------------

/// Fetch the latest release from GitHub and return (version, download_url).
/// Strips the leading "v" from the tag name if present.
/// Blocking — must be called via `spawn_blocking`.
fn check_github_version() -> anyhow::Result<(String, String)> {
    let response = ureq::get("https://api.github.com/repos/Swizzjack/lmu-pitwall/releases/latest")
        .set("User-Agent", concat!("lmu-pitwall/", env!("CARGO_PKG_VERSION")))
        .set("Accept", "application/vnd.github.v3+json")
        .call()?;

    let json: serde_json::Value = response.into_json()?;

    let tag = json["tag_name"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing tag_name in GitHub response"))?;
    let version = tag.trim_start_matches('v').to_string();

    let download_url = json["html_url"]
        .as_str()
        .unwrap_or("https://github.com/Swizzjack/lmu-pitwall/releases/latest")
        .to_string();

    Ok((version, download_url))
}

/// Returns `true` if version string `a` is strictly older than `b`.
/// Compares "MAJOR.MINOR.PATCH" numerically; non-numeric parts are treated as 0.
fn version_older(a: &str, b: &str) -> bool {
    fn parse(v: &str) -> (u32, u32, u32) {
        let mut parts = v.split('.');
        let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    }
    parse(a) < parse(b)
}

/// Grace period after the last client disconnects before the process exits.
/// Long enough to survive a normal browser refresh (typically < 3 s).
const AUTO_SHUTDOWN_GRACE_SECS: u64 = 45;

async fn auto_shutdown(mut count_rx: watch::Receiver<usize>) {
    // Phase 1: wait until at least one client has ever connected.
    // Without this, the process would exit immediately on startup (count = 0).
    loop {
        if *count_rx.borrow() > 0 {
            break;
        }
        if count_rx.changed().await.is_err() {
            return; // channel closed → server shutting down anyway
        }
    }

    // Phase 2: watch for the last client to disconnect, then start the timer.
    loop {
        // Wait for count to reach zero.
        loop {
            if count_rx.changed().await.is_err() {
                return;
            }
            if *count_rx.borrow() == 0 {
                break;
            }
        }

        // Count is 0. Start grace-period timer; cancel if a new client arrives.
        let grace = tokio::time::sleep(Duration::from_secs(AUTO_SHUTDOWN_GRACE_SECS));
        tokio::pin!(grace);

        loop {
            tokio::select! {
                _ = &mut grace => {
                    // Grace period expired with no reconnect → shut down.
                    return;
                }
                result = count_rx.changed() => {
                    if result.is_err() { return; }
                    if *count_rx.borrow() > 0 {
                        // A new client connected — cancel the timer.
                        break;
                    }
                    // Still 0 (spurious wake) — keep waiting.
                }
            }
        }
    }
}
