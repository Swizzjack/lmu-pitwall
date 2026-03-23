// On Windows: suppress the console window entirely (GUI subsystem)
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod app_config;
mod assets;
mod config;
mod electronics;
mod fuel;
mod garage_api;
mod http_server;
mod input;
mod lap_tracker;
mod protocol;
mod rest_api;
mod shared_memory;
mod websocket;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use clap::Parser;
use tokio::sync::{RwLock, watch};
use tokio::time::MissedTickBehavior;
use tracing::{info, warn};

use app_config::{AppConfig, ButtonBinding};
use config::Config;
use electronics::{ElectronicsSnapshot, ElectronicsTracker};
use fuel::{FuelSnapshot, FuelTracker};
use lap_tracker::LapTracker;
use garage_api::{GarageData, GameState};
use input::{InputMonitor, JoystickControllerInfo, start_joystick_poller};
use protocol::messages::{ClientCommand, ControllerDiag, InputEventDiag, ServerMessage, TireData, Vec3, VehicleScoring, WeatherData};
use shared_memory::reader::SharedMemoryReader;
use shared_memory::types::{bytes_to_str, rF2RulesBuffer, rF2ScoringBuffer, rF2TelemetryBuffer, LmuExtendedBuffer, MAX_MAPPED_VEHICLES};

static LAST_DELTA_LOG: AtomicU64 = AtomicU64::new(0);
use websocket::server::WebSocketServer;

// ---------------------------------------------------------------------------
// Shared state — written by polling task, read by broadcaster task
// ---------------------------------------------------------------------------

struct TelemetryState {
    telemetry: Option<rF2TelemetryBuffer>,
    scoring: Option<rF2ScoringBuffer>,
    lmu_extended: Option<LmuExtendedBuffer>,
    rules: Option<rF2RulesBuffer>,
    is_connected: bool,
    electronics: ElectronicsSnapshot,
    /// Per-lap VE history from strategy/usage REST API; None = data unavailable.
    ve_history: Option<Vec<f64>>,
    /// Whether this car supports Virtual Energy (from VM_VIRTUAL_ENERGY.available in garage API).
    /// None = not yet fetched.
    ve_available: Option<bool>,
}

impl TelemetryState {
    fn new() -> Self {
        Self {
            telemetry: None,
            scoring: None,
            lmu_extended: None,
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
///
/// `sc` is used to compute delta_best: mDeltaBest does not exist in the standard rF2 MMF.
/// We approximate it as: current_lap_time − (best_lap_time × lap_progress), where
/// lap_progress = player.mLapDist / track_length.  This is a linear interpolation and
/// becomes accurate only once the driver has completed at least one lap.
fn build_telemetry_update(
    tel: &rF2TelemetryBuffer,
    player_id: i32,
    sc: Option<&rF2ScoringBuffer>,
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

    // --- delta_best calculation ---
    // Copy packed-struct fields to locals first (avoids unaligned-reference UB in macros)
    let elapsed_time  = veh.mElapsedTime;
    let lap_start_et  = veh.mLapStartET;
    let current_lap_time = elapsed_time - lap_start_et;

    let delta_best = sc
        .and_then(|sc| {
            let info = &sc.mScoringInfo;
            let track_len = info.mLapDist;
            if track_len <= 0.0 {
                return None;
            }
            let sc_num = (info.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
            // Find the player vehicle in scoring (match by ID or mIsPlayer flag)
            let player_sc = sc.mVehicles[..sc_num]
                .iter()
                .find(|v| v.mID == player_id || v.mIsPlayer != 0)?;

            let best_lap = player_sc.mBestLapTime;
            if best_lap <= 0.0 {
                return None; // no best lap yet
            }
            let progress = (player_sc.mLapDist / track_len).clamp(0.0, 1.0);
            Some(current_lap_time - best_lap * progress)
        })
        .unwrap_or(0.0);

    // Debug log every 5 seconds (throttled via AtomicU64 second-counter)
    let now_secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last = LAST_DELTA_LOG.load(Ordering::Relaxed);
    if now_secs.saturating_sub(last) >= 5 {
        LAST_DELTA_LOG.store(now_secs, Ordering::Relaxed);
        tracing::debug!(
            "delta_best={:.3}s  current_lap={:.3}s  lap_start_et={:.3}s  elapsed={:.3}s",
            delta_best,
            current_lap_time,
            lap_start_et,
            elapsed_time,
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
            temp_inner: veh.mWheels[i].mTemperature[0] - 273.15,
            temp_mid:   veh.mWheels[i].mTemperature[1] - 273.15,
            temp_outer: veh.mWheels[i].mTemperature[2] - 273.15,
            pressure:   veh.mWheels[i].mPressure,
            wear:       veh.mWheels[i].mWear,
            brake_temp: veh.mWheels[i].mBrakeTemp,
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
fn build_scoring_update(sc: &rF2ScoringBuffer) -> (ServerMessage, i32) {
    let info = &sc.mScoringInfo;
    let num = (info.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
    let mut player_id = -1i32;

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

fn build_electronics_update(
    snap: &ElectronicsSnapshot,
    lmu: Option<&LmuExtendedBuffer>,
    rear_brake_bias: f64,
) -> ServerMessage {
    let (battery_pct, energy_pct) = lmu
        .map(|l| {
            let bat = if l.mMaxBatteryValue > 0.0 {
                (l.mCurrentBatteryValue / l.mMaxBatteryValue).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let eng = if l.mMaxEnergyValue > 0.0 {
                (l.mCurrentEnergyValue / l.mMaxEnergyValue).clamp(0.0, 1.0)
            } else {
                0.0
            };
            (bat, eng)
        })
        .unwrap_or((0.0, 0.0));

    ServerMessage::ElectronicsUpdate {
        tc:                  snap.tc,
        tc_cut:              snap.tc_cut,
        tc_slip:             snap.tc_slip,
        abs:                 snap.abs,
        engine_map:          snap.engine_map,
        front_arb:           snap.front_arb,
        rear_arb:            snap.rear_arb,
        brake_bias:          snap.brake_bias,
        regen:               snap.regen,
        brake_migration:     snap.brake_migration,
        brake_migration_max: snap.brake_migration_max,
        brake_bias_front:    (1.0 - rear_brake_bias).clamp(0.0, 1.0),
        battery_pct,
        energy_pct,
        buttons_configured:  snap.buttons_configured,
        garage_labels:       snap.garage_labels.clone(),
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
    let (yellow_flag_state, sector_flags, start_light, game_phase, player_flag, player_under_yellow, player_sector) =
        sc.map(|sc| {
            let info = &sc.mScoringInfo;
            let num = (info.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
            let (pflag, punder, psector) = sc.mVehicles[..num]
                .iter()
                .find(|v| v.mID == player_id || v.mIsPlayer != 0)
                .map(|v| (v.mFlag, v.mUnderYellow != 0, v.mSector))
                .unwrap_or((0, false, -1));
            // NOTE: Do NOT derive player_under_yellow from mSectorFlag — LMU leaves
            // mSectorFlag non-zero even during green-flag conditions, which would
            // cause a permanent false yellow. Use mUnderYellow exclusively.
            // The raw sector flags are forwarded to the frontend so it can decide.
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
                punder,
                psector as i32,
            )
        })
        .unwrap_or((-1, [0; 3], 0, 0, 0, false, -1));

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
        player_under_yellow,
        player_sector,
        safety_car_active,
        safety_car_exists,
    }
}

// ---------------------------------------------------------------------------
// Capture state for interactive button binding
// ---------------------------------------------------------------------------

struct CaptureState {
    binding_id:       String,
    initial_keyboard: HashSet<i32>,
    initial_joystick: HashMap<u32, u128>,
    started_at:       Instant,
}

/// Broadcast the current config state to all connected clients.
async fn broadcast_config_state(ws: &WebSocketServer, app_config: &RwLock<AppConfig>) {
    let cfg = app_config.read().await;
    ws.broadcast(ServerMessage::ConfigState {
        bindings: cfg.electronics_bindings.to_map(),
        defaults: cfg.electronics_defaults.clone(),
    });
}

fn info_to_diag(info: Vec<JoystickControllerInfo>) -> Vec<ControllerDiag> {
    info.into_iter()
        .map(|c| ControllerDiag {
            index: c.index,
            name: c.name,
            button_count: c.button_count,
            connected: c.connected,
        })
        .collect()
}

fn make_event_diag(
    event: input::ElectronicsEvent,
    bindings: &app_config::ElectronicsBindings,
    bridge_start: &std::time::Instant,
) -> InputEventDiag {
    use input::ElectronicsEvent::*;
    use app_config::ButtonBinding;

    let (opt_binding, mapped_to): (&Option<ButtonBinding>, &str) = match event {
        TcIncrease             => (&bindings.tc_increase,                "tc_increase"),
        TcDecrease             => (&bindings.tc_decrease,                "tc_decrease"),
        TcCutIncrease          => (&bindings.tc_cut_increase,            "tc_cut_increase"),
        TcCutDecrease          => (&bindings.tc_cut_decrease,            "tc_cut_decrease"),
        TcSlipIncrease         => (&bindings.tc_slip_increase,           "tc_slip_increase"),
        TcSlipDecrease         => (&bindings.tc_slip_decrease,           "tc_slip_decrease"),
        AbsIncrease            => (&bindings.abs_increase,               "abs_increase"),
        AbsDecrease            => (&bindings.abs_decrease,               "abs_decrease"),
        EngineMapIncrease      => (&bindings.engine_map_increase,        "engine_map_increase"),
        EngineMapDecrease      => (&bindings.engine_map_decrease,        "engine_map_decrease"),
        FrontArbIncrease       => (&bindings.farb_increase,              "farb_increase"),
        FrontArbDecrease       => (&bindings.farb_decrease,              "farb_decrease"),
        RearArbIncrease        => (&bindings.rarb_increase,              "rarb_increase"),
        RearArbDecrease        => (&bindings.rarb_decrease,              "rarb_decrease"),
        BrakeBiasIncrease      => (&bindings.brake_bias_increase,        "brake_bias_increase"),
        BrakeBiasDecrease      => (&bindings.brake_bias_decrease,        "brake_bias_decrease"),
        RegenIncrease          => (&bindings.regen_increase,             "regen_increase"),
        RegenDecrease          => (&bindings.regen_decrease,             "regen_decrease"),
        BrakeMigrationIncrease => (&bindings.brake_migration_increase,   "brake_migration_increase"),
        BrakeMigrationDecrease => (&bindings.brake_migration_decrease,   "brake_migration_decrease"),
    };

    let (source, input_name) = match opt_binding {
        Some(ButtonBinding::Keyboard { key }) => ("keyboard".to_string(), key.clone()),
        Some(ButtonBinding::Joystick { device_index, button }) => (
            format!("joystick:{}", device_index),
            format!("Button {}", button),
        ),
        None => ("unknown".to_string(), "?".to_string()),
    };

    InputEventDiag {
        timestamp_ms: bridge_start.elapsed().as_millis() as u64,
        source,
        input: input_name,
        action: "pressed".to_string(),
        mapped_to: mapped_to.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Task 1 + 3: Shared memory polling (50 Hz) + health check / reconnect (0.5 Hz)
//
// Owns the SharedMemoryReader. Writes into Arc<RwLock<TelemetryState>>.
// Broadcasts ConnectionStatus events via the WebSocket server.
// Also handles ClientCommands for button binding and config management.
// ---------------------------------------------------------------------------

async fn task_polling(
    state: Arc<RwLock<TelemetryState>>,
    ws: Arc<WebSocketServer>,
    ws_port: u16,
    app_config: Arc<RwLock<AppConfig>>,
    config_path: String,
    mut cmd_rx: tokio::sync::mpsc::Receiver<ClientCommand>,
) {
    let bridge_start = std::time::Instant::now();

    let mut reader = SharedMemoryReader::new();
    let mut was_connected = false;

    let (mut input_monitor, mut elec_tracker, mut buttons_configured, mut _joy_poller, mut joy_rx, mut controllers_diag, mut cached_bindings) = {
        let cfg = app_config.read().await;
        let (jp, jr, ctrl_info) = start_joystick_poller(&cfg.electronics_bindings);
        (
            InputMonitor::new(&cfg.electronics_bindings),
            ElectronicsTracker::new(&cfg.electronics_defaults),
            cfg.electronics_bindings.any_configured(),
            jp,
            jr,
            info_to_diag(ctrl_info),
            cfg.electronics_bindings.clone(),
        )
    };

    let mut diag_events: VecDeque<InputEventDiag> = VecDeque::new();

    let mut diag_ticker = tokio::time::interval(Duration::from_millis(500));
    diag_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut capture: Option<CaptureState> = None;

    // Track session identity for reset detection: "<session_type>/<track_name>"
    let mut last_session_key = String::new();
    // Track player pit state for garage API trigger (fallback).
    let mut last_player_in_pits = false;
    // Track MultiStintState for garage sync on "DRIVING" transition.
    let mut last_multi_stint_state = String::new();

    // Channel for garage API fetch results (blocking task → select! arm).
    let (garage_tx, mut garage_rx) = tokio::sync::mpsc::channel::<GarageData>(4);
    // Channel for GetGameState results (2 Hz poll → select! arm).
    let (game_state_tx, mut game_state_rx) = tokio::sync::mpsc::channel::<GameState>(4);
    // Channel for strategy/usage VE fetch results.
    let (strategy_tx, mut strategy_rx) = tokio::sync::mpsc::channel::<Vec<f64>>(4);

    let mut poll_ticker = tokio::time::interval(Duration::from_millis(20)); // 50 Hz
    poll_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Health check fires immediately on first tick, then every 2 seconds.
    let mut health_ticker = tokio::time::interval(Duration::from_secs(2));
    health_ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    // GetGameState poll at 2 Hz to detect MultiStintState transitions.
    let mut game_state_ticker = tokio::time::interval(Duration::from_millis(500));
    game_state_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

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
                // If in capture mode: scan for new button/key press.
                // This runs regardless of whether the game is connected so that
                // users can configure bindings without an active LMU session.
                // Clone capture data first to avoid borrow conflict when clearing.
                let capture_info = capture.as_ref().map(|c| (
                    c.binding_id.clone(),
                    c.initial_keyboard.clone(),
                    c.initial_joystick.clone(),
                    c.started_at,
                ));

                if let Some((binding_id, init_kb, init_js, started_at)) = capture_info {
                    if started_at.elapsed() >= Duration::from_secs(10) {
                        capture = None;
                        ws.broadcast(ServerMessage::BindingTimeout { binding_id });
                    } else {
                        // Check keyboard first
                        let pressed = input::scan_pressed_vks();
                        let new_vk = pressed.difference(&init_kb).next().copied();

                        if let Some(vk) = new_vk {
                            if let Some(key_name) = input::vk_to_name(vk) {
                                let binding = ButtonBinding::Keyboard { key: key_name.to_string() };
                                {
                                    let mut cfg = app_config.write().await;
                                    cfg.electronics_bindings.set_binding(&binding_id, Some(binding.clone()));
                                    buttons_configured = cfg.electronics_bindings.any_configured();
                                    input_monitor = InputMonitor::new(&cfg.electronics_bindings);
                                    let (jp, jr, ctrl_info) = start_joystick_poller(&cfg.electronics_bindings);
                                    _joy_poller = jp;
                                    joy_rx = jr;
                                    controllers_diag = info_to_diag(ctrl_info);
                                    cached_bindings = cfg.electronics_bindings.clone();
                                }
                                capture = None;
                                ws.broadcast(ServerMessage::BindingCaptured {
                                    binding_id: binding_id.clone(),
                                    binding,
                                });
                                ws.broadcast(build_electronics_update(
                                    &elec_tracker.snapshot(buttons_configured), None, 0.5,
                                ));
                                broadcast_config_state(&ws, &app_config).await;
                            }
                        } else {
                            // Check joystick
                            let current_js = input::scan_all_devices();
                            let mut found: Option<(u32, u32)> = None;
                            for (&device_index, &current_mask) in &current_js {
                                let init_mask = init_js.get(&device_index).copied().unwrap_or(0);
                                let new_bits = current_mask & !init_mask;
                                if new_bits != 0 {
                                    // trailing_zeros() gives the bit index (0-based).
                                    // Add 1 to convert to 1-based button number (HID Usage = bit+1).
                                    found = Some((device_index, new_bits.trailing_zeros() + 1));
                                    break;
                                }
                            }
                            if let Some((device_index, button)) = found {
                                let binding = ButtonBinding::Joystick { device_index, button };
                                {
                                    let mut cfg = app_config.write().await;
                                    cfg.electronics_bindings.set_binding(&binding_id, Some(binding.clone()));
                                    buttons_configured = cfg.electronics_bindings.any_configured();
                                    input_monitor = InputMonitor::new(&cfg.electronics_bindings);
                                    let (jp, jr, ctrl_info) = start_joystick_poller(&cfg.electronics_bindings);
                                    _joy_poller = jp;
                                    joy_rx = jr;
                                    controllers_diag = info_to_diag(ctrl_info);
                                    cached_bindings = cfg.electronics_bindings.clone();
                                }
                                capture = None;
                                ws.broadcast(ServerMessage::BindingCaptured {
                                    binding_id: binding_id.clone(),
                                    binding,
                                });
                                ws.broadcast(build_electronics_update(
                                    &elec_tracker.snapshot(buttons_configured), None, 0.5,
                                ));
                                broadcast_config_state(&ws, &app_config).await;
                            }
                        }
                    }
                    // During capture: advance keyboard state but ignore events.
                    // Drain joystick channel so stale events don't fire after capture ends.
                    input_monitor.poll_keyboard_only();
                    while joy_rx.try_recv().is_ok() {}
                } else {
                    // Normal mode: keyboard events at 50 Hz, joystick at 500 Hz via channel.
                    let kb_events = input_monitor.poll_keyboard_only();
                    for event in kb_events {
                        // Log to diagnostics ring buffer (max 20 entries)
                        let diag = make_event_diag(event, &cached_bindings, &bridge_start);
                        if diag_events.len() >= 20 { diag_events.pop_front(); }
                        diag_events.push_back(diag);
                        elec_tracker.apply_event(event);
                    }
                    while let Ok(event) = joy_rx.try_recv() {
                        // Log to diagnostics ring buffer (max 20 entries)
                        let diag = make_event_diag(event, &cached_bindings, &bridge_start);
                        if diag_events.len() >= 20 { diag_events.pop_front(); }
                        diag_events.push_back(diag);
                        elec_tracker.apply_event(event);
                    }
                }

                let elec_snap = elec_tracker.snapshot(buttons_configured);

                // Shared memory reads only make sense when the game is running.
                if !reader.is_connected() {
                    let mut s = state.write().await;
                    s.electronics = elec_snap;
                    continue;
                }

                let tel   = reader.read_telemetry();
                let sc    = reader.read_scoring();
                let lmu   = reader.read_lmu_extended();
                let rules = reader.read_rules();

                // Sync electronics from DMA when available.
                // Fields with button bindings are skipped — the button counter is
                // authoritative for those. DMA only fills in un-bound controls.
                if let Some(ref lmu_data) = lmu {
                    let rear_bb = tel.as_ref()
                        .and_then(|t| {
                            if t.mNumVehicles > 0 { Some(t.mVehicles[0].mRearBrakeBias) } else { None }
                        })
                        .unwrap_or(0.5);
                    elec_tracker.sync_from_dma(lmu_data, rear_bb, &cached_bindings);
                }

                // Session-change detection → reset electronics + trigger garage fetch.
                if let Some(ref sc_data) = sc {
                    let key = format!(
                        "{}/{}",
                        sc_data.mScoringInfo.mSession,
                        bytes_to_str(&sc_data.mScoringInfo.mTrackName),
                    );
                    if !last_session_key.is_empty() && key != last_session_key {
                        elec_tracker.reset();
                        info!("Session changed — electronics reset, fetching garage data");
                        let tx = garage_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Some(data) = garage_api::fetch_garage_data() {
                                let _ = tx.blocking_send(data);
                            }
                        });
                        // Clear cached VE on session change.
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

                    // Pit exit detection: mInPits true → false triggers garage fetch.
                    let num_vehs = (sc_data.mScoringInfo.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                    let cur_in_pits = sc_data.mVehicles[..num_vehs]
                        .iter()
                        .find(|v| v.mIsPlayer != 0)
                        .map(|v| v.mInPits != 0)
                        .unwrap_or(false);
                    if last_player_in_pits && !cur_in_pits {
                        info!("Pit exit detected, re-syncing garage values...");
                        let tx = garage_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            // Wait 500 ms so the LMU REST API reflects the
                            // garage changes made before driving out.
                            std::thread::sleep(Duration::from_millis(500));
                            if let Some(data) = garage_api::fetch_garage_data() {
                                let _ = tx.blocking_send(data);
                            }
                        });
                    }
                    last_player_in_pits = cur_in_pits;
                }

                let mut s = state.write().await;
                s.telemetry    = tel;
                s.scoring      = sc;
                s.lmu_extended = lmu;
                s.rules        = rules;
                s.electronics  = elec_tracker.snapshot(buttons_configured);
            }

            // --- Garage API fetch result ---
            Some(data) = garage_rx.recv() => {
                info!("Garage data applied to electronics tracker");
                elec_tracker.apply_garage_data(&data);
                let mut s = state.write().await;
                s.electronics  = elec_tracker.snapshot(buttons_configured);
                s.ve_available = data.ve_available;
            }

            // --- 2 Hz GetGameState poll ---
            _ = game_state_ticker.tick() => {
                if reader.is_connected() {
                    let tx = game_state_tx.clone();
                    tokio::task::spawn_blocking(move || {
                        if let Some(gs) = garage_api::fetch_game_state() {
                            let _ = tx.blocking_send(gs);
                        }
                    });
                }
            }

            // --- GetGameState result: sync garage on DRIVING transition ---
            Some(gs) = game_state_rx.recv() => {
                let cur = gs.multi_stint_state;
                if cur != last_multi_stint_state {
                    info!("MultiStintState changed: '{}' → '{}'", last_multi_stint_state, cur);
                    if cur == "DRIVING" {
                        info!("MultiStintState → DRIVING, syncing garage values...");
                        let tx = garage_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            std::thread::sleep(Duration::from_millis(500));
                            if let Some(data) = garage_api::fetch_garage_data() {
                                let _ = tx.blocking_send(data);
                            }
                        });
                    }
                    last_multi_stint_state = cur;
                }
            }

            // --- Client commands (from WebSocket text frames) ---
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    ClientCommand::StartBindingCapture { binding_id } => {
                        let initial_keyboard = input::scan_pressed_vks();
                        let initial_joystick = input::scan_all_devices();
                        info!("Binding capture started for '{}'", binding_id);
                        capture = Some(CaptureState {
                            binding_id,
                            initial_keyboard,
                            initial_joystick,
                            started_at: Instant::now(),
                        });
                    }
                    ClientCommand::CancelBindingCapture => {
                        if let Some(ref cap) = capture {
                            info!("Binding capture cancelled for '{}'", cap.binding_id);
                        }
                        capture = None;
                    }
                    ClientCommand::ClearBinding { binding_id } => {
                        {
                            let mut cfg = app_config.write().await;
                            cfg.electronics_bindings.set_binding(&binding_id, None);
                            buttons_configured = cfg.electronics_bindings.any_configured();
                            input_monitor = InputMonitor::new(&cfg.electronics_bindings);
                            let (jp, jr, ctrl_info) = start_joystick_poller(&cfg.electronics_bindings);
                            _joy_poller = jp;
                            joy_rx = jr;
                            controllers_diag = info_to_diag(ctrl_info);
                            cached_bindings = cfg.electronics_bindings.clone();
                        }
                        info!("Binding '{}' cleared", binding_id);
                        ws.broadcast(build_electronics_update(
                            &elec_tracker.snapshot(buttons_configured), None, 0.5,
                        ));
                        broadcast_config_state(&ws, &app_config).await;
                    }
                    ClientCommand::UpdateDefaults { defaults } => {
                        {
                            let mut cfg = app_config.write().await;
                            cfg.electronics_defaults = defaults.clone();
                        }
                        elec_tracker.update_defaults(&defaults);
                        info!("Electronics defaults updated");
                        broadcast_config_state(&ws, &app_config).await;
                    }
                    ClientCommand::SaveConfig => {
                        let (success, path) = {
                            let cfg = app_config.read().await;
                            (cfg.save(&config_path), config_path.clone())
                        };
                        info!("Config save {}: {}", if success { "OK" } else { "FAILED" }, path);
                        ws.broadcast(ServerMessage::ConfigSaved { success });
                    }
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

            // --- 2 Hz input diagnostics broadcast ---
            _ = diag_ticker.tick() => {
                let is_capture = capture.is_some();
                ws.broadcast(ServerMessage::InputDiagnostics {
                    controllers: controllers_diag.clone(),
                    recent_events: diag_events.iter().cloned().collect(),
                    capture_mode: is_capture,
                });
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
                        // Fetch initial garage data now that LMU is running.
                        let tx = garage_tx.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Some(data) = garage_api::fetch_garage_data() {
                                let _ = tx.blocking_send(data);
                            }
                        });
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
                        s.lmu_extended = None;
                        s.rules        = None;
                        s.ve_history   = None;
                        s.ve_available = None;
                        was_connected  = false;
                        last_player_in_pits = false;
                        last_multi_stint_state = String::new();
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

    // All-drivers lap snapshot tracker.
    let mut lap_tracker = LapTracker::new();
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
                s.telemetry.as_ref().and_then(|t| build_telemetry_update(t, player_id, s.scoring.as_ref(), &fuel_snapshot, s.ve_history.clone(), s.ve_available))
            } else {
                None
            };

            let sc_result: Option<(ServerMessage, i32)> = if send_scoring {
                s.scoring.as_ref().map(build_scoring_update)
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
                // Brake bias (raw) comes from telemetry; hybrid data from LMU extended buffer.
                let rear_brake_bias = s.telemetry.as_ref()
                    .and_then(|t| {
                        let num = (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
                        t.mVehicles[..num]
                            .iter()
                            .find(|v| v.mID == player_id)
                            .or_else(|| t.mVehicles.get(0))
                            .map(|v| v.mRearBrakeBias)
                    })
                    .unwrap_or(0.5);
                Some(build_electronics_update(&s.electronics, s.lmu_extended.as_ref(), rear_brake_bias))
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

    // Load the electronics button-binding config from next to the executable.
    let config_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("config.json")))
        .unwrap_or_else(|| std::path::PathBuf::from("config.json"));
    let config_path_str = config_path.to_string_lossy().into_owned();
    let app_config = Arc::new(RwLock::new(AppConfig::load_or_create(&config_path_str)));

    // Channel for client→bridge commands (WS handler → polling task).
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel::<ClientCommand>(64);

    // Watch channel for latest AllDriversUpdate (sent to new clients on connect).
    let (all_drivers_tx, all_drivers_rx) =
        tokio::sync::watch::channel::<Option<ServerMessage>>(None);

    let state = Arc::new(RwLock::new(TelemetryState::new()));
    let ws    = Arc::new(WebSocketServer::new(config.ws_port, cmd_tx, app_config.clone(), all_drivers_rx));

    // Task 1 + 3: Shared memory polling + health check + command handling
    {
        let state      = state.clone();
        let ws         = ws.clone();
        let port       = config.ws_port;
        let app_config = app_config.clone();
        let cfg_path   = config_path_str.clone();
        tokio::spawn(async move { task_polling(state, ws, port, app_config, cfg_path, cmd_rx).await });
    }

    // Task 2: Rate-limited WebSocket broadcaster
    {
        let state       = state.clone();
        let ws          = ws.clone();
        let tel_fps     = config.telemetry_fps;
        let scoring_fps = config.scoring_fps;
        tokio::spawn(async move { task_broadcaster(state, ws, tel_fps, scoring_fps, all_drivers_tx).await });
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
