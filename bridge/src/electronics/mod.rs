//! Electronics snapshot — reads driver aid settings directly from LMU v1.3
//! shared memory telemetry fields (mTC, mABS, mMotorMap, etc.).
//!
//! No button counting or garage API needed — values come straight from TelemInfoV01.

use crate::shared_memory::types::rF2VehicleTelemetry;

/// Snapshot of all electronics / driver aid values for the frontend.
#[derive(Debug, Clone, Default)]
pub struct ElectronicsSnapshot {
    pub tc: u8,
    pub tc_max: u8,
    pub tc_cut: u8,
    pub tc_cut_max: u8,
    pub tc_slip: u8,
    pub tc_slip_max: u8,
    pub abs: u8,
    pub abs_max: u8,
    pub engine_map: u8,
    pub engine_map_max: u8,
    pub front_arb: u8,
    pub front_arb_max: u8,
    pub rear_arb: u8,
    pub rear_arb_max: u8,
    pub brake_bias: f64,          // front brake bias percent (e.g. 56.0)
    pub regen: f32,               // regeneration in kW
    pub brake_migration: u8,
    pub brake_migration_max: u8,
    pub battery_pct: f64,         // mBatteryChargeFraction [0.0–1.0]
    pub soc: f32,                 // mSoC
    pub virtual_energy: f32,      // mVirtualEnergy
    pub tc_active: bool,          // TC currently intervening
    pub abs_active: bool,         // ABS currently intervening
    pub delta_best: f64,          // mDeltaBest (seconds)
}

impl ElectronicsSnapshot {
    /// Build a snapshot directly from a player's telemetry struct.
    pub fn from_telemetry(veh: &rF2VehicleTelemetry) -> Self {
        let front_bias_pct = (1.0 - veh.mRearBrakeBias) * 100.0;
        Self {
            tc: veh.mTC,
            tc_max: veh.mTCMax,
            tc_cut: veh.mTCCut,
            tc_cut_max: veh.mTCCutMax,
            tc_slip: veh.mTCSlip,
            tc_slip_max: veh.mTCSlipMax,
            abs: veh.mABS,
            abs_max: veh.mABSMax,
            engine_map: veh.mMotorMap,
            engine_map_max: veh.mMotorMapMax,
            front_arb: veh.mFrontAntiSway,
            front_arb_max: veh.mFrontAntiSwayMax,
            rear_arb: veh.mRearAntiSway,
            rear_arb_max: veh.mRearAntiSwayMax,
            brake_bias: front_bias_pct,
            regen: veh.mRegen,
            brake_migration: veh.mMigration,
            brake_migration_max: veh.mMigrationMax,
            battery_pct: veh.mBatteryChargeFraction,
            soc: veh.mSoC,
            virtual_energy: veh.mVirtualEnergy,
            tc_active: veh.mTCActive != 0,
            abs_active: veh.mABSActive != 0,
            delta_best: veh.mDeltaBest,
        }
    }
}
