//! Shared-memory reader — reads LMU's built-in `LMU_Data` mapping.
//!
//! Windows-only. Non-Windows builds (development in WSL2, Linux CI) get a stub
//! that always reports "not connected", so the rest of the codebase compiles
//! without platform guards scattered through it.
//!
//! # Why there is no version block
//!
//! Every `$rFactor2SMMP_*$` buffer began with `mVersionUpdateBegin` /
//! `mVersionUpdateEnd`: the plugin bumped the first before a write and the
//! second after, so a reader could copy the buffer, compare the two, and know
//! whether a write had landed in the middle of its copy. `LMU_Data` has no such
//! pair — the game writes into it directly.
//!
//! The substitute is a **witness read**. Before copying we note two clocks that
//! the writer necessarily touches (`mCurrentET` at 5 Hz, the player's
//! `mElapsedTime` at 100 Hz) plus the two car counts; after copying we read
//! them again. If nothing moved, no write happened while we were reading and
//! the copy is coherent. If something moved, we retry.
//!
//! This is strictly weaker than a version block — a writer could in principle
//! start and finish a whole update inside our copy, leaving the witnesses back
//! where they started — but at a 10 ms write interval against a copy that takes
//! tens of microseconds, that is not a case that occurs. What it does catch is
//! the real observed failure: `tools/lmu-probe` recorded scoring and telemetry
//! disagreeing about the car count in 0.04–0.08% of samples, always while cars
//! were joining the session, and never once when the field was stable.
//!
//! # Why the copy is partial
//!
//! The mapping is 324 KB, most of it a 65 KB scoring stream we never read and
//! 104 vehicle slots of which a full grid uses a third. Copying only the
//! occupied slots keeps a frame at ~80 KB for a 34-car race, which matters
//! twice over: it is less work at 50 Hz, and a shorter copy is a smaller window
//! for a write to land in.

use crate::shared_memory::types::{rF2ScoringInfo, rF2VehicleScoring, rF2VehicleTelemetry};

/// Retries when the witnesses show a write landed inside our copy.
#[cfg(target_os = "windows")]
const MAX_READ_RETRIES: u32 = 5;

// =============================================================================
// Frame types — what the rest of the bridge consumes
// =============================================================================

/// One coherent scoring record: the session-wide info plus exactly the vehicle
/// rows the game says are occupied.
///
/// Field names match the plugin's `rF2ScoringBuffer` so the consumers did not
/// have to change when the source did. The difference that matters: `mVehicles`
/// is trimmed to the live cars, not a fixed 128-slot array with unused tail.
#[allow(non_snake_case)]
#[derive(Clone)]
pub struct ScoringFrame {
    pub mScoringInfo: rF2ScoringInfo,
    pub mVehicles: Vec<rF2VehicleScoring>,
}

/// One coherent telemetry record.
#[allow(non_snake_case)]
#[derive(Clone)]
pub struct TelemetryFrame {
    pub mVehicles: Vec<rF2VehicleTelemetry>,
    /// Index of the player's car in `mVehicles`, when the game reports one.
    ///
    /// `LMU_Data` states this outright. The plugin path had to find the
    /// player's scoring row by scanning for `mIsPlayer`, take its `mID`, and
    /// then scan the telemetry buffer for a matching ID — two searches that
    /// could disagree. [`ScoringFrame::player`] still scans, because scoring
    /// carries no equivalent index.
    pub player_idx: Option<usize>,
}

impl ScoringFrame {
    /// The player's scoring row, if the session has one.
    pub fn player(&self) -> Option<&rF2VehicleScoring> {
        self.mVehicles.iter().find(|v| v.mIsPlayer != 0)
    }
}

impl TelemetryFrame {
    /// The player's telemetry row, if the game reports a player car.
    pub fn player(&self) -> Option<&rF2VehicleTelemetry> {
        self.mVehicles.get(self.player_idx?)
    }
}

/// A scoring and telemetry pair read from the same coherent copy.
#[derive(Clone)]
pub struct SharedMemoryFrame {
    pub scoring: ScoringFrame,
    pub telemetry: TelemetryFrame,
}

// =============================================================================
// Windows implementation
// =============================================================================

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use crate::shared_memory::lmu_data::*;
    use std::ffi::CString;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Memory::{
            MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, FILE_MAP_READ,
            MEMORY_MAPPED_VIEW_ADDRESS,
        },
    };

    // -------------------------------------------------------------------------
    // MappedBuffer — one opened + memory-mapped shared-memory file
    // -------------------------------------------------------------------------

    struct MappedBuffer {
        handle: HANDLE,
        ptr: *mut core::ffi::c_void,
    }

    // Safety: the pointer stays valid for the lifetime of MappedBuffer. We only
    // ever read from it, and SharedMemoryReader is not shared across threads
    // without external synchronisation.
    unsafe impl Send for MappedBuffer {}
    unsafe impl Sync for MappedBuffer {}

    impl MappedBuffer {
        /// Open a named Windows memory-mapped file.
        ///
        /// `None` means LMU is not running, or its built-in shared memory is
        /// switched off (*Settings → Gameplay → Enable Plugins*).
        fn open(name: &str) -> Option<Self> {
            let cname = CString::new(name).ok()?;
            unsafe {
                let handle = OpenFileMappingA(FILE_MAP_READ, 0, cname.as_ptr() as *const u8);
                if handle.is_null() {
                    return None;
                }
                let mapped = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
                if mapped.Value.is_null() {
                    CloseHandle(handle);
                    return None;
                }
                Some(MappedBuffer { handle, ptr: mapped.Value })
            }
        }

        /// Copy one value out of the mapping.
        ///
        /// # Safety
        /// `offset + size_of::<T>()` must lie inside the mapping, and `T` must
        /// be plain data for which every bit pattern is valid. Both hold for
        /// the offsets in [`lmu_data`], which are derived with `offset_of!` and
        /// bounds-checked in that module's tests.
        #[inline]
        unsafe fn at<T: Copy>(&self, offset: usize) -> T {
            core::ptr::read_unaligned((self.ptr as *const u8).add(offset) as *const T)
        }

        /// Copy `n` consecutive records starting at `offset`.
        ///
        /// Copied as raw bytes in one `memcpy` rather than element by element.
        /// The vehicle arrays are `packed(4)`, so their elements are contiguous
        /// with no padding to skip, and going through `u8` sidesteps the
        /// alignment requirement `copy_nonoverlapping::<T>` would impose on a
        /// pointer into someone else's mapping. Speed is not the only reason:
        /// a shorter copy is a shorter window for the game to write into the
        /// middle of it.
        ///
        /// # Safety
        /// As [`MappedBuffer::at`], for the whole `n`-element run.
        #[inline]
        unsafe fn slice<T: Copy>(&self, offset: usize, n: usize) -> Vec<T> {
            let mut out: Vec<T> = Vec::with_capacity(n);
            core::ptr::copy_nonoverlapping(
                (self.ptr as *const u8).add(offset),
                out.as_mut_ptr() as *mut u8,
                n * std::mem::size_of::<T>(),
            );
            // Safety: the `n` elements were just initialised by the copy above,
            // and `T: Copy` means there is nothing to drop if this is a partial
            // pattern the game has not filled in — every bit pattern is valid.
            out.set_len(n);
            out
        }
    }

    impl Drop for MappedBuffer {
        fn drop(&mut self) {
            unsafe {
                UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr });
                CloseHandle(self.handle);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Witness — the stand-in for the version block LMU_Data does not have
    // -------------------------------------------------------------------------

    /// The values re-read after a copy to decide whether the copy is coherent.
    ///
    /// `mElapsedTime` is compared as raw bits rather than as a float: this is a
    /// "did these bytes change" test, not a numeric comparison, and a NaN in
    /// the mapping would make `==` answer no to itself forever.
    #[derive(PartialEq, Eq, Clone, Copy)]
    struct Witness {
        scoring_et: u64,
        player_et: u64,
        num_vehicles: i32,
        active_vehicles: u8,
        player_idx: u8,
        player_has_vehicle: u8,
    }

    impl MappedBuffer {
        unsafe fn witness(&self) -> Witness {
            let active_vehicles: u8 = self.at(OFF_ACTIVE_VEHICLES);
            let player_idx: u8 = self.at(OFF_PLAYER_IDX);
            let player_has_vehicle: u8 = self.at(OFF_PLAYER_HAS_VEHICLE);

            // Reading the player's physics clock needs a slot index, and an
            // out-of-range one would address past the array. Fall back to slot
            // 0, which always exists: the witness only has to be *a* value that
            // the writer touches, not a specific car's.
            let idx = if player_has_vehicle != 0 && (player_idx as usize) < MAX_MAPPED_VEHICLES {
                player_idx as usize
            } else {
                0
            };
            let et_off =
                OFF_TELEM_INFO + idx * std::mem::size_of::<rF2VehicleTelemetry>() + OFF_VEH_ELAPSED;

            Witness {
                scoring_et: self.at::<f64>(OFF_SCORING_ET).to_bits(),
                player_et: self.at::<f64>(et_off).to_bits(),
                num_vehicles: self.at(OFF_SCORING_NUM_VEHICLES),
                active_vehicles,
                player_idx,
                player_has_vehicle,
            }
        }
    }

    // -------------------------------------------------------------------------
    // SharedMemoryReader
    // -------------------------------------------------------------------------

    pub struct SharedMemoryReader {
        lmu: Option<MappedBuffer>,
    }

    impl SharedMemoryReader {
        pub fn new() -> Self {
            SharedMemoryReader { lmu: None }
        }

        /// Map `LMU_Data`. `true` once the game is publishing it.
        pub fn open(&mut self) -> bool {
            self.lmu = MappedBuffer::open(LMU_DATA_NAME);
            self.lmu.is_some()
        }

        /// Release the mapped view and handle.
        ///
        /// Called on drop; exposed so the main loop can close and reopen to
        /// detect LMU starting or stopping without polling process lists.
        pub fn close(&mut self) {
            self.lmu = None;
        }

        pub fn is_connected(&self) -> bool {
            self.lmu.is_some()
        }

        /// LMU's build number as a dotted version, e.g. `14000` → `"1.4.0.0"`.
        ///
        /// Replaces the plugin version string, which the bridge used to parse
        /// out of a third-party buffer whose layout it could only guess at.
        /// This one comes from the game.
        pub fn game_version(&self) -> Option<String> {
            let buf = self.lmu.as_ref()?;
            let raw: i32 = unsafe { buf.at(OFF_GAME_VERSION) };
            if raw <= 0 {
                return None;
            }
            // 14000 → 1.4.0.0: major, minor, then the build in two digits.
            let major = raw / 10000;
            let minor = (raw / 1000) % 10;
            let patch = (raw / 100) % 10;
            let build = raw % 100;
            Some(format!("{major}.{minor}.{patch}.{build}"))
        }

        /// Read one coherent scoring + telemetry frame.
        ///
        /// `None` means either LMU is not mapped, or every retry saw a write
        /// land inside the copy. Callers should keep their previous frame in
        /// that case rather than treating it as a disconnect — a torn read is a
        /// skipped update, not a lost game.
        pub fn read_frame(&self) -> Option<SharedMemoryFrame> {
            let buf = self.lmu.as_ref()?;

            for _ in 0..MAX_READ_RETRIES {
                unsafe {
                    let before = buf.witness();

                    // A car count the game has not filled in yet, or one past
                    // the end of the arrays, is not something to copy from.
                    let n_scoring = (before.num_vehicles.max(0) as usize).min(MAX_MAPPED_VEHICLES);
                    let n_telem = (before.active_vehicles as usize).min(MAX_MAPPED_VEHICLES);

                    let scoring_info: rF2ScoringInfo = buf.at(OFF_SCORING_INFO);
                    let veh_scoring: Vec<rF2VehicleScoring> = buf.slice(OFF_VEH_SCORING, n_scoring);
                    let veh_telem: Vec<rF2VehicleTelemetry> = buf.slice(OFF_TELEM_INFO, n_telem);

                    if buf.witness() != before {
                        // The game wrote while we were copying. Give it the
                        // rest of its slice rather than spinning on a writer
                        // that is still mid-update.
                        core::hint::spin_loop();
                        continue;
                    }

                    let player_idx = if before.player_has_vehicle != 0
                        && (before.player_idx as usize) < n_telem
                    {
                        Some(before.player_idx as usize)
                    } else {
                        None
                    };

                    return Some(SharedMemoryFrame {
                        scoring: ScoringFrame {
                            mScoringInfo: scoring_info,
                            mVehicles: veh_scoring,
                        },
                        telemetry: TelemetryFrame {
                            mVehicles: veh_telem,
                            player_idx,
                        },
                    });
                }
            }
            None
        }
    }
}

// =============================================================================
// Non-Windows stub (compiles in WSL2 / Linux CI)
// =============================================================================

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::*;

    pub struct SharedMemoryReader;

    impl SharedMemoryReader {
        pub fn new() -> Self {
            SharedMemoryReader
        }

        /// Always `false` — shared memory is Windows-only.
        pub fn open(&mut self) -> bool {
            false
        }

        pub fn close(&mut self) {}

        pub fn is_connected(&self) -> bool {
            false
        }

        pub fn game_version(&self) -> Option<String> {
            None
        }

        pub fn read_frame(&self) -> Option<SharedMemoryFrame> {
            None
        }
    }
}

// Re-export the platform-specific type as the single public API surface.
pub use imp::SharedMemoryReader;

#[cfg(test)]
mod tests {
    use super::*;

    fn zeroed_scoring() -> rF2VehicleScoring {
        // Safety: rF2VehicleScoring is a packed POD of integers, floats and
        // byte arrays, for which all-zero is a valid value.
        unsafe { std::mem::zeroed() }
    }

    #[test]
    fn player_row_is_found_by_the_is_player_flag() {
        let mut a = zeroed_scoring();
        a.mID = 7;
        let mut b = zeroed_scoring();
        b.mID = 9;
        b.mIsPlayer = 1;

        let frame = ScoringFrame {
            mScoringInfo: unsafe { std::mem::zeroed() },
            mVehicles: vec![a, b],
        };
        assert_eq!(frame.player().map(|v| v.mID), Some(9));
    }

    /// A spectating session has scoring rows but no player among them. Callers
    /// branch on this, so it must be None rather than a silent slot 0.
    #[test]
    fn no_player_row_yields_none() {
        let frame = ScoringFrame {
            mScoringInfo: unsafe { std::mem::zeroed() },
            mVehicles: vec![zeroed_scoring()],
        };
        assert!(frame.player().is_none());
    }

    /// `player_idx` comes straight out of shared memory, so an index past the
    /// rows we copied must not panic on lookup.
    #[test]
    fn out_of_range_player_index_is_not_a_panic() {
        let frame = TelemetryFrame {
            mVehicles: Vec::new(),
            player_idx: Some(3),
        };
        assert!(frame.player().is_none());
    }
}
