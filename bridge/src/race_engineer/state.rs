use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::fuel::FuelSnapshot;
use crate::shared_memory::types::{rF2ScoringBuffer, rF2TelemetryBuffer, MAX_MAPPED_VEHICLES};

// ---------------------------------------------------------------------------
// Domain enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionType {
    Practice,
    Qualifying,
    Race,
    Unknown,
}

impl SessionType {
    pub fn from_session_id(session: i32) -> Self {
        match session {
            1..=4 | 9 => Self::Practice,
            5..=8 => Self::Qualifying,
            10..=13 => Self::Race,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Formation,
    Green,
    FullCaution,
    SafetyCar,
    RedFlag,
    Finished,
}

impl SessionPhase {
    pub fn from_game_phase(phase: u8, safety_car_active: bool) -> Self {
        if safety_car_active {
            return Self::SafetyCar;
        }
        match phase {
            0..=3 => Self::Formation,
            4 | 5 => Self::Green,
            6 => Self::FullCaution,
            7 => Self::RedFlag,
            8..=u8::MAX => Self::Finished,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CarClass {
    Hypercar,
    Lmp2,
    Lmgt3,
    Unknown,
}

impl CarClass {
    // IP_VehicleClass enum from LMU: 0=Hypercar, 3=LMP2, 5=LMGT3
    pub fn from_class_enum(v: u8) -> Self {
        match v {
            0 => Self::Hypercar,
            3 => Self::Lmp2,
            5 => Self::Lmgt3,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PitState {
    None,
    Requesting,
    Entering,
    Stopped,
    Exiting,
}

impl PitState {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Requesting,
            2 => Self::Entering,
            3 => Self::Stopped,
            4 => Self::Exiting,
            _ => Self::None,
        }
    }
}

// ---------------------------------------------------------------------------
// Sub-state structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct FlagState {
    /// Per-sector yellow flags: index 0=S1, 1=S2, 2=S3
    pub yellow_sectors: [bool; 3],
    pub blue: bool,
    pub red: bool,
    pub player_under_yellow: bool,
    /// True when the player's current sector has a yellow flag
    /// (mIndividualPhase == 10 for FCY, or sectorFlags[playerSector] == 1 for local yellow)
    pub player_in_yellow_sector: bool,
    /// Player's current sector index: 0=S1, 1=S2, 2=S3
    pub player_sector_idx: usize,
}

#[derive(Debug, Clone, Default)]
pub struct DamageState {
    pub has_aero: bool,
    pub has_suspension: bool,
    pub overheating: bool,
    pub any_detached: bool,
    pub last_impact_magnitude: f64,
}

// ---------------------------------------------------------------------------
// EngineerState — one telemetry snapshot used by all rules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct EngineerState {
    pub tick_time: Instant,

    // Session
    pub session_type: SessionType,
    pub session_phase: SessionPhase,
    /// None for time-limited sessions once timer is unknown
    pub time_remaining: Option<Duration>,
    /// None for time-limited races without a reliable lap count
    pub laps_remaining: Option<u32>,
    pub total_laps_driven: u32,

    // Player
    pub player_position: u32,
    pub player_class_position: u32,
    pub player_class: CarClass,
    pub player_lap: u32,
    pub in_pit: bool,
    pub pit_state: PitState,

    // Fuel / VE
    pub fuel_remaining_l: f32,
    pub fuel_laps_left: f32,
    /// f32::INFINITY for non-VE cars or if consumption is unknown
    pub ve_laps_left: f32,
    pub effective_laps_left: f32,

    // Timing
    pub last_lap_time: Option<Duration>,
    pub best_lap_time_personal: Option<Duration>,
    /// Min best_lap_time across all cars in session; None if no completed laps
    pub best_lap_time_session: Option<Duration>,
    pub current_lap_time: Duration,
    /// Delta per sector vs personal best (positive = slower). None if data unavailable.
    pub last_sector_deltas: [Option<f32>; 3],

    // Lap history (up to 10 recent valid laps, newest last)
    pub recent_lap_times: VecDeque<Duration>,

    // Gap in seconds to adjacent cars on track
    pub gap_ahead: Option<f32>,
    pub gap_behind: Option<f32>,

    // Flags
    pub active_flags: FlagState,

    // Tires — mid-surface temperature in Celsius; FL FR RL RR
    pub tire_temps_c: [f32; 4],
    pub tire_wear_pct: [f32; 4],

    // Damage
    pub damage: DamageState,

    // Weather
    pub ambient_temp_c: f32,
    pub track_temp_c: f32,
    /// mRaining: 0.0 = dry, 1.0 = heavy rain
    pub rain_intensity: f32,

    /// Outstanding penalties (drive-through, stop-go, etc.)
    pub num_penalties: u32,
}

impl EngineerState {
    /// True when the race is almost over and pit-related warnings are pointless.
    pub fn race_ending(&self) -> bool {
        if self.session_type != SessionType::Race { return false; }
        if let Some(laps) = self.laps_remaining {
            if laps <= 2 { return true; }
        }
        if let Some(time) = self.time_remaining {
            if time <= Duration::from_secs(180) { return true; }
        }
        false
    }
}

// ---------------------------------------------------------------------------
// LapHistoryBuffer — tracks completed laps for pace analysis and VE averaging
// ---------------------------------------------------------------------------

pub struct LapHistoryBuffer {
    pub recent: VecDeque<Duration>,
    last_total_laps: i32,
    ve_per_lap: VecDeque<f32>,
    last_ve_level: f32,
}

impl LapHistoryBuffer {
    pub fn new() -> Self {
        Self {
            recent: VecDeque::with_capacity(11),
            last_total_laps: -1,
            ve_per_lap: VecDeque::with_capacity(6),
            last_ve_level: -1.0,
        }
    }

    /// Called once per engineer tick. Returns true if a new lap was recorded.
    pub fn update(&mut self, total_laps: i32, last_lap_time: f64, ve_level: f32) -> bool {
        let new_lap = total_laps > self.last_total_laps && self.last_total_laps >= 0;

        if new_lap && last_lap_time > 0.0 {
            let dur = Duration::from_secs_f64(last_lap_time);
            if self.recent.len() >= 10 {
                self.recent.pop_front();
            }
            self.recent.push_back(dur);

            // Track VE consumption per lap
            if self.last_ve_level >= 0.0 && ve_level >= 0.0 {
                let consumed = (self.last_ve_level - ve_level).max(0.0);
                if consumed > 0.0 {
                    if self.ve_per_lap.len() >= 5 {
                        self.ve_per_lap.pop_front();
                    }
                    self.ve_per_lap.push_back(consumed);
                }
            }
        }

        if self.last_total_laps < 0 {
            self.last_total_laps = total_laps;
        } else if new_lap {
            self.last_total_laps = total_laps;
        }

        self.last_ve_level = ve_level;
        new_lap
    }

    pub fn avg_ve_per_lap(&self) -> Option<f32> {
        if self.ve_per_lap.is_empty() {
            return None;
        }
        let sum: f32 = self.ve_per_lap.iter().sum();
        Some(sum / self.ve_per_lap.len() as f32)
    }

    pub fn reset(&mut self) {
        self.recent.clear();
        self.ve_per_lap.clear();
        self.last_total_laps = -1;
        self.last_ve_level = -1.0;
    }
}

// ---------------------------------------------------------------------------
// StateAggregator
// ---------------------------------------------------------------------------

pub struct StateAggregator {
    previous: Option<EngineerState>,
    lap_history: LapHistoryBuffer,
    last_session_key: String,
}

impl StateAggregator {
    pub fn new() -> Self {
        Self {
            previous: None,
            lap_history: LapHistoryBuffer::new(),
            last_session_key: String::new(),
        }
    }

    pub fn previous(&self) -> Option<&EngineerState> {
        self.previous.as_ref()
    }

    /// Advance the aggregator: move `current` into `previous`.
    pub fn advance(&mut self, state: EngineerState) {
        self.previous = Some(state);
    }

    /// Build an EngineerState from the current shared-memory snapshot.
    /// Must be called before `advance()` so `previous()` still reflects last tick.
    pub fn build_state(
        &mut self,
        sc: Option<&rF2ScoringBuffer>,
        tel: Option<&rF2TelemetryBuffer>,
        fuel: &FuelSnapshot,
        safety_car_active: bool,
        ve_available: Option<bool>,
    ) -> EngineerState {
        let now = Instant::now();

        let sc_info = sc.map(|s| &s.mScoringInfo);

        // --- Session ---
        let session_type = sc_info
            .map(|i| SessionType::from_session_id(i.mSession))
            .unwrap_or(SessionType::Unknown);

        let session_phase = sc_info
            .map(|i| SessionPhase::from_game_phase(i.mGamePhase, safety_car_active))
            .unwrap_or(SessionPhase::Formation);

        let time_remaining = sc_info.and_then(|i| {
            if i.mEndET > 0.0 && i.mCurrentET >= 0.0 {
                let rem = i.mEndET - i.mCurrentET;
                if rem >= 0.0 {
                    Some(Duration::from_secs_f64(rem))
                } else {
                    None
                }
            } else {
                None
            }
        });

        // --- Player vehicle in scoring ---
        let num_sc = sc.map(|s| (s.mScoringInfo.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES)).unwrap_or(0);
        let player_sc = sc.and_then(|s| {
            s.mVehicles[..num_sc]
                .iter()
                .find(|v| v.mIsPlayer != 0)
        });

        let total_laps_driven = player_sc.map(|v| v.mTotalLaps as u32).unwrap_or(0);
        let player_position = player_sc.map(|v| v.mPlace as u32).unwrap_or(0);
        let in_pit = player_sc.map(|v| v.mInPits != 0).unwrap_or(false);
        let pit_state = player_sc.map(|v| PitState::from_u8(v.mPitState)).unwrap_or(PitState::None);

        // Laps remaining: valid only in lap-limited sessions
        let laps_remaining = sc_info.and_then(|i| {
            if i.mMaxLaps > 0 && i.mMaxLaps < 999_000 {
                let rem = i.mMaxLaps - total_laps_driven as i32;
                Some(rem.max(0) as u32)
            } else {
                None
            }
        });

        // Class position: count vehicles of same class with better position
        let player_class_position = sc.map(|s| {
            let player_class_name = player_sc
                .map(|v| &v.mVehicleClass[..])
                .unwrap_or(&[]);
            let player_pos = player_position;
            1 + s.mVehicles[..num_sc]
                .iter()
                .filter(|v| v.mVehicleClass[..] == *player_class_name && (v.mPlace as u32) < player_pos)
                .count() as u32
        }).unwrap_or(1);

        // --- Player vehicle in telemetry ---
        let player_id = player_sc.map(|v| v.mID).unwrap_or(-1);
        let num_tel = tel.map(|t| (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES)).unwrap_or(0);
        let player_tel = tel.and_then(|t| {
            t.mVehicles[..num_tel]
                .iter()
                .find(|v| v.mID == player_id)
                .or_else(|| t.mVehicles.get(0))
        });

        // mVehicleClassEnum is on the telemetry struct, not scoring
        let player_class = player_tel
            .map(|v| CarClass::from_class_enum(v.mVehicleClassEnum))
            .unwrap_or(CarClass::Unknown);

        let player_lap = player_tel
            .map(|v| (v.mLapNumber + 1).max(0) as u32)
            .unwrap_or(total_laps_driven + 1);

        // --- Fuel & VE ---
        let fuel_remaining_l = player_tel.map(|v| v.mFuel as f32).unwrap_or(0.0);
        let fuel_laps_left = fuel.laps_remaining as f32;

        let ve_level = player_tel.map(|v| v.mVirtualEnergy).unwrap_or(0.0);
        // ve_laps_left is finite only if: Hypercar class confirmed, VE data confirmed,
        // and at least one lap's worth of consumption data is available (avg_ve_per_lap is Some).
        // This guards against ve_level=0 before VE data loads, or wrong class detection.
        let ve_laps_left = if player_class == CarClass::Hypercar && ve_available == Some(true) {
            match self.lap_history.avg_ve_per_lap() {
                Some(avg) if avg > 0.0 => ve_level / avg,
                _ => f32::INFINITY,
            }
        } else {
            f32::INFINITY
        };
        let effective_laps_left = fuel_laps_left.min(ve_laps_left);

        // --- Update lap history ---
        let last_lap_time_raw = player_sc.map(|v| v.mLastLapTime).unwrap_or(-1.0);
        self.lap_history.update(total_laps_driven as i32, last_lap_time_raw, ve_level);

        // Session change detection
        if let Some(i) = sc_info {
            let key = format!("{}/{}", i.mSession,
                crate::shared_memory::types::bytes_to_str(&i.mTrackName));
            if !self.last_session_key.is_empty() && key != self.last_session_key {
                self.lap_history.reset();
            }
            self.last_session_key = key;
        }

        // --- Timing ---
        let last_lap_time = player_sc.and_then(|v| {
            if v.mLastLapTime > 0.0 { Some(Duration::from_secs_f64(v.mLastLapTime)) } else { None }
        });
        let best_lap_time_personal = player_sc.and_then(|v| {
            if v.mBestLapTime > 0.0 { Some(Duration::from_secs_f64(v.mBestLapTime)) } else { None }
        });

        // Session best: minimum best_lap_time across all cars
        let best_lap_time_session = sc.and_then(|s| {
            s.mVehicles[..num_sc]
                .iter()
                .filter(|v| v.mBestLapTime > 0.0)
                .map(|v| v.mBestLapTime)
                .reduce(f64::min)
                .map(Duration::from_secs_f64)
        });

        // Current lap time: elapsed time since lap start
        let current_lap_time = {
            let current_et = sc_info.map(|i| i.mCurrentET).unwrap_or(0.0);
            let lap_start = player_sc.map(|v| v.mLapStartET).unwrap_or(0.0);
            if current_et >= lap_start && lap_start > 0.0 {
                Duration::from_secs_f64(current_et - lap_start)
            } else {
                Duration::ZERO
            }
        };

        // Sector deltas vs personal best
        let last_sector_deltas = player_sc.map(|v| {
            let s1_delta = if v.mLastSector1 > 0.0 && v.mBestSector1 > 0.0 {
                Some((v.mLastSector1 - v.mBestSector1) as f32)
            } else { None };

            let last_s2 = if v.mLastSector2 > 0.0 && v.mLastSector1 > 0.0 {
                v.mLastSector2 - v.mLastSector1
            } else { -1.0 };
            let best_s2 = if v.mBestSector2 > 0.0 && v.mBestSector1 > 0.0 {
                v.mBestSector2 - v.mBestSector1
            } else { -1.0 };
            let s2_delta = if last_s2 > 0.0 && best_s2 > 0.0 {
                Some((last_s2 - best_s2) as f32)
            } else { None };

            let last_s3 = if v.mLastLapTime > 0.0 && v.mLastSector2 > 0.0 {
                v.mLastLapTime - v.mLastSector2
            } else { -1.0 };
            let best_s3 = if v.mBestLapTime > 0.0 && v.mBestSector2 > 0.0 {
                v.mBestLapTime - v.mBestSector2
            } else { -1.0 };
            let s3_delta = if last_s3 > 0.0 && best_s3 > 0.0 {
                Some((last_s3 - best_s3) as f32)
            } else { None };

            [s1_delta, s2_delta, s3_delta]
        }).unwrap_or([None, None, None]);

        // --- Gaps ---
        let gap_ahead = player_sc.and_then(|v| {
            if v.mTimeBehindNext > 0.0 { Some(v.mTimeBehindNext as f32) } else { None }
        });

        // Gap behind: find vehicle directly behind player and get their mTimeBehindNext
        let gap_behind = sc.and_then(|s| {
            let player_pos = player_position;
            s.mVehicles[..num_sc]
                .iter()
                .find(|v| v.mPlace as u32 == player_pos + 1)
                .and_then(|v| if v.mTimeBehindNext > 0.0 { Some(v.mTimeBehindNext as f32) } else { None })
        });

        // --- Flags ---
        let active_flags = sc_info.map(|i| {
            // LMU: mSectorFlag uses 1=yellow, 11=clear (not 0). Must compare == 1.
            let yellow_sectors = [
                i.mSectorFlag[0] == 1,
                i.mSectorFlag[1] == 1,
                i.mSectorFlag[2] == 1,
            ];
            let red = i.mGamePhase == 7;
            let (blue, player_under_yellow, individual_phase, sector_raw) = player_sc.map(|v| {
                (v.mFlag == 6, v.mUnderYellow != 0, v.mIndividualPhase, v.mSector)
            }).unwrap_or((false, false, 0, 1));
            // mSector: 1=S1→idx 0, 2=S2→idx 1, 0=S3→idx 2
            let player_sector_idx = match sector_raw {
                1 => 0,
                2 => 1,
                _ => 2,
            };
            // mIndividualPhase == 10: FCY or explicit under-yellow
            // yellow_sectors[player_sector_idx]: local sector yellow
            let player_in_yellow_sector = individual_phase == 10
                || yellow_sectors[player_sector_idx];
            FlagState { yellow_sectors, blue, red, player_under_yellow, player_in_yellow_sector, player_sector_idx }
        }).unwrap_or_default();

        // --- Tires (mid surface temp, Kelvin → Celsius) ---
        let tire_temps_c = player_tel.map(|v| [
            (v.mWheels[0].mTemperature[1] - 273.15) as f32,
            (v.mWheels[1].mTemperature[1] - 273.15) as f32,
            (v.mWheels[2].mTemperature[1] - 273.15) as f32,
            (v.mWheels[3].mTemperature[1] - 273.15) as f32,
        ]).unwrap_or([0.0; 4]);

        let tire_wear_pct = player_tel.map(|v| [
            v.mWheels[0].mWear as f32,
            v.mWheels[1].mWear as f32,
            v.mWheels[2].mWear as f32,
            v.mWheels[3].mWear as f32,
        ]).unwrap_or([0.0; 4]);

        // --- Damage ---
        let damage = player_tel.map(|v| {
            let has_aero = v.mDentSeverity.iter().any(|&d| d >= 2);
            let has_suspension = v.mDentSeverity[4..8].iter().any(|&d| d >= 1);
            DamageState {
                has_aero,
                has_suspension,
                overheating: v.mOverheating != 0,
                any_detached: v.mDetached != 0,
                last_impact_magnitude: v.mLastImpactMagnitude,
            }
        }).unwrap_or_default();

        // --- Weather ---
        let ambient_temp_c = sc_info.map(|i| i.mAmbientTemp as f32).unwrap_or(20.0);
        let track_temp_c = sc_info.map(|i| i.mTrackTemp as f32).unwrap_or(25.0);
        let rain_intensity = sc_info.map(|i| i.mRaining as f32).unwrap_or(0.0);

        // --- Penalties ---
        let num_penalties = player_sc.map(|v| v.mNumPenalties.max(0) as u32).unwrap_or(0);

        EngineerState {
            tick_time: now,
            session_type,
            session_phase,
            time_remaining,
            laps_remaining,
            total_laps_driven,
            player_position,
            player_class_position,
            player_class,
            player_lap,
            in_pit,
            pit_state,
            fuel_remaining_l,
            fuel_laps_left,
            ve_laps_left,
            effective_laps_left,
            last_lap_time,
            best_lap_time_personal,
            best_lap_time_session,
            current_lap_time,
            last_sector_deltas,
            recent_lap_times: self.lap_history.recent.clone(),
            gap_ahead,
            gap_behind,
            active_flags,
            tire_temps_c,
            tire_wear_pct,
            damage,
            ambient_temp_c,
            track_temp_c,
            rain_intensity,
            num_penalties,
        }
    }
}
