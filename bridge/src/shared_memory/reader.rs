//! Shared Memory Reader — opens and reads LMU/rF2 Named Memory-Mapped Files.
//!
//! Windows-only implementation. Non-Windows builds (e.g. during development in
//! WSL2) get a stub that always reports "not connected" so the rest of the
//! codebase compiles without platform-specific guards everywhere.
//!
//! # Version-tracking / torn-read protection
//!
//! Every rF2 mapped buffer starts with two `u32` fields:
//!   `mVersionUpdateBegin` — incremented *before* a write
//!   `mVersionUpdateEnd`   — incremented *after*  a write
//!
//! When they are equal the buffer is consistent. If they differ a write was in
//! progress; we spin briefly and retry up to `MAX_READ_RETRIES` times.

use crate::shared_memory::types::{
    rF2ExtendedBuffer, rF2RulesBuffer, rF2ScoringBuffer, rF2TelemetryBuffer, rF2WeatherBuffer,
    LmuExtendedBuffer,
    EXTENDED_BUFFER_NAME, RULES_BUFFER_NAME, SCORING_BUFFER_NAME, TELEMETRY_BUFFER_NAME,
    WEATHER_BUFFER_NAME,
};

/// Maximum number of retry attempts when a torn read is detected.
const MAX_READ_RETRIES: u32 = 5;

// =============================================================================
// Windows implementation
// =============================================================================

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::ffi::CString;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Memory::{
            MapViewOfFile, MEMORY_MAPPED_VIEW_ADDRESS, OpenFileMappingA, UnmapViewOfFile,
            FILE_MAP_READ,
        },
    };

    // -------------------------------------------------------------------------
    // MappedBuffer — one opened + memory-mapped shared-memory file
    // -------------------------------------------------------------------------

    pub(super) struct MappedBuffer {
        handle: HANDLE,
        ptr: *mut core::ffi::c_void,
    }

    // Safety: The pointer is valid for the lifetime of MappedBuffer.
    // We only read from it (never write), and access is serialised by the
    // caller (SharedMemoryReader is not shared across threads without
    // external synchronisation).
    unsafe impl Send for MappedBuffer {}
    unsafe impl Sync for MappedBuffer {}

    impl MappedBuffer {
        /// Try to open a named Windows Memory-Mapped File.
        ///
        /// Returns `None` when LMU is not running (the file does not exist).
        pub(super) fn open(name: &str) -> Option<Self> {
            let cname = CString::new(name).ok()?;
            unsafe {
                // FILE_MAP_READ = 4; bInheritHandle = 0 (FALSE)
                let handle =
                    OpenFileMappingA(FILE_MAP_READ, 0, cname.as_ptr() as *const u8);
                if handle.is_null() {
                    return None;
                }
                // Map the entire file (dwNumberOfBytesToMap = 0)
                // windows-sys 0.59: MapViewOfFile returns MEMORY_MAPPED_VIEW_ADDRESS
                let mapped = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
                if mapped.Value.is_null() {
                    CloseHandle(handle);
                    return None;
                }
                Some(MappedBuffer { handle, ptr: mapped.Value })
            }
        }

        /// Return a typed const pointer into the mapped view.
        #[inline]
        pub(super) fn as_ptr<T>(&self) -> *const T {
            self.ptr as *const T
        }
    }

    impl Drop for MappedBuffer {
        fn drop(&mut self) {
            unsafe {
                // windows-sys 0.59: UnmapViewOfFile takes MEMORY_MAPPED_VIEW_ADDRESS
                UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr });
                CloseHandle(self.handle);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Version-checked read helper
    // -------------------------------------------------------------------------

    /// Copy a version-stamped rF2 buffer, retrying when a torn write is detected.
    ///
    /// The layout assumption: the first two `u32` words of `*ptr` are
    /// `mVersionUpdateBegin` (offset 0) and `mVersionUpdateEnd` (offset 4).
    /// All top-level rF2 buffer types satisfy this contract.
    pub(super) unsafe fn read_versioned<T: Copy>(ptr: *const T) -> Option<T> {
        for _ in 0..MAX_READ_RETRIES {
            // Volatile reads prevent the compiler from hoisting these out of
            // the loop or merging them with the struct copy below.
            let begin = core::ptr::read_volatile(ptr as *const u32);

            // Full struct copy from shared memory (handles unaligned access).
            let data = core::ptr::read_unaligned(ptr);

            let end = core::ptr::read_volatile((ptr as *const u32).add(1));

            if begin == end {
                return Some(data);
            }
            // Writer is active — pause briefly and retry.
            core::hint::spin_loop();
        }
        // Still torn after all retries; caller should skip this frame.
        None
    }

    // -------------------------------------------------------------------------
    // SharedMemoryReader — Windows concrete implementation
    // -------------------------------------------------------------------------

    pub struct SharedMemoryReader {
        telemetry: Option<MappedBuffer>,
        scoring: Option<MappedBuffer>,
        extended: Option<MappedBuffer>,
        weather: Option<MappedBuffer>,
        rules: Option<MappedBuffer>,
    }

    impl SharedMemoryReader {
        pub fn new() -> Self {
            SharedMemoryReader {
                telemetry: None,
                scoring: None,
                extended: None,
                weather: None,
                rules: None,
            }
        }

        /// Attempt to open all LMU shared-memory buffers.
        ///
        /// It is not an error if only some buffers are available — LMU may not
        /// have started the plugin yet. Returns `true` if at least the
        /// telemetry buffer was opened successfully.
        pub fn open(&mut self) -> bool {
            self.telemetry = MappedBuffer::open(TELEMETRY_BUFFER_NAME);
            self.scoring = MappedBuffer::open(SCORING_BUFFER_NAME);
            self.extended = MappedBuffer::open(EXTENDED_BUFFER_NAME);
            self.weather = MappedBuffer::open(WEATHER_BUFFER_NAME);
            self.rules = MappedBuffer::open(RULES_BUFFER_NAME);
            self.telemetry.is_some()
        }

        /// Release all mapped views and handles.
        ///
        /// Called automatically on drop; exposed explicitly so the main loop
        /// can close and reopen buffers when LMU restarts.
        pub fn close(&mut self) {
            self.telemetry = None;
            self.scoring = None;
            self.extended = None;
            self.weather = None;
            self.rules = None;
        }

        /// Returns `true` if the telemetry buffer is currently mapped (LMU
        /// is running and the shared-memory plugin is active).
        pub fn is_connected(&self) -> bool {
            self.telemetry.is_some()
        }

        /// Read the telemetry buffer (50 Hz).
        ///
        /// Returns `None` if LMU is not running or if all retries were
        /// exhausted due to a persistent torn write.
        pub fn read_telemetry(&self) -> Option<rF2TelemetryBuffer> {
            let buf = self.telemetry.as_ref()?;
            unsafe { read_versioned(buf.as_ptr::<rF2TelemetryBuffer>()) }
        }

        /// Read the scoring buffer (5 Hz).
        pub fn read_scoring(&self) -> Option<rF2ScoringBuffer> {
            let buf = self.scoring.as_ref()?;
            unsafe { read_versioned(buf.as_ptr::<rF2ScoringBuffer>()) }
        }

        /// Read the extended buffer (5 Hz).
        pub fn read_extended(&self) -> Option<rF2ExtendedBuffer> {
            let buf = self.extended.as_ref()?;
            unsafe { read_versioned(buf.as_ptr::<rF2ExtendedBuffer>()) }
        }

        /// Read the weather buffer (1 Hz).
        pub fn read_weather(&self) -> Option<rF2WeatherBuffer> {
            let buf = self.weather.as_ref()?;
            unsafe { read_versioned(buf.as_ptr::<rF2WeatherBuffer>()) }
        }

        /// Read the LMU Extended buffer (tembob64 plugin, ~5 Hz).
        ///
        /// Uses the same MMF name as the standard Extended buffer.
        /// Returns `None` if the buffer is not mapped or a torn read occurred.
        pub fn read_lmu_extended(&self) -> Option<LmuExtendedBuffer> {
            let buf = self.extended.as_ref()?;
            unsafe { read_versioned(buf.as_ptr::<LmuExtendedBuffer>()) }
        }

        /// Read the rules buffer (~5 Hz) — contains safety car and flag rule state.
        pub fn read_rules(&self) -> Option<rF2RulesBuffer> {
            let buf = self.rules.as_ref()?;
            unsafe { read_versioned(buf.as_ptr::<rF2RulesBuffer>()) }
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

        /// Always returns `false` — shared memory is Windows-only.
        pub fn open(&mut self) -> bool {
            false
        }

        pub fn close(&mut self) {}

        pub fn is_connected(&self) -> bool {
            false
        }

        pub fn read_telemetry(&self) -> Option<rF2TelemetryBuffer> {
            None
        }

        pub fn read_scoring(&self) -> Option<rF2ScoringBuffer> {
            None
        }

        pub fn read_extended(&self) -> Option<rF2ExtendedBuffer> {
            None
        }

        pub fn read_weather(&self) -> Option<rF2WeatherBuffer> {
            None
        }

        pub fn read_lmu_extended(&self) -> Option<LmuExtendedBuffer> {
            None
        }

        pub fn read_rules(&self) -> Option<rF2RulesBuffer> {
            None
        }
    }
}

// Re-export the platform-specific type as the single public API surface.
pub use imp::SharedMemoryReader;
