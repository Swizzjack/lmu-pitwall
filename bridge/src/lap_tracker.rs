/// Lap tracker — detects S/F line crossings for all vehicles and builds
/// per-driver snapshots combining scoring + telemetry data.
///
/// Called at the scoring update rate (~5 Hz). Snapshots are built only when a
/// vehicle completes a lap (mTotalLaps increases), or on first appearance, so
/// all-vehicle telemetry is never streamed at 50 Hz.

use std::collections::HashMap;

use crate::protocol::messages::{DriverLapSnapshot, ServerMessage, WheelSnapshot};
use crate::shared_memory::types::{
    bytes_to_str, rF2ScoringBuffer, rF2ScoringInfo, rF2TelemetryBuffer, rF2VehicleScoring,
    MAX_MAPPED_VEHICLES,
};

pub struct LapTracker {
    /// mID → total laps recorded on the previous scoring tick.
    last_laps: HashMap<i32, i32>,
    /// mID → latest driver snapshot (updated at each S/F crossing or initial appearance).
    pub snapshots: HashMap<i32, DriverLapSnapshot>,
    /// Session key used to detect session transitions.
    session_key: String,
}

impl LapTracker {
    pub fn new() -> Self {
        Self {
            last_laps: HashMap::new(),
            snapshots: HashMap::new(),
            session_key: String::new(),
        }
    }

    /// Process one scoring + telemetry frame.
    ///
    /// Returns `true` if any driver completed a lap (new S/F crossing detected).
    /// Call `build_message()` after this to get the updated `AllDriversUpdate`.
    pub fn process(
        &mut self,
        sc: &rF2ScoringBuffer,
        tel: Option<&rF2TelemetryBuffer>,
    ) -> bool {
        let info = &sc.mScoringInfo;

        // Detect session transitions — reset all state.
        let session_key = format!(
            "{}/{}",
            info.mSession,
            bytes_to_str(&info.mTrackName)
        );
        if session_key != self.session_key {
            self.reset();
            self.session_key = session_key;
        }

        let num_sc = (info.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
        let mut any_new = false;

        for i in 0..num_sc {
            let v = &sc.mVehicles[i];
            let id = v.mID;
            let total_laps = v.mTotalLaps as i32;

            // Detect mID reuse: if laps dropped for the same ID, a new driver
            // has been assigned this slot — discard the old snapshot.
            if let Some(&last) = self.last_laps.get(&id) {
                if total_laps < last {
                    self.snapshots.remove(&id);
                    self.last_laps.remove(&id);
                }
            }

            let last = *self.last_laps.get(&id).unwrap_or(&-1);
            let first_seen = last < 0;

            // A lap is completed when total_laps increases and is at least 1
            // (skip formation lap / out-lap where total_laps = 0).
            let lap_crossed = total_laps > last && total_laps >= 1;

            if lap_crossed || first_seen {
                let snap = build_snapshot(v, tel, info);
                self.snapshots.insert(id, snap);
                if lap_crossed {
                    any_new = true;
                }
            } else {
                // Update position and gaps on every tick even without a lap crossing
                // so that the standing order stays current.
                if let Some(snap) = self.snapshots.get_mut(&id) {
                    snap.position = v.mPlace as i32;
                    snap.gap_to_leader = v.mTimeBehindLeader;
                    snap.laps_behind_leader = v.mLapsBehindLeader;
                    snap.gap_ahead = v.mTimeBehindNext;
                    snap.in_pits = v.mInPits != 0;
                    snap.finish_status = v.mFinishStatus;
                }
            }

            self.last_laps.insert(id, total_laps);
        }

        any_new
    }

    /// Build an `AllDriversUpdate` from the current snapshot map.
    /// Returns `None` if no snapshots exist yet (game not yet connected / no vehicles).
    pub fn build_message(&self, session_type: &str, session_time: f64) -> Option<ServerMessage> {
        if self.snapshots.is_empty() {
            return None;
        }
        let mut drivers: Vec<DriverLapSnapshot> = self.snapshots.values().cloned().collect();
        // Sort by race position so the frontend receives them in order.
        drivers.sort_by_key(|d| d.position);
        Some(ServerMessage::AllDriversUpdate {
            session_type: session_type.to_string(),
            session_time,
            drivers,
        })
    }

    /// Clear all state (session change or game disconnect).
    pub fn reset(&mut self) {
        self.last_laps.clear();
        self.snapshots.clear();
    }

    pub fn has_snapshots(&self) -> bool {
        !self.snapshots.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

fn build_snapshot(
    v: &rF2VehicleScoring,
    tel: Option<&rF2TelemetryBuffer>,
    _info: &rF2ScoringInfo,
) -> DriverLapSnapshot {
    let last_sector3 = if v.mLastLapTime > 0.0 && v.mLastSector2 > 0.0 {
        v.mLastLapTime - v.mLastSector2
    } else {
        -1.0
    };

    // Find this vehicle's slot in the telemetry buffer (linear search by mID).
    let tel_veh = tel.and_then(|t| {
        let num = (t.mNumVehicles as usize).min(MAX_MAPPED_VEHICLES);
        t.mVehicles[..num].iter().find(|tv| tv.mID == v.mID)
    });

    let lv = tel_veh.map(|tv| tv.mLocalVel);
    let speed_ms = lv
        .map(|lv| (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z).sqrt())
        .unwrap_or(0.0);

    let wheels: [WheelSnapshot; 4] = if let Some(tv) = tel_veh {
        [0, 1, 2, 3].map(|i| WheelSnapshot {
            wear: tv.mWheels[i].mWear,
            // Kelvin → Celsius
            surface_temp: [
                tv.mWheels[i].mTemperature[0] - 273.15,
                tv.mWheels[i].mTemperature[1] - 273.15,
                tv.mWheels[i].mTemperature[2] - 273.15,
            ],
            carcass_temp: tv.mWheels[i].mTireCarcassTemperature - 273.15,
            inner_layer_temp: [
                tv.mWheels[i].mTireInnerLayerTemperature[0] - 273.15,
                tv.mWheels[i].mTireInnerLayerTemperature[1] - 273.15,
                tv.mWheels[i].mTireInnerLayerTemperature[2] - 273.15,
            ],
            pressure: tv.mWheels[i].mPressure,
            flat: tv.mWheels[i].mFlat != 0,
            detached: tv.mWheels[i].mDetached != 0,
        })
    } else {
        Default::default()
    };

    DriverLapSnapshot {
        id: v.mID,
        driver_name: bytes_to_str(&v.mDriverName).to_string(),
        vehicle_name: bytes_to_str(&v.mVehicleName).to_string(),
        class_name: bytes_to_str(&v.mVehicleClass).to_string(),
        position: v.mPlace as i32,
        total_laps: v.mTotalLaps as i32,
        last_lap_time: v.mLastLapTime,
        best_lap_time: v.mBestLapTime,
        last_sector1: v.mLastSector1,
        last_sector2: v.mLastSector2,
        last_sector3,
        gap_to_leader: v.mTimeBehindLeader,
        laps_behind_leader: v.mLapsBehindLeader,
        gap_ahead: v.mTimeBehindNext,
        num_pitstops: v.mNumPitstops as i32,
        in_pits: v.mInPits != 0,
        finish_status: v.mFinishStatus,
        fuel_remaining: tel_veh.map(|tv| tv.mFuel).unwrap_or(-1.0),
        fuel_capacity: tel_veh.map(|tv| tv.mFuelCapacity).unwrap_or(0.0),
        tire_compound_front: tel_veh.map(|tv| tv.mFrontTireCompoundIndex).unwrap_or(0),
        tire_compound_rear: tel_veh.map(|tv| tv.mRearTireCompoundIndex).unwrap_or(0),
        wheels,
        lap_start_et: v.mLapStartET,
        speed_ms,
        has_telemetry: tel_veh.is_some(),
    }
}
