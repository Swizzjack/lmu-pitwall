/// rF2 Shared Memory struct definitions (C-compatible layout)
/// Based on rF2SharedMemoryMapPlugin / rF2State.h + rF2Data.cs (TheIronWolfModding)
///
/// Layout: #[repr(C, packed(4))] matches the C++ #pragma pack(push, 4)
/// Field order MUST match exactly — even one missing field shifts all subsequent offsets.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const MAX_MAPPED_VEHICLES: usize = 128;
pub const MAX_MAPPED_IDS: usize = 512;

// Named shared-memory buffer identifiers (Windows MMF names)
pub const TELEMETRY_BUFFER_NAME: &str = "$rFactor2SMMP_Telemetry$";
pub const SCORING_BUFFER_NAME: &str = "$rFactor2SMMP_Scoring$";
pub const RULES_BUFFER_NAME: &str = "$rFactor2SMMP_Rules$";
pub const MULTI_RULES_BUFFER_NAME: &str = "$rFactor2SMMP_MultiRules$";
pub const FORCE_FEEDBACK_BUFFER_NAME: &str = "$rFactor2SMMP_ForceFeedback$";
pub const GRAPHICS_BUFFER_NAME: &str = "$rFactor2SMMP_Graphics$";
pub const PIT_INFO_BUFFER_NAME: &str = "$rFactor2SMMP_PitInfo$";
pub const WEATHER_BUFFER_NAME: &str = "$rFactor2SMMP_Weather$";
pub const EXTENDED_BUFFER_NAME: &str = "$rFactor2SMMP_Extended$";

// ---------------------------------------------------------------------------
// Primitive building blocks
// ---------------------------------------------------------------------------

/// 3D double-precision vector (matches TelemVect3)
#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Default for rF2Vec3 {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, z: 0.0 }
    }
}

// ---------------------------------------------------------------------------
// Per-wheel telemetry  (matches rF2Wheel / TelemWheelV01)
// ---------------------------------------------------------------------------

/// rF2Wheel — per-wheel data inside rF2VehicleTelemetry
/// Wheel order in mWheels: [FL=0, FR=1, RL=2, RR=3]
///
/// NOTE: temperatures (mTemperature, mTireCarcassTemperature,
/// mTireInnerLayerTemperature) are in **Kelvin** — subtract 273.15 for Celsius.
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2Wheel {
    pub mSuspensionDeflection: f64,          // meters
    pub mRideHeight: f64,                    // meters
    pub mSuspForce: f64,                     // pushrod load in Newtons
    pub mBrakeTemp: f64,                     // Celsius
    pub mBrakePressure: f64,                 // 0.0-1.0 (future: true kPa)

    pub mRotation: f64,                      // radians/sec
    pub mLateralPatchVel: f64,               // m/s lateral velocity at contact patch
    pub mLongitudinalPatchVel: f64,          // m/s longitudinal velocity at contact patch
    pub mLateralGroundVel: f64,              // m/s lateral ground velocity
    pub mLongitudinalGroundVel: f64,         // m/s longitudinal ground velocity
    pub mCamber: f64,                        // radians
    pub mLateralForce: f64,                  // Newtons
    pub mLongitudinalForce: f64,             // Newtons
    pub mTireLoad: f64,                      // Newtons

    pub mGripFract: f64,                     // fraction of patch that is sliding (0-1)
    pub mPressure: f64,                      // kPa tire air pressure
    pub mTemperature: [f64; 3],              // Kelvin: left/center/right
    pub mWear: f64,                          // 0.0 (new) – 1.0 (destroyed)
    pub mTerrainName: [u8; 16],              // material prefix from TDF
    pub mSurfaceType: u8,                    // 0=dry,1=wet,2=grass,3=dirt,4=gravel,5=rumble,6=special
    pub mFlat: u8,                           // 1 if flat
    pub mDetached: u8,                       // 1 if detached
    pub mStaticUndeflectedRadius: u8,        // tire radius in centimetres

    pub mVerticalTireDeflection: f64,        // deflection from static radius
    pub mWheelYLocation: f64,                // wheel Y relative to vehicle Y
    pub mToe: f64,                           // current toe angle (rad) w.r.t. vehicle

    pub mTireCarcassTemperature: f64,        // rough average carcass temperature (Kelvin)
    pub mTireInnerLayerTemperature: [f64; 3],// rough average inner-layer temperatures (Kelvin)

    pub mOptimalTemp: f32,                   // optimal tire temperature
    pub mCompoundIndex: u8,                  // compound index
    pub mCompoundType: u8,                   // compound type
    pub mExpansion: [u8; 18],                // reserved for future use (was 24)
}

// ---------------------------------------------------------------------------
// Vehicle telemetry (50 Hz buffer)
// ---------------------------------------------------------------------------

/// rF2VehicleTelemetry — full telemetry data for one vehicle.
///
/// Field order MUST exactly match rF2State.h / TelemInfoV01.
/// Key layout note: mWheels is at the END of the struct (after expansion bytes).
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2VehicleTelemetry {
    // --- identification / timing ---
    pub mID: i32,                            // slot ID (may change post-init)
    pub mDeltaTime: f64,                     // seconds since last update
    pub mElapsedTime: f64,                   // game session time (seconds)
    pub mLapNumber: i32,                     // current lap (0-based)
    pub mLapStartET: f64,                    // elapsed time when this lap started

    pub mVehicleName: [u8; 64],              // vehicle model name
    pub mTrackName: [u8; 64],               // track name

    // --- position / kinematics ---
    pub mPos: rF2Vec3,                       // world position (metres)
    pub mLocalVel: rF2Vec3,                  // velocity in local coords (m/s)
    pub mLocalAccel: rF2Vec3,               // acceleration in local coords (m/s²)
    pub mOri: [rF2Vec3; 3],                 // orientation matrix rows (local→world)
    pub mLocalRot: rF2Vec3,                 // angular velocity in local coords (rad/s)
    pub mLocalRotAccel: rF2Vec3,            // angular acceleration in local coords (rad/s²)

    // --- powertrain / controls ---
    pub mGear: i32,                          // -1=reverse, 0=neutral, 1+=forward
    pub mEngineRPM: f64,                     // current RPM  ← BEFORE mEngineMaxRPM
    pub mEngineWaterTemp: f64,               // Celsius
    pub mEngineOilTemp: f64,                 // Celsius
    pub mClutchRPM: f64,                     // clutch-side RPM

    // raw (unfiltered) driver inputs
    pub mUnfilteredThrottle: f64,            // 0.0 – 1.0
    pub mUnfilteredBrake: f64,              // 0.0 – 1.0
    pub mUnfilteredSteering: f64,           // -1.0 (left) – 1.0 (right)
    pub mUnfilteredClutch: f64,             // 0.0 – 1.0

    // filtered / corrected inputs
    pub mFilteredThrottle: f64,              // 0.0 – 1.0
    pub mFilteredBrake: f64,                // 0.0 – 1.0
    pub mFilteredSteering: f64,             // -1.0 – 1.0
    pub mFilteredClutch: f64,              // 0.0 – 1.0

    // --- chassis / aero ---
    pub mSteeringShaftTorque: f64,          // Nm (useful for FFB)
    pub mFront3rdDeflection: f64,           // front third-spring deflection (m)
    pub mRear3rdDeflection: f64,            // rear third-spring deflection (m)

    pub mFrontWingHeight: f64,              // front wing height (m)
    pub mFrontRideHeight: f64,              // front ride height (m)
    pub mRearRideHeight: f64,               // rear ride height (m)
    pub mDrag: f64,                         // drag force (Newtons)
    pub mFrontDownforce: f64,               // front downforce (Newtons)
    pub mRearDownforce: f64,               // rear downforce (Newtons)

    // --- state / fuel ---
    pub mFuel: f64,                         // current fuel level (litres)
    pub mEngineMaxRPM: f64,                  // redline RPM  ← AFTER mFuel

    // --- vehicle state flags ---
    pub mScheduledStops: u8,                // scheduled pit stops remaining
    pub mOverheating: u8,                   // 1 if overheating icon shown
    pub mDetached: u8,                      // 1 if any part is detached
    pub mHeadlights: u8,                    // 1 if headlights on
    pub mDentSeverity: [u8; 8],            // 0=none,1=dented,2=very dented (8 locations)

    pub mLastImpactET: f64,                 // session time of last impact
    pub mLastImpactMagnitude: f64,          // magnitude of last impact
    pub mLastImpactPos: rF2Vec3,            // world position of last impact

    // --- expansion block (formerly "Expanded") ---
    pub mEngineTorque: f64,                 // engine torque at wheels (Nm)
    pub mCurrentSector: i32,               // 0=S1, 1=S2, 2=S3 (sign bit = in pitlane)
    pub mSpeedLimiter: u8,                  // 1 if pit speed limiter active
    pub mMaxGears: u8,                      // number of forward gears
    pub mFrontTireCompoundIndex: u8,        // compound index (front)
    pub mRearTireCompoundIndex: u8,         // compound index (rear)
    pub mFuelCapacity: f64,                 // tank capacity (litres)
    pub mFrontFlapActivated: u8,            // 1 if front flap activated
    pub mRearFlapActivated: u8,             // 1 if rear flap activated
    pub mRearFlapLegalStatus: u8,           // 0=disallowed,1=detected/pending,2=allowed
    pub mIgnitionStarter: u8,              // 0=off,1=ignition,2=ignition+starter
    pub mFrontTireCompoundName: [u8; 18],   // compound name (front)
    pub mRearTireCompoundName: [u8; 18],    // compound name (rear)
    pub mSpeedLimiterAvailable: u8,         // 1 if speed limiter available
    pub mAntiStallActivated: u8,           // 1 if anti-stall active
    pub mUnused: [u8; 2],
    pub mVisualSteeringWheelRange: f32,     // visual lock-to-lock range (degrees)
    pub mRearBrakeBias: f64,               // rear brake bias fraction
    pub mTurboBoostPressure: f64,           // turbo boost (bar)
    pub mPhysicsToGraphicsOffset: [f32; 3], // physics→graphics centre offset
    pub mPhysicalSteeringWheelRange: f32,   // physical lock-to-lock range (degrees)
    pub mDeltaBest: f64,                    // delta to personal best lap (seconds)

    // --- hybrid / electric motor ---
    pub mBatteryChargeFraction: f64,        // battery charge [0.0-1.0]
    pub mElectricBoostMotorTorque: f64,     // boost motor torque (Nm; negative = regen)
    pub mElectricBoostMotorRPM: f64,        // boost motor RPM
    pub mElectricBoostMotorTemperature: f64,// boost motor temperature (Celsius)
    pub mElectricBoostWaterTemperature: f64,// boost motor coolant temperature (Celsius; 0 if absent)
    pub mElectricBoostMotorState: u8,       // 0=unavailable,1=inactive,2=propulsion,3=regen

    // --- LMU v1.3: electronics / driver aids (native) ---
    pub mLapInvalidated: u8,                // 1 if current lap invalidated
    pub mABSActive: u8,                     // 1 if ABS currently intervening
    pub mTCActive: u8,                      // 1 if TC currently intervening
    pub mSpeedLimiterActive: u8,            // 1 if speed limiter currently active
    pub mWiperState: u8,                    // wiper state

    pub mTC: u8,                            // traction control level
    pub mTCMax: u8,                         // TC max level for this car
    pub mTCSlip: u8,                        // TC slip threshold
    pub mTCSlipMax: u8,                     // TC slip max
    pub mTCCut: u8,                         // TC cut level
    pub mTCCutMax: u8,                      // TC cut max

    pub mABS: u8,                           // ABS level
    pub mABSMax: u8,                        // ABS max level for this car

    pub mMotorMap: u8,                      // engine/motor map
    pub mMotorMapMax: u8,                   // motor map max

    pub mMigration: u8,                     // brake migration step
    pub mMigrationMax: u8,                  // brake migration max

    pub mFrontAntiSway: u8,                 // front anti-roll bar level
    pub mFrontAntiSwayMax: u8,              // front ARB max
    pub mRearAntiSway: u8,                  // rear anti-roll bar level
    pub mRearAntiSwayMax: u8,               // rear ARB max

    pub mLiftAndCoastProgress: u8,          // lift-and-coast progress
    pub mTrackLimitsSteps: u8,              // normalized track limits points

    pub mRegen: f32,                        // regeneration (kW)
    pub mSoC: f32,                          // state of charge
    pub mVirtualEnergy: f32,               // virtual energy fraction

    pub mTimeGapCarAhead: f32,             // time gap to car directly ahead (s)
    pub mTimeGapCarBehind: f32,            // time gap to car directly behind (s)
    pub mTimeGapPlaceAhead: f32,           // time gap to position ahead (s)
    pub mTimeGapPlaceBehind: f32,          // time gap to position behind (s)

    pub mVehicleModel: [u8; 30],            // vehicle model name
    pub mVehicleClassEnum: u8,              // IP_VehicleClass enum (0=Hypercar, 5=GT3, ...)
    pub mVehicleChampionshipEnum: u8,       // IP_VehicleChampionship enum

    pub mExpansion: [u8; 20],               // remaining future-use bytes

    // --- wheels (FL=0, FR=1, RL=2, RR=3) --- MUST BE LAST
    pub mWheels: [rF2Wheel; 4],
}

// ---------------------------------------------------------------------------
// Scoring data (5 Hz buffer)
// ---------------------------------------------------------------------------

/// rF2VehicleScoring — per-vehicle data inside rF2Scoring buffer
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2VehicleScoring {
    pub mID: i32,                            // slot ID
    pub mDriverName: [u8; 32],              // driver name (UTF-8)
    pub mVehicleName: [u8; 64],             // vehicle name
    pub mTotalLaps: i16,                     // completed laps
    pub mSector: i8,                         // 0=S3, 1=S1, 2=S2 (delayed by one sector)
    pub mFinishStatus: i8,                   // 0=none,1=finished,2=DNF,3=DQ
    pub mLapDist: f64,                       // distance around track (m)
    pub mPathLateral: f64,                   // lateral offset from centre path
    pub mTrackEdge: f64,                     // track edge w.r.t. centre path
    pub mBestSector1: f64,                   // best S1 time (s)
    pub mBestSector2: f64,                   // best S2 cumulative time (s)
    pub mBestLapTime: f64,                   // best lap time (s)
    pub mLastSector1: f64,                   // last S1 time (s)
    pub mLastSector2: f64,                   // last S2 cumulative time (s)
    pub mLastLapTime: f64,                   // last lap time (s)
    pub mCurSector1: f64,                    // current S1 time (s) if valid
    pub mCurSector2: f64,                    // current S2 cumulative time (s) if valid
    pub mNumPitstops: i16,                  // pitstops made
    pub mNumPenalties: i16,                 // outstanding penalties
    pub mIsPlayer: u8,                       // 1 if this is the local player
    pub mControl: i8,                        // -1=nobody,0=local player,1=local AI,2=remote,3=replay
    pub mInPits: u8,                         // 1 if between pit_entry and pit_exit
    pub mPlace: u8,                          // 1-based race position
    pub mVehicleClass: [u8; 32],             // vehicle class name
    pub mTimeBehindNext: f64,               // gap to the car ahead (s)
    pub mLapsBehindNext: i32,              // laps behind car ahead
    pub mTimeBehindLeader: f64,            // gap to leader (s)
    pub mLapsBehindLeader: i32,            // laps behind leader
    pub mLapStartET: f64,                   // session time when this lap started
    pub mPos: rF2Vec3,                       // world position (m)
    pub mLocalVel: rF2Vec3,                 // local velocity (m/s)
    pub mLocalAccel: rF2Vec3,              // local acceleration (m/s²)
    pub mOri: [rF2Vec3; 3],                // orientation matrix rows
    pub mLocalRot: rF2Vec3,                // angular velocity in local coords (rad/s)
    pub mLocalRotAccel: rF2Vec3,           // angular acceleration in local coords (rad/s²)
    pub mHeadlights: u8,                    // headlight status
    pub mPitState: u8,                      // 0=none,1=request,2=entering,3=stopped,4=exiting
    pub mServerScored: u8,                  // 1 if scored by server
    pub mIndividualPhase: u8,              // game phase for this vehicle
    pub mQualification: i32,              // 1-based qualifying position (-1 if invalid)
    pub mTimeIntoLap: f64,                  // estimated time into current lap (s)
    pub mEstimatedLapTime: f64,             // estimated total lap time (s)
    pub mPitGroup: [u8; 24],               // pit group identifier
    pub mFlag: u8,                          // primary flag shown to this vehicle
    pub mUnderYellow: u8,                   // 1 if full-course yellow active for this car
    pub mCountLapFlag: u8,                  // dynamic blue-flag override
    pub mInGarageStall: u8,                // 1 if within allowable garage area
    pub mUpgradePack: [u8; 16],            // upgrade pack code
    pub mPitLapDist: f32,                   // pit lane distance (m)  ← f32, not f64!
    pub mBestLapSector1: f32,              // S1 time from best lap (s)  ← f32!
    pub mBestLapSector2: f32,              // S2 cumulative from best lap (s)  ← f32!
    pub mExpansion: [u8; 48],              // reserved
}

/// rF2ScoringInfo — session-wide scoring data (does NOT contain the vehicle array;
/// vehicles are in rF2ScoringBuffer.mVehicles, following this struct in memory)
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2ScoringInfo {
    pub mTrackName: [u8; 64],               // track name
    pub mSession: i32,                       // 0=testday,1-4=practice,5-8=qual,9=warmup,10-13=race
    pub mCurrentET: f64,                     // current session time (s)
    pub mEndET: f64,                         // session end time (s)
    pub mMaxLaps: i32,                       // max laps (999999 if time-based)
    pub mLapDist: f64,                       // full lap distance (m)
    pub mPointer1: [u8; 8],                 // padding for pointer (64-bit plugin)
    pub mNumVehicles: i32,                  // vehicles currently in session
    pub mGamePhase: u8,                      // 0=garage,1=warmup,2=gridwalk,3=formation,...
    pub mYellowFlagState: i8,               // 0=none,1=pending,2=pits closed,3=pit lead lap,4=pits open,5=last lap,6=resume,7=race halt
    pub mSectorFlag: [i8; 3],               // local yellow in each sector
    pub mStartLight: u8,                    // start light frame number
    pub mNumRedLights: u8,                  // red lights in start sequence
    pub mInRealtime: u8,                    // 1 if in realtime (not at monitor/menu)
    pub mPlayerName: [u8; 32],              // local player name
    pub mPlrFileName: [u8; 64],             // player file name
    pub mDarkCloud: f64,                    // cloud darkness 0.0–1.0
    pub mRaining: f64,                      // rain severity 0.0–1.0
    pub mAmbientTemp: f64,                  // air temperature (Celsius)
    pub mTrackTemp: f64,                    // track temperature (Celsius)
    pub mWind: rF2Vec3,                      // wind vector (m/s)
    pub mMinPathWetness: f64,              // minimum wetness on racing line (0–1)
    pub mMaxPathWetness: f64,              // maximum wetness on racing line (0–1)
    pub mGameMode: u8,                      // 1=single-player,2=multiplayer,3=competition
    pub mIsPasswordProtected: u8,          // 1 if server is password protected
    pub mServerPort: u16,                   // server port
    pub mServerPublicIP: u32,               // server public IP (packed u32)
    pub mMaxPlayers: i32,                  // max players in server
    pub mServerName: [u8; 32],             // server name
    pub mStartET: f32,                      // event start time (seconds since midnight)  ← f32!
    pub mAvgPathWetness: f64,              // average wetness on racing line (0–1)
    pub mExpansion: [u8; 200],             // reserved
    pub mPointer2: [u8; 8],                // padding for pointer (64-bit plugin)
}

// ---------------------------------------------------------------------------
// Rules (track/flag rules, safety car)
// ---------------------------------------------------------------------------

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2TrackRulesAction {
    pub mCommand: i32,                      // recommended action command
    pub mID: i32,                           // slot ID if applicable
    pub mET: f64,                           // elapsed time event occurred
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2TrackRulesParticipant {
    pub mID: i32,                           // slot ID
    pub mFrozenOrder: i16,                  // 0-based frozen order (-1 if not frozen)
    pub mPlace: i16,                        // 1-based race position
    pub mYellowSeverity: f32,              // 0.0–1.0 contribution to yellow
    pub mCurrentRelativeDistance: f64,     // current position around track
    pub mRelativeLaps: i32,                // laps relative to leader
    pub mColumnAssignment: i32,            // 0=left, 1=right column
    pub mPositionAssignment: i32,          // 0-based position within column
    pub mPitsOpen: u8,                      // 1 if vehicle may enter pits
    pub mUpToSpeed: u8,                     // 1 if vehicle is up to required speed
    pub mUnused: [u8; 2],
    pub mGoalRelativeDistance: f64,        // target distance around track
    pub mMessage: [u8; 96],                // message for this participant
    pub mExpansion: [u8; 192],             // reserved
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2Rules {
    pub mTrackName: [u8; 64],
    pub mSession: i32,
    pub mCurrentET: f64,
    pub mEndET: f64,
    pub mMaxLaps: i32,
    pub mLapDist: f64,
    pub mNumActions: i32,
    pub mActions: [rF2TrackRulesAction; 8],
    pub mNumParticipants: i32,
    pub mYellowFlagDetected: u8,
    pub mYellowFlagLapsWasOverridden: u8,
    pub mSafetyCarExists: u8,
    pub mSafetyCarActive: u8,
    pub mSafetyCarLaps: i32,
    pub mSafetyCarThreshold: f32,
    pub mSafetyCarLapDist: f64,
    pub mSafetyCarLapDistAtStart: f32,
    pub mPitLaneLapDistEntry: f32,
    pub mPitLaneLapDistExit: f32,
    pub mPitLaneStartDist: f32,
    pub mTeleportLapDist: f32,
    pub mExpansion: [u8; 256],
    pub mParticipants: [rF2TrackRulesParticipant; MAX_MAPPED_VEHICLES],
}

// ---------------------------------------------------------------------------
// Multi rules (simple per-vehicle flags)
// ---------------------------------------------------------------------------

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2MultiRulesParticipant {
    pub mID: i32,
    pub mExpansion: [u8; 52],
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2MultiRules {
    pub mExpansion: [u8; 256],
    pub mParticipants: [rF2MultiRulesParticipant; MAX_MAPPED_VEHICLES],
}

// ---------------------------------------------------------------------------
// Force feedback (400 Hz buffer)
// ---------------------------------------------------------------------------

#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2ForceFeedback {
    pub mForceValue: f64,                   // current FFB value (−1.0 – 1.0)
    pub mExpansion: [u8; 64],
}

// ---------------------------------------------------------------------------
// Pit info / menu (100 Hz buffer)
// ---------------------------------------------------------------------------

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2PitMenu {
    pub mCategoryIndex: i32,               // index of selected category
    pub mCategoryName: [u8; 32],           // category name
    pub mChoiceIndex: i32,                 // index of currently selected choice
    pub mChoiceString: [u8; 32],           // human-readable selected choice
    pub mNumChoices: i32,                  // number of choices in category
    pub mExpansion: [u8; 256],
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2PitInfo {
    pub mPitMenu: rF2PitMenu,
    pub mExpansion: [u8; 256],
}

// ---------------------------------------------------------------------------
// Weather (1 Hz buffer)
// ---------------------------------------------------------------------------

#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2Weather {
    pub mTrackNodeSize: f64,               // approximate distance between track nodes
    pub mExpansion: [u8; 256],
}

// ---------------------------------------------------------------------------
// Extended buffer (5 Hz) — physics options, damage, session transitions
// ---------------------------------------------------------------------------

#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2PhysicsOptions {
    pub mTractionControl: u8,              // 0=off … 3=high
    pub mAntiLockBrakes: u8,              // 0=off … 2=high
    pub mStabilityControl: u8,            // 0=off … 2=high
    pub mAutoShift: u8,                    // 0=off,1=upshifts,2=downshifts,3=all
    pub mAutoClutch: u8,                  // 0=off,1=on
    pub mInvulnerable: u8,
    pub mOppositeLock: u8,
    pub mSteeringHelp: u8,                // 0=off … 3=high
    pub mBrakingHelp: u8,                 // 0=off … 2=high
    pub mSpinRecovery: u8,
    pub mAutoPit: u8,
    pub mAutoLift: u8,
    pub mAutoBlip: u8,
    pub mFuelMult: u8,
    pub mTireMult: u8,
    pub mMechFail: u8,                     // 0=off,1=realistic,2=finish race
    pub mAllowPitcrewPush: u8,
    pub mRepeatShifts: u8,
    pub mHoldClutch: u8,
    pub mAutoReverse: u8,
    pub mAlternateNeutral: u8,
    pub mAIControl: u8,                    // 1 if vehicle is under AI control
    pub mUnused1: u8,
    pub mUnused2: u8,
    pub mManualShiftOverrideTime: f32,
    pub mAutoShiftOverrideTime: f32,
    pub mSpeedSensitiveSteering: f32,
    pub mSteerRatioSpeed: f32,
}

#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2TrackedDamage {
    pub mMaxImpactMagnitude: f64,
    pub mAccumulatedImpactMagnitude: f64,
}

#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2VehScoringCapture {
    pub mID: i32,
    pub mPlace: u8,
    pub mIsPlayer: u8,
    pub mFinishStatus: i8,
    pub mPad: u8,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2SessionTransitionCapture {
    pub mGamePhase: u8,
    pub mSession: i32,
    pub mNumScoringVehicles: i32,
    pub mScoringVehicles: [rF2VehScoringCapture; MAX_MAPPED_VEHICLES],
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2Extended {
    pub mVersion: [u8; 12],                 // plugin version string (12 bytes in C++)
    pub mIs64bit: u8,                        // 1 if 64-bit plugin
    pub mPhysicsOptions: rF2PhysicsOptions,
    pub mTrackedDamages: [rF2TrackedDamage; MAX_MAPPED_VEHICLES],
    pub mInRealtimeFC: u8,
    pub mMultiSessionRulesV1: [u8; 1024],
    pub mExpansion: [u8; 1032],
}

// ---------------------------------------------------------------------------
// Top-level buffer wrappers (what is actually mapped into shared memory)
// ---------------------------------------------------------------------------

/// Header present at the start of every mapped buffer.
/// Read mVersionUpdateBegin before and mVersionUpdateEnd after reading payload;
/// if they differ a torn read occurred — discard and retry.
#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2MappedBufferHeader {
    pub mVersionUpdateBegin: u32,
    pub mVersionUpdateEnd: u32,
}

/// Complete telemetry buffer (C++: rF2Telemetry)
/// Layout: header + mBytesUpdatedHint + mNumVehicles + mVehicles[128]
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2TelemetryBuffer {
    pub mVersionUpdateBegin: u32,
    pub mVersionUpdateEnd: u32,
    pub mBytesUpdatedHint: i32,            // partial-update hint (0 = full buffer)
    pub mNumVehicles: i32,                 // how many entries in mVehicles are valid
    pub mVehicles: [rF2VehicleTelemetry; MAX_MAPPED_VEHICLES],
}

/// Complete scoring buffer (C++: rF2Scoring)
/// Layout: header + mBytesUpdatedHint + mScoringInfo + mVehicles[128]
/// NOTE: mVehicles lives HERE in the buffer, NOT inside rF2ScoringInfo.
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2ScoringBuffer {
    pub mVersionUpdateBegin: u32,
    pub mVersionUpdateEnd: u32,
    pub mBytesUpdatedHint: i32,
    pub mScoringInfo: rF2ScoringInfo,
    pub mVehicles: [rF2VehicleScoring; MAX_MAPPED_VEHICLES],
}

/// Complete rules buffer (C++: rF2Rules)
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2RulesBuffer {
    pub mVersionUpdateBegin: u32,
    pub mVersionUpdateEnd: u32,
    pub mBytesUpdatedHint: i32,
    pub mRules: rF2Rules,
}

/// Complete extended buffer (C++: rF2Extended)
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct rF2ExtendedBuffer {
    pub mVersionUpdateBegin: u32,
    pub mVersionUpdateEnd: u32,
    pub mBytesUpdatedHint: i32,
    pub mExtended: rF2Extended,
}

/// Complete weather buffer (C++: rF2Weather)
#[repr(C, packed(4))]
#[derive(Debug, Clone, Copy)]
pub struct rF2WeatherBuffer {
    pub mVersionUpdateBegin: u32,
    pub mVersionUpdateEnd: u32,
    pub mBytesUpdatedHint: i32,
    pub mWeather: rF2Weather,
}

// ---------------------------------------------------------------------------
// LMU Extended buffer — tembob64/LMU_SharedMemoryMapPlugin
//
// This is the buffer written by the tembob64 fork of rF2SharedMemoryMapPlugin.
// It uses the SAME MMF name ($rFactor2SMMP_Extended$) but a completely
// different struct layout.  When "EnableDirectMemoryAccess": 1 is set in the
// LMU plugin config, the DMA fields (TC, ARB, motor map, …) are populated.
//
// Layout derived from LMU_State.h in tembob64/LMU_SharedMemoryMapPlugin.
// Field order MUST match the C++ struct exactly (pack(4) rules apply).
// ---------------------------------------------------------------------------

/// Flat representation of the tembob64 LMU Extended shared-memory buffer.
///
/// The C++ struct `LMU_Extended : public LMU_MappedBufferHeader` lays out the
/// header fields first (via base-class inheritance), followed by the derived
/// fields listed here.  With `#[repr(C, packed(4))]` the Rust compiler inserts
/// padding identical to MSVC's `#pragma pack(push, 4)`.
///
/// Key DMA fields (populated when `mDirectMemoryAccessEnabled == 1`):
///   - `mpTractionControl`  — TC level
///   - `mFront_ABR / mRear_ABR` — anti-roll bar settings
///   - `mpMotorMap`          — engine/motor map name (up to 15 chars + NUL)
///   - `mpBrakeMigration`    — brake migration step
///   - `mpBrakeMigrationMax` — max brake migration steps
///   - energy / fuel values  — hybrid battery & energy store
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct LmuExtendedBuffer {
    // --- LMU_MappedBufferHeader (base class) ---
    pub mVersionUpdateBegin: u32,        // incremented before write
    pub mVersionUpdateEnd: u32,          // incremented after  write
    pub mBytesUpdatedHint: i32,

    // --- LMU_Extended own fields ---
    pub mVersion: [u8; 12],              // plugin version string
    pub mIs64bit: u8,                    // 1 if 64-bit plugin
    pub mInRealtimeFC: u8,
    pub mSessionStarted: u8,
    // 1 byte padding auto-inserted here (align u64 to 4)
    pub mTicksSessionStarted: u64,
    pub mTicksSessionEnded: u64,

    pub mDirectMemoryAccessEnabled: u8,  // 1 when DMA is active
    // 3 bytes padding auto-inserted here (align i32 to 4)
    pub mUnsubscribedBuffersMask: i32,   // bitmask of disabled buffers

    // --- DMA: electronics / driver aids ---
    pub mpBrakeMigration: i32,           // current brake migration setting
    pub mpBrakeMigrationMax: i32,        // maximum brake migration steps
    pub mpTractionControl: i32,          // TC level
    pub mpMotorMap: [u8; 16],            // engine map name (NUL-terminated)
    pub mChangedParamType: i32,          // type of last changed param (event)
    pub mChangedParamValue: [u8; 16],    // value of last changed param (event)
    pub mFront_ABR: i32,                 // front anti-roll bar setting
    pub mRear_ABR: i32,                  // rear  anti-roll bar setting

    // --- DMA: penalties ---
    pub mPenaltyType: i32,
    pub mPenaltyCount: i32,
    pub mPenaltyLeftLaps: i32,
    pub mPendingPenaltyType1: i32,
    pub mPendingPenaltyType2: i32,
    pub mPendingPenaltyType3: i32,
    pub mCuts: f32,
    pub mCutsPoints: i32,

    // --- DMA: hybrid / energy (6 × f64 block from process memory) ---
    pub mCurrentBatteryValue: f64,       // current battery charge (J or %)
    pub mMaxBatteryValue: f64,           // max battery capacity
    pub mCurrentEnergyValue: f64,        // current energy store (ERS/KERS)
    pub mMaxEnergyValue: f64,            // max energy store
    pub mCurrentFuelValue: f64,          // current fuel (litres)
    pub mMaxFuelValue: f64,              // fuel tank capacity (litres)
    pub mEnergyLastLap: f32,             // energy consumed on last lap
    pub mFuelLastLap: f32,               // fuel consumed on last lap
}

// ---------------------------------------------------------------------------
// Helper trait implementations
// ---------------------------------------------------------------------------

/// Convert a fixed-length null-terminated byte array to a &str (lossy)
pub fn bytes_to_str(bytes: &[u8]) -> &str {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end]).unwrap_or("<invalid utf8>")
}
