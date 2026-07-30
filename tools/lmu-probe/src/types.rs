//! What the probe needs on top of the bridge's own definitions.
//!
//! The `LMU_Data` layout and the rF2 records it embeds both live in the
//! product now — `bridge/src/shared_memory/lmu_data.rs` and `types.rs`, both
//! included verbatim by `main.rs`. This probe exists to prove that the *bridge*
//! can read `LMU_Data`, so it must decode the mapping with the bridge's
//! definitions; a private copy could drift from them, and then a clean report
//! would mean nothing.
//!
//! What remains here is the one thing the bridge no longer knows about: the
//! plugin. Its buffer names are needed to prove it is absent, and a few offsets
//! into its buffers are needed for the optional side-by-side comparison. The
//! bridge dropped those definitions when it dropped the plugin.

#![allow(non_snake_case)]
// On non-Windows hosts the whole reader is cfg'd out, so every definition here
// looks unused. The struct sizes are still asserted at compile time, which is
// the main reason to build this on Linux at all.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

pub use crate::bridge_shm::lmu_data::{
    LmuObjectOut, LmuScoringData, LmuTelemetryData, MAX_MAPPED_VEHICLES,
};
pub use crate::rf2::{
    bytes_to_str, rF2ScoringInfo, rF2VehicleScoring, rF2VehicleTelemetry, rF2Wheel,
};

// ---------------------------------------------------------------------------
// Offsets into the rF2SharedMemoryMapPlugin buffers
//
// The probe reads only a few scalars from the SMMP side, so rather than
// duplicating those big structs it addresses them by offset. Values computed
// with `offset_of!` against the bridge's own definitions.
// ---------------------------------------------------------------------------

/// `rF2TelemetryBuffer::mVehicles` — after begin/end/hint/mNumVehicles.
pub const SMMP_TELEM_VEHICLES_OFFSET: usize = 16;
/// `rF2TelemetryBuffer::mNumVehicles`.
pub const SMMP_TELEM_NUM_VEHICLES_OFFSET: usize = 12;
/// `rF2RulesBuffer` → `mRules.mSafetyCarExists`.
pub const SMMP_SAFETY_CAR_EXISTS_OFFSET: usize = 246;
/// `rF2RulesBuffer` → `mRules.mSafetyCarActive`.
pub const SMMP_SAFETY_CAR_ACTIVE_OFFSET: usize = 247;

/// Every mapping the plugin creates — not just the five `reader.rs` opens.
///
/// The absence check has to cover all of them: the plugin publishes the whole
/// set, so any one of these names resolving means the DLL is loaded, and a
/// proof that only looked at the buffers we happen to read could be satisfied
/// by a plugin that is very much still running.
pub const SMMP_BUFFERS: [&str; 9] = [
    // read by bridge/src/shared_memory/reader.rs
    "$rFactor2SMMP_Telemetry$",
    "$rFactor2SMMP_Scoring$",
    "$rFactor2SMMP_Rules$",
    "$rFactor2SMMP_Weather$",
    "$rFactor2SMMP_Extended$",
    // published by the plugin, unused by the bridge
    "$rFactor2SMMP_MultiRules$",
    "$rFactor2SMMP_ForceFeedback$",
    "$rFactor2SMMP_Graphics$",
    "$rFactor2SMMP_PitInfo$",
];
