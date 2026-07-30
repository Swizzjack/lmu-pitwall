//! The coverage table: every field the bridge reads from the plugin today,
//! paired with where it lives in `LMU_Data` and what a believable value is.
//!
//! This is the heart of the plugin-free proof. "LMU_Data is mapped and ticking"
//! only proves the game writes *something*; it says nothing about whether the
//! fields the dashboard actually consumes arrive intact. So each entry below
//! extracts one bridge-consumed field out of an `LMU_Data` snapshot and is
//! judged on three counts:
//!
//!   * **presence** — did we get a value at all?
//!   * **plausibility** — is it inside a window that a real car on a real track
//!     produces? This doubles as the layout check: a struct that shifted by a
//!     few bytes still decodes as a valid `f64`, but it decodes as a tire
//!     temperature of 3.7e-42 K, and the window catches that where a null check
//!     never would.
//!   * **liveness** — did it change over the run, where it should?
//!
//! The field list was taken from what `bridge/src/main.rs` actually reads, not
//! from what the structs offer. Fields the bridge ignores are not the probe's
//! business.

#![allow(non_snake_case)]
// The whole table is consumed by the Windows-only sampler; on Linux this file
// exists to be type-checked and to have its extractors compile.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use crate::types::*;

/// One `LMU_Data` snapshot, reduced to the three records the bridge uses.
///
/// Copies, not references: these live in a `#[repr(packed)]` map, where taking
/// a reference to a misaligned field is not allowed.
pub struct Sample {
    pub si: rF2ScoringInfo,
    /// The player's row in `vehScoringInfo`, if one was found.
    pub vs: Option<rF2VehicleScoring>,
    /// The player's entry in `telemInfo`, if the game reports a player car.
    pub vt: Option<rF2VehicleTelemetry>,
}

/// What we expect of a field, which decides how "always zero" is read.
#[derive(Clone, Copy, PartialEq)]
pub enum Need {
    /// Must be non-zero whenever the car is on track. Zero here is a defect.
    Nonzero,
    /// Must be non-zero *and* must change during the run (a clock, a position).
    Vary,
    /// Zero is a legitimate value (no penalty, no impact, leading the race).
    /// We can prove the offset decodes sanely, never that the game wrote it.
    MayZero,
}

pub struct Check {
    /// Which of the bridge's reads this belongs to.
    pub group: &'static str,
    pub name: &'static str,
    /// What breaks in the product if this field is wrong. Keep it short.
    pub consumer: &'static str,
    pub need: Need,
    pub lo: f64,
    pub hi: f64,
    pub get: fn(&Sample) -> Option<f64>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Verdict {
    /// Written, plausible, and varying where required.
    Ok,
    /// Plausible but never changed, where change was expected.
    Static,
    /// Always zero, and zero is allowed — decodes fine, unproven.
    ZeroOk,
    /// Always zero where the car on track must produce a value.
    Suspect,
    /// Outside the plausibility window — the strongest layout-drift signal.
    Implausible,
    /// Never extractable (no player car, no scoring row).
    NoData,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Ok => "OK",
            Verdict::Static => "STATIC",
            Verdict::ZeroOk => "zero (ok)",
            Verdict::Suspect => "SUSPECT",
            Verdict::Implausible => "IMPLAUSIBLE",
            Verdict::NoData => "NO DATA",
        }
    }

}

// ---------------------------------------------------------------------------
// Cross-check: the same physical quantity, read from both maps at once.
//
// Only possible while the plugin is installed, so it never runs during the
// plugin-free proof. It answers the complementary question: if we switch the
// bridge over, does any number on the dashboard change? Two maps written by the
// same physics tick must decode to identical bits.
// ---------------------------------------------------------------------------

pub struct XField {
    pub name: &'static str,
    pub get: fn(&rF2VehicleTelemetry) -> f64,
}

pub const XFIELDS: &[XField] = &[
    XField { name: "mElapsedTime", get: |v| v.mElapsedTime },
    XField { name: "mEngineRPM", get: |v| v.mEngineRPM },
    XField { name: "mFuel", get: |v| v.mFuel },
    XField { name: "FL mTemperature[centre]", get: |v| { let w = v.mWheels; let t = w[0].mTemperature; t[1] } },
    XField { name: "FL mBrakeTemp", get: |v| { let w = v.mWheels; w[0].mBrakeTemp } },
    XField { name: "FL mPressure", get: |v| { let w = v.mWheels; w[0].mPressure } },
    XField { name: "FL mWear", get: |v| { let w = v.mWheels; w[0].mWear } },
    XField { name: "mVirtualEnergy", get: |v| v.mVirtualEnergy as f64 },
];

/// The same accessors, pointed at the cars we are *not* driving.
///
/// LMU_Data reserves a telemetry row per car, and the standings widget proves
/// at least `mVirtualEnergy` is filled for all of them. Whether fuel and tire
/// wear are too decides something concrete: online result XMLs carry neither
/// for anybody, so if these rows are real, a whole field's stint data is
/// there for the taking — and if they are flat zero, only our own car is.
///
/// `mElapsedTime` and `mLapNumber` are the controls: they must move for a car
/// that is driving, and if they do not, the row is a placeholder and nothing
/// else in it means anything.
pub const OPPONENT_FIELDS: &[XField] = &[
    XField { name: "mElapsedTime", get: |v| v.mElapsedTime },
    XField { name: "mLapNumber", get: |v| v.mLapNumber as f64 },
    XField { name: "mVirtualEnergy", get: |v| v.mVirtualEnergy as f64 },
    XField { name: "mFuel", get: |v| v.mFuel },
    XField { name: "mFuelCapacity", get: |v| v.mFuelCapacity },
    XField { name: "FL mWear", get: |v| { let w = v.mWheels; w[0].mWear } },
    XField { name: "RR mWear", get: |v| { let w = v.mWheels; w[3].mWear } },
];

#[derive(Default)]
pub struct Stat {
    pub present: u64,
    pub nonzero: u64,
    pub changes: u64,
    pub out_of_range: u64,
    pub min: f64,
    pub max: f64,
    first: bool,
    last: Option<u64>,
}

impl Stat {
    pub fn record(&mut self, v: f64, lo: f64, hi: f64) {
        self.present += 1;
        if !self.first {
            self.min = v;
            self.max = v;
            self.first = true;
        }
        self.min = self.min.min(v);
        self.max = self.max.max(v);
        if v != 0.0 {
            self.nonzero += 1;
        }
        // NaN fails every comparison, so test it explicitly rather than letting
        // it slip through the range check as "not out of range".
        if v.is_nan() || v < lo || v > hi {
            self.out_of_range += 1;
        }
        let bits = v.to_bits();
        if let Some(prev) = self.last {
            if prev != bits {
                self.changes += 1;
            }
        }
        self.last = Some(bits);
    }

    pub fn verdict(&self, need: Need) -> Verdict {
        if self.present == 0 {
            return Verdict::NoData;
        }
        if self.out_of_range > 0 {
            return Verdict::Implausible;
        }
        if self.nonzero == 0 {
            return match need {
                Need::MayZero => Verdict::ZeroOk,
                _ => Verdict::Suspect,
            };
        }
        if need == Need::Vary && self.changes == 0 {
            return Verdict::Static;
        }
        Verdict::Ok
    }
}

// ---------------------------------------------------------------------------
// Extractors
//
// Written as plain `fn` items rather than closures so the table stays a `const`
// slice. Every one copies its value out of the packed struct.
// ---------------------------------------------------------------------------

/// Pull a `f64` out of the player's telemetry record.
macro_rules! vt {
    ($f:ident) => {
        |s: &Sample| s.vt.map(|v| v.$f as f64)
    };
}

/// Pull a `f64` out of the player's scoring record.
macro_rules! vs {
    ($f:ident) => {
        |s: &Sample| s.vs.map(|v| v.$f as f64)
    };
}

/// Pull a `f64` out of the session-wide scoring info.
macro_rules! si {
    ($f:ident) => {
        |s: &Sample| Some(s.si.$f as f64)
    };
}

/// Pull a per-wheel value. The wheel array is copied out first — indexing a
/// packed field in place would take a misaligned reference.
macro_rules! wheel {
    ($i:expr, $f:ident) => {
        |s: &Sample| {
            s.vt.map(|v| {
                let w = v.mWheels;
                w[$i].$f as f64
            })
        }
    };
    ($i:expr, $f:ident [$j:expr]) => {
        |s: &Sample| {
            s.vt.map(|v| {
                let w = v.mWheels;
                let f = w[$i].$f;
                f[$j] as f64
            })
        }
    };
}

/// Kelvin windows are wide on purpose. A cold brake is ~290 K and a hot one
/// ~1100 K; if LMU 1.4 switched `mBrakeTemp` to Celsius the values land in
/// 20…800 and the low end trips the window — which is the open question from
/// the V1.4 notes, and why the observed min/max is printed alongside.
const K_COLD: f64 = 240.0;

/// `mMaxLaps` in a timed race is a sentinel, not a lap count: rF2 documents
/// 999999, LMU 1.4 was measured writing `i32::MAX`. The bridge treats anything
/// `>= 999_000` as "not lap-limited" (`main.rs:368`, `state.rs:385`), so the
/// window has to admit it. That costs this field as a layout anchor — every
/// `i32` bit pattern is now inside the window — which is acceptable: the
/// anchors that actually catch a shift are the `f64`s around it (`mLapDist`
/// reading the track length to the centimetre, `mEndET`).
const MAX_LAPS_SENTINEL: f64 = i32::MAX as f64;

/// A lap timer that has never been started reads -1, not 0: LMU writes -1 into
/// `mLapStartET`, `mBestLapTime` and `mCurSector1/2` until the car first
/// crosses the line. A run where the driver never completes a lap therefore
/// shows -1 in every sample, and the consumers already expect it
/// (`state.rs:477` requires `lap_start > 0.0`, `LapTiming.tsx` requires
/// `lapStartEt >= 0`). Windows starting at 0.0 flagged that as IMPLAUSIBLE and
/// pointed at the layout, where nothing was wrong.
const NO_LAP_YET: f64 = -1.0;

pub const CHECKS: &[Check] = &[
    // --- Session-wide scoring: SessionInfo, weather widget, race engineer ----
    Check { group: "scoring / session", name: "mCurrentET", consumer: "session clock", need: Need::Vary, lo: 0.0, hi: 1.0e6, get: si!(mCurrentET) },
    Check { group: "scoring / session", name: "mSession", consumer: "session type", need: Need::MayZero, lo: 0.0, hi: 20.0, get: si!(mSession) },
    // Before the green flag LMU has no session end time yet and writes
    // `i32::MIN` into this f64 — measured as exactly -2147483648.0 during the
    // grid phase of a Monza race, resolving to a sane 2467.0 once running. Like
    // `mMaxLaps` this costs the field its lower layout bound; the consumers all
    // guard it already (`main.rs:369`, `state.rs:357`, `state.rs:595` require
    // `> 0.0`).
    Check { group: "scoring / session", name: "mEndET", consumer: "session length (INT32_MIN before green)", need: Need::MayZero, lo: i32::MIN as f64, hi: 1.0e6, get: si!(mEndET) },
    Check { group: "scoring / session", name: "mMaxLaps", consumer: "lap-limited races (>=999000 = timed)", need: Need::MayZero, lo: 0.0, hi: MAX_LAPS_SENTINEL, get: si!(mMaxLaps) },
    Check { group: "scoring / session", name: "mLapDist", consumer: "track length, fuel calc", need: Need::Nonzero, lo: 300.0, hi: 30000.0, get: si!(mLapDist) },
    Check { group: "scoring / session", name: "mNumVehicles", consumer: "field size, standings", need: Need::Nonzero, lo: 1.0, hi: 104.0, get: si!(mNumVehicles) },
    Check { group: "scoring / session", name: "mGamePhase", consumer: "SessionPhase, engineer rules", need: Need::MayZero, lo: 0.0, hi: 9.0, get: si!(mGamePhase) },
    Check { group: "scoring / session", name: "mYellowFlagState", consumer: "flag display, SC substitute", need: Need::MayZero, lo: -1.0, hi: 8.0, get: si!(mYellowFlagState) },
    // LMU does not use rF2's 0=clear encoding here: 1 = yellow, 11 = clear, and
    // the bridge compares `== 1` (`state.rs:530`). Window widened to the byte
    // range LMU actually writes; rF2's 0..8 called a green sector IMPLAUSIBLE.
    Check { group: "scoring / session", name: "mSectorFlag[0]", consumer: "sector flags (LMU: 1=yellow, 11=clear)", need: Need::MayZero, lo: 0.0, hi: 15.0, get: |s| { let f = s.si.mSectorFlag; Some(f[0] as f64) } },
    Check { group: "scoring / session", name: "mStartLight", consumer: "start lights", need: Need::MayZero, lo: 0.0, hi: 10.0, get: si!(mStartLight) },
    Check { group: "scoring / session", name: "mSessionTimeRemaining", consumer: "time remaining, stint plan", need: Need::MayZero, lo: 0.0, hi: 1.0e6, get: si!(mSessionTimeRemaining) },

    // --- Weather (scoring-side; the SMMP Weather buffer is opened but unread) -
    Check { group: "scoring / weather", name: "mAmbientTemp", consumer: "weather widget", need: Need::Nonzero, lo: -30.0, hi: 60.0, get: si!(mAmbientTemp) },
    Check { group: "scoring / weather", name: "mTrackTemp", consumer: "weather widget, tire model", need: Need::Nonzero, lo: -30.0, hi: 90.0, get: si!(mTrackTemp) },
    Check { group: "scoring / weather", name: "mRaining", consumer: "rain indicator", need: Need::MayZero, lo: 0.0, hi: 1.0, get: si!(mRaining) },
    Check { group: "scoring / weather", name: "mDarkCloud", consumer: "cloud cover", need: Need::MayZero, lo: 0.0, hi: 1.0, get: si!(mDarkCloud) },
    Check { group: "scoring / weather", name: "mMinPathWetness", consumer: "wetness range", need: Need::MayZero, lo: 0.0, hi: 100.0, get: si!(mMinPathWetness) },
    Check { group: "scoring / weather", name: "mMaxPathWetness", consumer: "wetness range", need: Need::MayZero, lo: 0.0, hi: 100.0, get: si!(mMaxPathWetness) },
    Check { group: "scoring / weather", name: "mAvgPathWetness", consumer: "wetness average", need: Need::MayZero, lo: 0.0, hi: 100.0, get: si!(mAvgPathWetness) },
    Check { group: "scoring / weather", name: "mWind.x", consumer: "wind display", need: Need::MayZero, lo: -60.0, hi: 60.0, get: |s| { let w = s.si.mWind; Some(w.x) } },

    // --- LMU-native scoring extras (former mExpansion) -----------------------
    Check { group: "scoring / LMU-native", name: "mTimeOfDay", consumer: "time of day", need: Need::MayZero, lo: 0.0, hi: 86400.0, get: si!(mTimeOfDay) },
    Check { group: "scoring / LMU-native", name: "mTrackGripLevel", consumer: "grip level", need: Need::MayZero, lo: 0.0, hi: 4.0, get: si!(mTrackGripLevel) },
    Check { group: "scoring / LMU-native", name: "mCloudCoverage", consumer: "sky type", need: Need::MayZero, lo: 0.0, hi: 10.0, get: si!(mCloudCoverage) },
    Check { group: "scoring / LMU-native", name: "mIsFixedSetup", consumer: "setup lock badge", need: Need::MayZero, lo: 0.0, hi: 1.0, get: si!(mIsFixedSetup) },

    // --- Per-vehicle scoring: standings, proximity, gaps ---------------------
    Check { group: "vehScoring / player", name: "mIsPlayer", consumer: "finding the player row", need: Need::Nonzero, lo: 1.0, hi: 1.0, get: vs!(mIsPlayer) },
    Check { group: "vehScoring / player", name: "mID", consumer: "vehicle identity across buffers", need: Need::MayZero, lo: 0.0, hi: 1.0e6, get: vs!(mID) },
    Check { group: "vehScoring / player", name: "mPlace", consumer: "position widget", need: Need::Nonzero, lo: 1.0, hi: 104.0, get: vs!(mPlace) },
    // Negative is normal and can be large: the pit lane is measured backwards
    // from the start/finish line, and at Sebring a car in its box reads about
    // -1100 m. A window of -200 called an out lap from the garage a layout
    // shift. Only the upper bound is a real layout guard here.
    Check { group: "vehScoring / player", name: "mLapDist", consumer: "track map, proximity, gaps", need: Need::Vary, lo: -3000.0, hi: 30000.0, get: vs!(mLapDist) },
    Check { group: "vehScoring / player", name: "mTotalLaps", consumer: "lap counter", need: Need::MayZero, lo: 0.0, hi: 5000.0, get: vs!(mTotalLaps) },
    Check { group: "vehScoring / player", name: "mSector", consumer: "sector display", need: Need::MayZero, lo: 0.0, hi: 3.0, get: vs!(mSector) },
    Check { group: "vehScoring / player", name: "mCurSector1", consumer: "live sector times", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mCurSector1) },
    Check { group: "vehScoring / player", name: "mCurSector2", consumer: "live sector times", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mCurSector2) },
    Check { group: "vehScoring / player", name: "mLastSector1", consumer: "sector comparison", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mLastSector1) },
    Check { group: "vehScoring / player", name: "mLastSector2", consumer: "sector comparison", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mLastSector2) },
    Check { group: "vehScoring / player", name: "mBestSector1", consumer: "best sectors", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mBestSector1) },
    Check { group: "vehScoring / player", name: "mBestSector2", consumer: "best sectors", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mBestSector2) },
    Check { group: "vehScoring / player", name: "mBestLapTime", consumer: "best lap", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mBestLapTime) },
    Check { group: "vehScoring / player", name: "mLastLapTime", consumer: "last lap, pace rules", need: Need::MayZero, lo: -1.0, hi: 3600.0, get: vs!(mLastLapTime) },
    Check { group: "vehScoring / player", name: "mLapStartET", consumer: "current lap timer (-1 = no lap yet)", need: Need::MayZero, lo: NO_LAP_YET, hi: 1.0e6, get: vs!(mLapStartET) },
    // Signed, and only meaningful in a race: in practice LMU writes a
    // leader-relative delta that swings either way (-70…+109 s measured at
    // Sebring while the player held P1…P7), because there is no running order
    // to be behind. The old `lo: -1.0` read that as a layout shift. The bound
    // that still does layout work is the magnitude — a gap beyond two hours is
    // not a gap — so `hi` is tightened from 1e6 in exchange for allowing
    // negatives.
    Check { group: "vehScoring / player", name: "mTimeBehindLeader", consumer: "gap to leader (race only)", need: Need::MayZero, lo: -7200.0, hi: 7200.0, get: vs!(mTimeBehindLeader) },
    Check { group: "vehScoring / player", name: "mLapsBehindLeader", consumer: "lapped status", need: Need::MayZero, lo: 0.0, hi: 5000.0, get: vs!(mLapsBehindLeader) },
    Check { group: "vehScoring / player", name: "mInPits", consumer: "pit state, pit rules", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vs!(mInPits) },
    Check { group: "vehScoring / player", name: "mFlag", consumer: "flag display", need: Need::MayZero, lo: 0.0, hi: 10.0, get: vs!(mFlag) },
    Check { group: "vehScoring / player", name: "mUnderYellow", consumer: "yellow for this car", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vs!(mUnderYellow) },
    Check { group: "vehScoring / player", name: "mIndividualPhase", consumer: "per-car phase", need: Need::MayZero, lo: 0.0, hi: 9.0, get: vs!(mIndividualPhase) },
    Check { group: "vehScoring / player", name: "mPos.x", consumer: "track map", need: Need::Vary, lo: -20000.0, hi: 20000.0, get: |s| s.vs.map(|v| { let p = v.mPos; p.x }) },

    // --- Player telemetry: the high-rate widgets -----------------------------
    Check { group: "telemetry / player", name: "mID", consumer: "matching scoring ↔ telemetry", need: Need::MayZero, lo: 0.0, hi: 1.0e6, get: vt!(mID) },
    Check { group: "telemetry / player", name: "mElapsedTime", consumer: "telemetry clock", need: Need::Vary, lo: 0.0, hi: 1.0e6, get: vt!(mElapsedTime) },
    Check { group: "telemetry / player", name: "mLapStartET", consumer: "lap timing (-1 = no lap yet)", need: Need::MayZero, lo: NO_LAP_YET, hi: 1.0e6, get: vt!(mLapStartET) },
    Check { group: "telemetry / player", name: "mGear", consumer: "gear display", need: Need::MayZero, lo: -1.0, hi: 10.0, get: vt!(mGear) },
    Check { group: "telemetry / player", name: "mEngineRPM", consumer: "RPM gauge, shift light", need: Need::Vary, lo: 0.0, hi: 22000.0, get: vt!(mEngineRPM) },
    Check { group: "telemetry / player", name: "mEngineMaxRPM", consumer: "shift light scale", need: Need::Nonzero, lo: 1000.0, hi: 22000.0, get: vt!(mEngineMaxRPM) },
    Check { group: "telemetry / player", name: "mEngineWaterTemp", consumer: "engine temps (°C)", need: Need::Nonzero, lo: -10.0, hi: 250.0, get: vt!(mEngineWaterTemp) },
    Check { group: "telemetry / player", name: "mEngineOilTemp", consumer: "engine temps (°C)", need: Need::Nonzero, lo: -10.0, hi: 300.0, get: vt!(mEngineOilTemp) },
    Check { group: "telemetry / player", name: "mFuel", consumer: "fuel calculator", need: Need::Nonzero, lo: 0.0, hi: 250.0, get: vt!(mFuel) },
    Check { group: "telemetry / player", name: "mFuelCapacity", consumer: "fuel calculator", need: Need::Nonzero, lo: 1.0, hi: 250.0, get: vt!(mFuelCapacity) },
    Check { group: "telemetry / player", name: "mFilteredThrottle", consumer: "pedal trace", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vt!(mFilteredThrottle) },
    Check { group: "telemetry / player", name: "mFilteredBrake", consumer: "pedal trace", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vt!(mFilteredBrake) },
    Check { group: "telemetry / player", name: "mFilteredClutch", consumer: "pedal trace", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vt!(mFilteredClutch) },
    Check { group: "telemetry / player", name: "mFilteredSteering", consumer: "steering trace", need: Need::MayZero, lo: -1.5, hi: 1.5, get: vt!(mFilteredSteering) },
    Check { group: "telemetry / player", name: "mLocalVel.z", consumer: "speed", need: Need::Vary, lo: -200.0, hi: 200.0, get: |s| s.vt.map(|v| { let x = v.mLocalVel; x.z }) },
    Check { group: "telemetry / player", name: "mLocalAccel.x", consumer: "G-force meter", need: Need::MayZero, lo: -100.0, hi: 100.0, get: |s| s.vt.map(|v| { let a = v.mLocalAccel; a.x }) },
    Check { group: "telemetry / player", name: "mOri[0].x", consumer: "car heading on the map", need: Need::MayZero, lo: -1.5, hi: 1.5, get: |s| s.vt.map(|v| { let o = v.mOri; let r = o[0]; r.x }) },
    Check { group: "telemetry / player", name: "mDeltaBest", consumer: "delta widget", need: Need::MayZero, lo: -3600.0, hi: 3600.0, get: vt!(mDeltaBest) },
    Check { group: "telemetry / player", name: "mOverheating", consumer: "damage indicator", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vt!(mOverheating) },
    Check { group: "telemetry / player", name: "mDetached", consumer: "damage indicator", need: Need::MayZero, lo: 0.0, hi: 1.0, get: vt!(mDetached) },
    Check { group: "telemetry / player", name: "mDentSeverity[0]", consumer: "damage indicator", need: Need::MayZero, lo: 0.0, hi: 2.0, get: |s| s.vt.map(|v| { let d = v.mDentSeverity; d[0] as f64 }) },
    Check { group: "telemetry / player", name: "mLastImpactET", consumer: "impact detection", need: Need::MayZero, lo: 0.0, hi: 1.0e6, get: vt!(mLastImpactET) },
    Check { group: "telemetry / player", name: "mLastImpactMagnitude", consumer: "impact detection", need: Need::MayZero, lo: 0.0, hi: 1.0e12, get: vt!(mLastImpactMagnitude) },
    // Hypercar only: measured 0.87…1.0 in a Genesis LMH, flat zero in an ELMS
    // LMP2, which has neither an energy allocation nor a hybrid system. Zero in
    // a non-Hypercar is the field working, not the field missing.
    Check { group: "telemetry / player", name: "mVirtualEnergy", consumer: "energy widget (Hypercar only)", need: Need::MayZero, lo: 0.0, hi: 1.5, get: vt!(mVirtualEnergy) },
    Check { group: "telemetry / player", name: "mBatteryChargeFraction", consumer: "hybrid widget (Hypercar only)", need: Need::MayZero, lo: 0.0, hi: 1.5, get: vt!(mBatteryChargeFraction) },

    // --- Wheels: TireMonitor. FL only for temps that all four share a model --
    Check { group: "telemetry / wheels", name: "FL mTemperature[centre]", consumer: "TireMonitor (K)", need: Need::Nonzero, lo: K_COLD, hi: 500.0, get: wheel!(0, mTemperature[1]) },
    Check { group: "telemetry / wheels", name: "FR mTemperature[centre]", consumer: "TireMonitor (K)", need: Need::Nonzero, lo: K_COLD, hi: 500.0, get: wheel!(1, mTemperature[1]) },
    Check { group: "telemetry / wheels", name: "RL mTemperature[centre]", consumer: "TireMonitor (K)", need: Need::Nonzero, lo: K_COLD, hi: 500.0, get: wheel!(2, mTemperature[1]) },
    Check { group: "telemetry / wheels", name: "RR mTemperature[centre]", consumer: "TireMonitor (K)", need: Need::Nonzero, lo: K_COLD, hi: 500.0, get: wheel!(3, mTemperature[1]) },
    Check { group: "telemetry / wheels", name: "FL mTireCarcassTemperature", consumer: "TireMonitor carcass (K)", need: Need::Nonzero, lo: K_COLD, hi: 500.0, get: wheel!(0, mTireCarcassTemperature) },
    Check { group: "telemetry / wheels", name: "FL mBrakeTemp", consumer: "brake temps — Kelvin?", need: Need::Nonzero, lo: K_COLD, hi: 1800.0, get: wheel!(0, mBrakeTemp) },
    Check { group: "telemetry / wheels", name: "RR mBrakeTemp", consumer: "brake temps — Kelvin?", need: Need::Nonzero, lo: K_COLD, hi: 1800.0, get: wheel!(3, mBrakeTemp) },
    Check { group: "telemetry / wheels", name: "FL mPressure", consumer: "tire pressures (kPa)", need: Need::Nonzero, lo: 30.0, hi: 400.0, get: wheel!(0, mPressure) },
    Check { group: "telemetry / wheels", name: "RR mPressure", consumer: "tire pressures (kPa)", need: Need::Nonzero, lo: 30.0, hi: 400.0, get: wheel!(3, mPressure) },
    Check { group: "telemetry / wheels", name: "FL mWear", consumer: "tire wear (1.0 = new)", need: Need::Nonzero, lo: 0.0, hi: 1.0, get: wheel!(0, mWear) },
    Check { group: "telemetry / wheels", name: "RR mWear", consumer: "tire wear (1.0 = new)", need: Need::Nonzero, lo: 0.0, hi: 1.0, get: wheel!(3, mWear) },
    Check { group: "telemetry / wheels", name: "FL mFlat", consumer: "puncture warning", need: Need::MayZero, lo: 0.0, hi: 1.0, get: wheel!(0, mFlat) },
    Check { group: "telemetry / wheels", name: "FL mDetached", consumer: "wheel-off warning", need: Need::MayZero, lo: 0.0, hi: 1.0, get: wheel!(0, mDetached) },
    Check { group: "telemetry / wheels", name: "FL mGripFract", consumer: "grip fraction", need: Need::MayZero, lo: 0.0, hi: 2.0, get: wheel!(0, mGripFract) },
];

// ---------------------------------------------------------------------------
// String fields — same idea, judged on "non-empty and printable" instead.
// ---------------------------------------------------------------------------

pub struct StringCheck {
    pub name: &'static str,
    pub consumer: &'static str,
    pub get: fn(&Sample) -> Option<String>,
}

/// Copy a fixed byte array out of the packed struct, then decode it.
macro_rules! text {
    ($src:ident, $f:ident) => {
        |s: &Sample| {
            s.$src.map(|v| {
                let b = v.$f;
                bytes_to_str(&b).to_string()
            })
        }
    };
}

pub const STRING_CHECKS: &[StringCheck] = &[
    StringCheck { name: "mTrackName", consumer: "track name, post-race", get: |s| { let b = s.si.mTrackName; Some(bytes_to_str(&b).to_string()) } },
    StringCheck { name: "mPlayerName", consumer: "driver identity", get: |s| { let b = s.si.mPlayerName; Some(bytes_to_str(&b).to_string()) } },
    StringCheck { name: "vs.mDriverName", consumer: "standings", get: text!(vs, mDriverName) },
    StringCheck { name: "vs.mVehicleName", consumer: "standings", get: text!(vs, mVehicleName) },
    StringCheck { name: "vs.mVehicleClass", consumer: "class colours, multi-class", get: text!(vs, mVehicleClass) },
    StringCheck { name: "vt.mFrontTireCompoundName", consumer: "TireMonitor compound", get: text!(vt, mFrontTireCompoundName) },
];

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Default)]
pub struct StringStat {
    pub present: u64,
    pub nonempty: u64,
    pub garbled: u64,
    pub example: String,
}

impl StringStat {
    pub fn record(&mut self, v: &str) {
        self.present += 1;
        if v.is_empty() {
            return;
        }
        self.nonempty += 1;
        // Anything that is not printable ASCII plus common accents means we are
        // reading the wrong bytes — the string equivalent of an out-of-range f64.
        if v.chars().any(|c| c.is_control()) {
            self.garbled += 1;
        }
        if self.example.is_empty() {
            // Marked when it is cut, because a silently clipped example reads
            // exactly like a decoding bug: "Sebring International Racewa" and
            // a 28-char car name in the same report look like a truncating
            // reader, when both were merely longer than the display width.
            const WIDTH: usize = 48;
            self.example = if v.chars().count() > WIDTH {
                v.chars().take(WIDTH - 1).chain("…".chars()).collect()
            } else {
                v.to_string()
            };
        }
    }

    pub fn verdict(&self) -> Verdict {
        if self.present == 0 {
            Verdict::NoData
        } else if self.garbled > 0 {
            Verdict::Implausible
        } else if self.nonempty == 0 {
            Verdict::Suspect
        } else {
            Verdict::Ok
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — these run on Linux, which is the point: the coverage table is the
// part most likely to be wrong, and finding that out on the sim machine after a
// 120-second driving session is the expensive way to find out.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Safety: every struct involved is a `#[repr(C, packed)]` POD of integers,
    /// floats and byte arrays, for which all-zero is a valid value.
    fn zeroed_sample() -> Sample {
        unsafe {
            Sample {
                si: std::mem::zeroed(),
                vs: Some(std::mem::zeroed()),
                vt: Some(std::mem::zeroed()),
            }
        }
    }

    /// Every extractor must survive a snapshot where the player exists but
    /// nothing has happened yet — the state during a session load.
    #[test]
    fn every_extractor_runs_on_a_zeroed_sample() {
        let s = zeroed_sample();
        for c in CHECKS {
            assert!((c.get)(&s).is_some(), "{} returned None with a player present", c.name);
        }
        for c in STRING_CHECKS {
            assert!((c.get)(&s).is_some(), "{} returned None with a player present", c.name);
        }
    }

    /// With no player car, the player-scoped checks must report NO DATA rather
    /// than panicking or silently reporting a zero as a real reading.
    #[test]
    fn no_player_yields_no_data() {
        let s = Sample { vs: None, vt: None, ..zeroed_sample() };
        for c in CHECKS {
            let is_session_wide = c.group.starts_with("scoring");
            assert_eq!(
                (c.get)(&s).is_some(),
                is_session_wide,
                "{} extracted the wrong thing without a player",
                c.name
            );
        }
    }

    /// `lo == hi` is allowed — `mIsPlayer` is only ever 1 on the player's row —
    /// but an inverted window would silently mark every reading implausible.
    #[test]
    fn every_window_is_a_window() {
        for c in CHECKS {
            assert!(c.lo <= c.hi, "{}: inverted plausibility window", c.name);
        }
    }

    /// A value inside the window that changes is the only combination that
    /// counts as proven.
    #[test]
    fn verdicts_follow_the_evidence() {
        let mut s = Stat::default();
        s.record(300.0, 240.0, 500.0);
        s.record(310.0, 240.0, 500.0);
        assert_eq!(s.verdict(Need::Vary), Verdict::Ok);

        let mut constant = Stat::default();
        constant.record(300.0, 240.0, 500.0);
        constant.record(300.0, 240.0, 500.0);
        assert_eq!(constant.verdict(Need::Vary), Verdict::Static);
        assert_eq!(constant.verdict(Need::Nonzero), Verdict::Ok);

        let mut zero = Stat::default();
        zero.record(0.0, 0.0, 1.0);
        assert_eq!(zero.verdict(Need::MayZero), Verdict::ZeroOk);
        assert_eq!(zero.verdict(Need::Nonzero), Verdict::Suspect);

        let empty = Stat::default();
        assert_eq!(empty.verdict(Need::MayZero), Verdict::NoData);
    }

    /// The whole point of the plausibility windows: a shifted struct still
    /// decodes as a valid f64, so "is not zero" would pass it. Only the range
    /// catches it — and NaN, which fails every comparison, must not slip past.
    #[test]
    fn garbage_is_implausible_not_merely_nonzero() {
        let mut shifted = Stat::default();
        shifted.record(3.7e-42, 240.0, 500.0);
        assert_ne!(shifted.nonzero, 0);
        assert_eq!(shifted.verdict(Need::Nonzero), Verdict::Implausible);

        let mut nan = Stat::default();
        nan.record(f64::NAN, 240.0, 500.0);
        assert_eq!(nan.verdict(Need::Nonzero), Verdict::Implausible);
    }

    /// Six IMPLAUSIBLE verdicts across the 2026-07-29 Monza and Sebring runs
    /// were not layout drift at all — they were values LMU legitimately writes
    /// that the windows did not admit. Each entry below was observed in one of
    /// those runs and is handled correctly by the bridge; a window that rejects
    /// them sends the reader hunting for an offset bug that does not exist.
    ///
    /// Keyed by group as well as name, because `mLapDist` means two different
    /// things: the session-wide one is the track length and must stay strictly
    /// positive, the per-vehicle one goes negative in the pit lane.
    #[test]
    fn known_sentinels_are_not_mistaken_for_layout_drift() {
        let sentinels: &[(&str, &str, f64)] = &[
            // Timed race: LMU 1.4 writes i32::MAX where rF2 documents 999999.
            ("scoring / session", "mMaxLaps", i32::MAX as f64),
            // Green sector, LMU encoding — 11 is clear, not out of range.
            ("scoring / session", "mSectorFlag[0]", 11.0),
            // Never crossed the line: both buffers hold -1, not 0.
            ("vehScoring / player", "mLapStartET", -1.0),
            ("telemetry / player", "mLapStartET", -1.0),
            // Sebring: a car in its pit box, measured backwards from the line.
            ("vehScoring / player", "mLapDist", -1078.05),
            ("scoring / session", "mLapDist", 5820.33),
            // Practice: the leader gap swings negative, there being no order.
            ("vehScoring / player", "mTimeBehindLeader", -69.62),
            // Monza race, grid phase: no end time decided yet.
            ("scoring / session", "mEndET", i32::MIN as f64),
            ("scoring / session", "mEndET", 2467.0),
        ];

        for (group, name, value) in sentinels {
            let mut found = 0;
            for c in CHECKS.iter().filter(|c| c.name == *name && c.group == *group) {
                found += 1;
                let mut s = Stat::default();
                s.record(*value, c.lo, c.hi);
                assert_ne!(
                    s.verdict(c.need),
                    Verdict::Implausible,
                    "[{group}] {name} = {value} is a value LMU writes in a normal \
                     session, but the window [{}, {}] rejects it",
                    c.lo,
                    c.hi,
                );
            }
            assert!(found > 0, "no check [{group}] {name} — did the table get renamed?");
        }
    }

    /// Strings are the other layout tell: a shifted offset lands mid-struct and
    /// decodes as control characters.
    #[test]
    fn garbled_strings_are_implausible() {
        let mut good = StringStat::default();
        good.record("Le Mans");
        assert_eq!(good.verdict(), Verdict::Ok);
        assert_eq!(good.example, "Le Mans");

        let mut bad = StringStat::default();
        bad.record("\u{1}\u{2}\u{3}");
        assert_eq!(bad.verdict(), Verdict::Implausible);

        let mut blank = StringStat::default();
        blank.record("");
        assert_eq!(blank.verdict(), Verdict::Suspect);
    }
}
