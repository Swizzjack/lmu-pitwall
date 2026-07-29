//! lmu-probe — does LMU Pitwall still need the rFactor2SharedMemoryMapPlugin?
//!
//! The tool answers exactly one question and tries hard not to answer it too
//! generously:
//!
//!   **Can the bridge read everything it needs from LMU's built-in `LMU_Data`
//!   mapping, with the plugin DLL not installed at all?**
//!
//! Three things have to hold at once for that to be true, and the report is
//! organised around them:
//!
//!   1. *The plugin really is gone.* A Windows named mapping outlives its
//!      creator as long as any process holds a handle, so "the buffer opens" is
//!      no evidence the plugin is running — and a bridge left open keeps the
//!      dead buffers in the namespace. The run is only a valid proof when no
//!      `$rFactor2SMMP_*$` name resolves at all.
//!   2. *`LMU_Data` is being written, fast enough.* Scoring and telemetry are
//!      timed separately: the dashboard's tire and pedal widgets need the
//!      telemetry block to tick at physics rate, not at the 5 Hz scoring rate.
//!   3. *Every field the bridge consumes arrives intact.* That is the coverage
//!      table in `checks.rs` — each field the bridge reads today, checked for
//!      presence, plausibility and liveness. Plausibility windows are what turn
//!      this into a layout check as well: a struct that shifted by a few bytes
//!      still decodes as a valid `f64`, just not as a believable one.
//!
//! Anything that cannot be proven is reported as unproven rather than quietly
//! counted as a pass. The safety car is the known gap: it lives in the plugin's
//! Rules buffer and has no `LMU_Data` equivalent.
//!
//! This is a diagnostic, not product code: it prints, writes a report file, and
//! exits.

/// The bridge's own shared-memory definitions, included verbatim rather than
/// copied. Both the rF2 records *and* the `LMU_Data` containers now live in the
/// product, so a second copy here could drift from what the bridge actually
/// reads — and then this tool would prove something about itself.
#[path = "../../../bridge/src/shared_memory/"]
#[allow(dead_code, non_snake_case, non_camel_case_types, clippy::all)]
mod bridge_shm {
    pub mod lmu_data;
    pub mod types;
}

use bridge_shm::types as rf2;

mod checks;
mod types;

use std::fmt::Write as _;

/// Long enough for three flying laps plus an out lap on a big circuit, because
/// the fields that decide the port — `mLastLapTime`, `mLastSector1/2`,
/// `mBestLapTime`, `mDeltaBest`, per-lap fuel — stay at their "never happened"
/// sentinels until the car first crosses the line. A run that ends before that
/// proves the layout and nothing about lap timing.
const DEFAULT_SECONDS: u64 = 900;
/// Completed laps that end the run early. The clock is the cap, this is the
/// goal: drive the laps and the probe stops on its own.
const DEFAULT_LAPS: u32 = 3;
const DEFAULT_REPORT: &str = "lmu-probe-report.txt";

/// Full-snapshot rate for the coverage checks.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const SNAPSHOT_HZ: u64 = 10;
/// Scalar-read rate for the update-frequency measurement. Must be comfortably
/// above the ~50 Hz the telemetry block is expected to run at, or we would
/// measure our own sampling rate instead of the game's.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const RATE_SAMPLE_HZ: u64 = 200;

/// Collects the report so it can be printed *and* written to a file — the probe
/// runs on the sim machine, where scrolling a console back is the worst possible
/// way to get the results off it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct Report {
    text: String,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]

impl Report {
    fn new() -> Self {
        Report { text: String::new() }
    }

    fn line(&mut self, s: String) {
        println!("{s}");
        let _ = writeln!(self.text, "{s}");
    }

    fn save(&self, path: &str) {
        match std::fs::write(path, &self.text) {
            Ok(()) => println!("\nReport written to {path}"),
            Err(e) => eprintln!("\nCould not write {path}: {e}"),
        }
    }
}

/// `say!(rep)` for a blank line, `say!(rep, "fmt", ..)` for content.
#[macro_export]
macro_rules! say {
    ($r:expr) => { $r.line(String::new()) };
    ($r:expr, $($arg:tt)*) => { $r.line(format!($($arg)*)) };
}

fn main() {
    let mut seconds = DEFAULT_SECONDS;
    let mut laps = DEFAULT_LAPS;
    let mut out = DEFAULT_REPORT.to_string();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--seconds" | "-s" => {
                seconds = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_SECONDS);
            }
            "--laps" | "-l" => {
                laps = args.next().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_LAPS);
            }
            "--out" | "-o" => {
                if let Some(v) = args.next() {
                    out = v;
                }
            }
            "--help" | "-h" => {
                println!("lmu-probe [--seconds N] [--laps N] [--out FILE]");
                println!();
                println!("  --seconds N   sampling cap in seconds (default {DEFAULT_SECONDS})");
                println!("  --laps N      stop once N laps are completed (default {DEFAULT_LAPS}, 0 = run the clock out)");
                println!("  --out FILE    where to write the report (default {DEFAULT_REPORT})");
                println!();
                println!("Whichever comes first ends the run. Lap timing, sector and per-lap");
                println!("fuel fields stay at their sentinels until the car crosses the line,");
                println!("so a run with zero completed laps cannot prove them.");
                println!();
                println!("Run with Le Mans Ultimate open and the car ON TRACK.");
                println!("For the plugin-free proof, rename");
                println!("  Le Mans Ultimate\\Plugins\\rFactor2SharedMemoryMapPlugin64.dll");
                println!("to something not ending in .dll, close LMU Pitwall and every other");
                println!("telemetry tool, then restart the game.");
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    imp::run(seconds, laps, &out);
}

// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn run(_seconds: u64, _laps: u32, _out: &str) {
        eprintln!("lmu-probe reads Windows named shared memory — build and run it on the");
        eprintln!("machine running Le Mans Ultimate.");
        std::process::exit(1);
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::checks::*;
    use super::types::*;
    use super::{Report, RATE_SAMPLE_HZ, SNAPSHOT_HZ};
    use std::ffi::CString;
    use std::mem::{offset_of, size_of};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Memory::{
            MapViewOfFile, OpenFileMappingA, UnmapViewOfFile, FILE_MAP_READ,
            MEMORY_MAPPED_VIEW_ADDRESS,
        },
    };

    // --- offsets into LMU_Data, for the cheap high-rate scalar reads ---------

    const OFF_SCORING_INFO: usize =
        offset_of!(LmuObjectOut, scoring) + offset_of!(LmuScoringData, scoringInfo);
    const OFF_SCORING_ET: usize = OFF_SCORING_INFO + offset_of!(rF2ScoringInfo, mCurrentET);
    const OFF_TELEM: usize = offset_of!(LmuObjectOut, telemetry);
    const OFF_TELEM_INFO: usize = OFF_TELEM + offset_of!(LmuTelemetryData, telemInfo);
    const OFF_PLAYER_IDX: usize = OFF_TELEM + offset_of!(LmuTelemetryData, playerVehicleIdx);
    const OFF_PLAYER_HAS: usize = OFF_TELEM + offset_of!(LmuTelemetryData, playerHasVehicle);
    const OFF_VEH_ELAPSED: usize = offset_of!(rF2VehicleTelemetry, mElapsedTime);

    /// A read-only view of one named mapping.
    struct Mapped {
        handle: HANDLE,
        ptr: *mut core::ffi::c_void,
    }

    impl Mapped {
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
                Some(Mapped { handle, ptr: mapped.Value })
            }
        }

        fn ptr(&self) -> *const u8 {
            self.ptr as *const u8
        }

        /// Read a scalar at a byte offset. Unaligned-safe.
        unsafe fn at<T: Copy>(&self, offset: usize) -> T {
            std::ptr::read_unaligned(self.ptr().add(offset) as *const T)
        }
    }

    impl Drop for Mapped {
        fn drop(&mut self) {
            unsafe {
                UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: self.ptr });
                CloseHandle(self.handle);
            }
        }
    }

    /// Reads one element out of an array field of a packed snapshot without ever
    /// forming a reference to it (which `#[repr(packed)]` forbids).
    unsafe fn elem<T: Copy>(base: *const T, i: usize) -> T {
        std::ptr::read_unaligned(base.add(i))
    }

    // --- update-rate measurement --------------------------------------------

    /// Counts value changes of one field to derive its write frequency.
    ///
    /// `LMU_Data` has no version counter, so there is nothing to count directly;
    /// a monotonic clock inside the block is the next best thing. Sampling above
    /// Nyquist for the expected rate is the caller's job.
    #[derive(Default)]
    struct Rate {
        last: Option<u64>,
        changes: u64,
        samples: u64,
        max_stall: Duration,
        last_change: Option<Instant>,
    }

    impl Rate {
        fn record(&mut self, bits: u64, now: Instant) {
            self.samples += 1;
            match self.last {
                Some(prev) if prev == bits => {
                    if let Some(t) = self.last_change {
                        self.max_stall = self.max_stall.max(now - t);
                    }
                }
                Some(_) => {
                    self.changes += 1;
                    self.last_change = Some(now);
                }
                None => self.last_change = Some(now),
            }
            self.last = Some(bits);
        }

        fn hz(&self, elapsed: Duration) -> f64 {
            let s = elapsed.as_secs_f64();
            if s <= 0.0 {
                0.0
            } else {
                self.changes as f64 / s
            }
        }

        fn is_live(&self) -> bool {
            self.changes > 0
        }
    }

    /// The SMMP write stamp: `mVersionUpdateEnd` at offset 4 of every buffer.
    fn smmp_stamp(m: &Mapped) -> u64 {
        unsafe { m.at::<u32>(4) as u64 }
    }

    /// One mapped SMMP buffer, with the liveness we measured for it.
    struct SmmpBuffer {
        name: &'static str,
        map: Mapped,
        rate: Rate,
    }

    pub fn run(seconds: u64, target_laps: u32, out: &str) {
        let mut rep = Report::new();

        say!(rep, "=== lmu-probe — is the rF2 shared-memory plugin still needed? ===");
        say!(rep);

        let Some(lmu) = Mapped::open("LMU_Data") else {
            say!(rep, "LMU_Data is not mapped. Either the game is not running, or its");
            say!(rep, "built-in shared memory is off: Settings -> Gameplay -> Enable");
            say!(rep, "Plugins = ON, then restart the game.");
            rep.save(out);
            std::process::exit(1);
        };

        // --- 1. Is the plugin present? --------------------------------------
        let mut smmp: Vec<SmmpBuffer> = SMMP_BUFFERS
            .iter()
            .filter_map(|name| {
                Mapped::open(name).map(|map| SmmpBuffer { name, map, rate: Rate::default() })
            })
            .collect();

        say!(rep, "--- 1. Is the plugin out of the picture? ---");
        say!(rep);
        say!(rep, "  {:<28} {}", "LMU_Data (built-in)", "mapped");
        for name in SMMP_BUFFERS.iter() {
            let state = if smmp.iter().any(|b| b.name == *name) {
                "MAPPED  <- must be absent for the proof"
            } else {
                "not mapped"
            };
            say!(rep, "  {name:<28} {state}");
        }
        say!(rep);

        let plugin_absent = smmp.is_empty();
        if plugin_absent {
            say!(rep, "  No $rFactor2SMMP_*$ name resolves — the plugin is not loaded and no");
            say!(rep, "  leftover reader is holding its buffers open. This run can serve as");
            say!(rep, "  a plugin-free proof.");
        } else {
            say!(rep, "  Some plugin buffers are mapped, so this run measures the plugin-free");
            say!(rep, "  case only partially. Note that `mapped` does not mean `written`: a");
            say!(rep, "  named mapping survives as long as ANY process holds a handle, so");
            say!(rep, "  these may be leftovers kept alive by LMU Pitwall's own bridge or");
            say!(rep, "  another telemetry tool. The writer column below tells them apart.");
            say!(rep, "  For a clean proof: close the bridge and every other telemetry tool,");
            say!(rep, "  rename the DLL, exit the game, restart it, run this again.");
        }
        say!(rep);

        // --- 2. Sampling -----------------------------------------------------
        if target_laps > 0 {
            say!(rep, "--- 2. Sampling: {target_laps} completed laps, or {seconds}s, whichever comes first ---");
        } else {
            say!(rep, "--- 2. Sampling {seconds}s — drive a lap ---");
        }
        say!(rep);

        let mut stats: Vec<Stat> = (0..CHECKS.len()).map(|_| Stat::default()).collect();
        let mut string_stats: Vec<StringStat> =
            (0..STRING_CHECKS.len()).map(|_| StringStat::default()).collect();

        let mut scoring_rate = Rate::default();
        let mut telem_rate = Rate::default();

        let mut snapshots: u64 = 0;
        let mut car_count_mismatch: u64 = 0;
        let mut id_mismatch: u64 = 0;
        let mut no_player: u64 = 0;
        let mut no_player_row: u64 = 0;

        // Safety car: what LMU_Data offers (phase/yellow), against SMMP truth if
        // the Rules buffer happens to be there.
        let mut sc_rows: Vec<(u8, u8, u8, i8, u64)> = Vec::new();

        // Cross-check against the plugin, when it is installed: (samples, max |delta|).
        let mut xstats: Vec<(u64, f64)> = vec![(0, 0.0); XFIELDS.len()];

        let mut game_version = 0i32;
        let mut track = String::new();
        let mut session_type = -1i32;

        // Laps the player completes *during this run*. Counted as a delta from
        // the first reading rather than from zero, so joining a session that is
        // already 20 laps old still stops after the requested laps.
        let mut laps_at_start: Option<i32> = None;
        let mut laps_now: i32 = 0;

        let started = Instant::now();
        let deadline = started + Duration::from_secs(seconds);
        let rate_interval = Duration::from_micros(1_000_000 / RATE_SAMPLE_HZ);
        let snapshot_interval = Duration::from_micros(1_000_000 / SNAPSHOT_HZ);
        let mut next_snapshot = Instant::now();
        let mut next_print = Instant::now();

        let laps_done = |at_start: Option<i32>, now: i32| -> u32 {
            match at_start {
                Some(start) => (now - start).max(0) as u32,
                None => 0,
            }
        };

        while Instant::now() < deadline {
            if target_laps > 0 && laps_done(laps_at_start, laps_now) >= target_laps {
                break;
            }
            let now = Instant::now();

            // -- cheap scalar reads, for the update-rate question --
            let et: f64 = unsafe { lmu.at(OFF_SCORING_ET) };
            scoring_rate.record(et.to_bits(), now);

            let has_player: u8 = unsafe { lmu.at(OFF_PLAYER_HAS) };
            let idx = unsafe { lmu.at::<u8>(OFF_PLAYER_IDX) } as usize;
            if has_player != 0 && idx < MAX_MAPPED_VEHICLES {
                let off = OFF_TELEM_INFO + idx * size_of::<rF2VehicleTelemetry>() + OFF_VEH_ELAPSED;
                let vet: f64 = unsafe { lmu.at(off) };
                telem_rate.record(vet.to_bits(), now);
            }
            for b in smmp.iter_mut() {
                let stamp = smmp_stamp(&b.map);
                b.rate.record(stamp, now);
            }

            // -- full snapshot, for the coverage table --
            if now >= next_snapshot {
                next_snapshot += snapshot_interval;
                snapshots += 1;

                // One copy of the whole map, the same "copy access" strategy
                // pyLMUSharedMemory uses — there is no version block to bracket
                // a partial read with.
                let snap: LmuObjectOut = unsafe { lmu.at(0) };
                let si = snap.scoring.scoringInfo;
                game_version = snap.generic.gameVersion;
                session_type = si.mSession;
                let tn = si.mTrackName;
                track = bytes_to_str(&tn).to_string();

                let num_scoring = si.mNumVehicles;
                let num_telem = snap.telemetry.activeVehicles as i32;
                if num_scoring != num_telem {
                    car_count_mismatch += 1;
                }

                // Player's scoring row: scan for mIsPlayer, exactly as the
                // bridge does today.
                let n = num_scoring.clamp(0, MAX_MAPPED_VEHICLES as i32) as usize;
                let vs_base = std::ptr::addr_of!(snap.scoring.vehScoringInfo) as *const rF2VehicleScoring;
                let vs = (0..n)
                    .map(|i| unsafe { elem(vs_base, i) })
                    .find(|v| v.mIsPlayer != 0);
                if vs.is_none() {
                    no_player_row += 1;
                }

                if let Some(v) = vs {
                    laps_now = v.mTotalLaps as i32;
                    laps_at_start.get_or_insert(laps_now);
                }

                // Player's telemetry row: LMU_Data hands us the index directly.
                let vt = if snap.telemetry.playerHasVehicle != 0 {
                    let i = snap.telemetry.playerVehicleIdx as usize;
                    if i < MAX_MAPPED_VEHICLES {
                        let vt_base =
                            std::ptr::addr_of!(snap.telemetry.telemInfo) as *const rF2VehicleTelemetry;
                        Some(unsafe { elem(vt_base, i) })
                    } else {
                        None
                    }
                } else {
                    no_player += 1;
                    None
                };

                // Both sources must agree on who the player is, or one of the
                // two lookups is decoding the wrong slot.
                if let (Some(a), Some(b)) = (vs, vt) {
                    if a.mID != b.mID {
                        id_mismatch += 1;
                    }
                }

                let sample = Sample { si, vs, vt };
                for (i, c) in CHECKS.iter().enumerate() {
                    if let Some(v) = (c.get)(&sample) {
                        stats[i].record(v, c.lo, c.hi);
                    }
                }
                for (i, c) in STRING_CHECKS.iter().enumerate() {
                    if let Some(v) = (c.get)(&sample) {
                        string_stats[i].record(&v);
                    }
                }

                // Same car, same instant, both maps — only while the plugin is
                // installed. Deltas here are what the dashboard would gain or
                // lose by switching source.
                if let (Some(player), Some(b)) =
                    (vt, smmp.iter().find(|b| b.name.contains("Telemetry")))
                {
                    if let Some(other) = find_smmp_vehicle(&b.map, player.mID) {
                        for (i, f) in XFIELDS.iter().enumerate() {
                            let d = ((f.get)(&player) - (f.get)(&other)).abs();
                            xstats[i].0 += 1;
                            xstats[i].1 = xstats[i].1.max(d);
                        }
                    }
                }

                // Safety car correlation, when the Rules buffer is present.
                let (sc_exists, sc_active) = match smmp.iter().find(|b| b.name.contains("Rules")) {
                    Some(r) => unsafe {
                        (
                            r.map.at::<u8>(SMMP_SAFETY_CAR_EXISTS_OFFSET),
                            r.map.at::<u8>(SMMP_SAFETY_CAR_ACTIVE_OFFSET),
                        )
                    },
                    None => (255, 255),
                };
                let key = (sc_exists, sc_active, si.mGamePhase, si.mYellowFlagState);
                match sc_rows.iter_mut().find(|r| (r.0, r.1, r.2, r.3) == key) {
                    Some(row) => row.4 += 1,
                    None => sc_rows.push((key.0, key.1, key.2, key.3, 1)),
                }

                if now >= next_print {
                    next_print += Duration::from_secs(1);
                    let elapsed = now - started;
                    let speed = vt
                        .map(|v| {
                            let lv = v.mLocalVel;
                            (-lv.z) * 3.6
                        })
                        .unwrap_or(0.0);
                    let tire = vt
                        .map(|v| {
                            let w = v.mWheels;
                            let t = w[0].mTemperature;
                            t[1] - 273.15
                        })
                        .unwrap_or(0.0);
                    let done = laps_done(laps_at_start, laps_now);
                    let lap_col = if target_laps > 0 {
                        format!("laps={done}/{target_laps}")
                    } else {
                        format!("laps={done}")
                    };
                    say!(
                        rep,
                        "  t={:>3.0}s  cars={num_scoring}/{num_telem}  {lap_col:<10} phase={} yellow={}  \
                         speed={speed:>5.1} km/h  FL={tire:>5.1}C  scoring={:>4.1}Hz  telem={:>5.1}Hz",
                        elapsed.as_secs_f64(),
                        si.mGamePhase,
                        si.mYellowFlagState,
                        scoring_rate.hz(elapsed),
                        telem_rate.hz(elapsed)
                    );
                }
            }

            std::thread::sleep(rate_interval);
        }

        let elapsed = started.elapsed();
        let completed_laps = laps_done(laps_at_start, laps_now);

        // --- 3. Report --------------------------------------------------------
        say!(rep);
        say!(rep, "=== Results ===");
        say!(rep);
        say!(rep, "  Game version (generic.gameVersion): {game_version}");
        say!(rep, "  Track:                              {track}");
        say!(rep, "  Snapshots:                          {snapshots}");
        say!(rep, "  Scalar samples:                     {}", scoring_rate.samples);
        say!(rep, "  Laps completed during the run:      {completed_laps}");
        say!(rep, "  Run length:                         {:.0}s", elapsed.as_secs_f64());
        if completed_laps == 0 {
            say!(rep);
            say!(rep, "  No lap was completed. Everything downstream of crossing the line is");
            say!(rep, "  therefore untested, not proven: mLastLapTime, mLastSector1/2,");
            say!(rep, "  mBestLapTime/mBestSector, mDeltaBest, mTotalLaps and per-lap fuel all");
            say!(rep, "  sit at their sentinels (0 or -1) in every sample below.");
        }
        say!(rep);

        // -- writers and rates --
        say!(rep, "--- 3. Who was writing, and how fast? ---");
        say!(rep);
        say!(rep, "  {:<34} {:>9}  {}", "source", "rate", "verdict");
        say!(
            rep,
            "  {:<34} {:>8.1}Hz  {}",
            "LMU_Data scoring (mCurrentET)",
            scoring_rate.hz(elapsed),
            if scoring_rate.is_live() { "LIVE" } else { "DEAD" }
        );
        say!(
            rep,
            "  {:<34} {:>8.1}Hz  {}",
            "LMU_Data telemetry (mElapsedTime)",
            telem_rate.hz(elapsed),
            if telem_rate.is_live() { "LIVE" } else { "DEAD" }
        );
        for b in smmp.iter() {
            say!(
                rep,
                "  {:<34} {:>8.1}Hz  {}",
                b.name,
                b.rate.hz(elapsed),
                if b.rate.is_live() { "LIVE (plugin is running)" } else { "DEAD (leftover mapping)" }
            );
        }
        say!(rep);
        say!(
            rep,
            "  Longest stall: scoring {:.2}s, telemetry {:.2}s",
            scoring_rate.max_stall.as_secs_f64(),
            telem_rate.max_stall.as_secs_f64()
        );
        say!(rep, "  (Sampled at {RATE_SAMPLE_HZ} Hz. Rates near that ceiling are a measuring");
        say!(rep, "   limit, not the game's true rate. Time spent in menus or paused counts");
        say!(rep, "   into the average and drags it down.)");
        say!(rep);

        // -- coverage table --
        say!(rep, "--- 4. Every field the bridge reads, from LMU_Data alone ---");
        say!(rep);
        say!(
            rep,
            "  {:<30} {:<30} {:<12} {}",
            "field",
            "used by",
            "verdict",
            "observed range"
        );

        let mut group = "";
        let mut gaps: Vec<(&str, Verdict)> = Vec::new();
        let mut ok_count = 0usize;
        let mut zero_ok_count = 0usize;
        for (i, c) in CHECKS.iter().enumerate() {
            if c.group != group {
                group = c.group;
                say!(rep, "  [{group}]");
            }
            let v = stats[i].verdict(c.need);
            match v {
                Verdict::Ok => ok_count += 1,
                Verdict::ZeroOk => zero_ok_count += 1,
                _ => gaps.push((c.name, v)),
            }
            say!(
                rep,
                "  {:<30} {:<30} {:<12} {:.3} … {:.3}",
                c.name,
                c.consumer,
                v.label(),
                stats[i].min,
                stats[i].max
            );
        }
        say!(rep);
        say!(rep, "  [strings]");
        for (i, c) in STRING_CHECKS.iter().enumerate() {
            let v = string_stats[i].verdict();
            match v {
                Verdict::Ok => ok_count += 1,
                _ => gaps.push((c.name, v)),
            }
            say!(
                rep,
                "  {:<30} {:<30} {:<12} {:?}",
                c.name,
                c.consumer,
                v.label(),
                string_stats[i].example
            );
        }
        say!(rep);
        say!(rep, "  OK          = written, plausible, and changing where it should");
        say!(rep, "  zero (ok)   = always zero, but zero is a legal value here (no penalty,");
        say!(rep, "                no impact, leading the race). The offset decodes; whether");
        say!(rep, "                the game writes it cannot be shown in a clean session.");
        say!(rep, "  STATIC      = plausible but never changed, where change was expected");
        say!(rep, "  SUSPECT     = always zero where a car on track must produce a value");
        say!(rep, "  IMPLAUSIBLE = outside a believable range — the layout has most likely");
        say!(rep, "                shifted, which is the failure a null check never catches");
        say!(rep, "  NO DATA     = never extractable (no player car / no scoring row)");

        // rF2 session codes: 0 test day, 1-4 practice, 5-8 qualifying,
        // 9 warmup, 10-13 race.
        if session_type >= 0 && session_type < 10 {
            say!(rep);
            say!(rep, "  This was session type {session_type} — not a race. The running-order fields");
            say!(rep, "  (mTimeBehindLeader, mLapsBehindLeader, mPlace, mFlag) are written by");
            say!(rep, "  LMU here too, but they do not carry their race meaning: there is no");
            say!(rep, "  order to be behind, and the leader gap swings either way. They prove");
            say!(rep, "  the offset decodes; only a race proves the number.");
        }
        say!(rep);

        // -- unit sanity, the open V1.4 question --
        say!(rep, "--- 5. Units (V1.4 brake model) ---");
        say!(rep);
        for (i, c) in CHECKS.iter().enumerate() {
            if !c.name.contains("BrakeTemp") && !c.name.contains("mTemperature") {
                continue;
            }
            let s = &stats[i];
            say!(
                rep,
                "  {:<30} {:>8.1} … {:>8.1}   as Kelvin: {:>6.1} … {:>6.1} °C",
                c.name,
                s.min,
                s.max,
                s.min - 273.15,
                s.max - 273.15
            );
        }
        say!(rep);
        say!(rep, "  If the °C column reads like real temperatures (tires 60-110, brakes");
        say!(rep, "  200-700 after braking), the values are Kelvin and main.rs subtracting");
        say!(rep, "  273.15 is right. If the raw column already reads like °C, V1.4 changed");
        say!(rep, "  the unit and both the bridge and TireMonitor's thresholds need fixing.");
        say!(rep);

        // -- consistency --
        say!(rep, "--- 6. Torn reads (LMU_Data has no version block) ---");
        say!(rep);
        let pct = |n: u64| {
            if snapshots > 0 {
                n as f64 * 100.0 / snapshots as f64
            } else {
                0.0
            }
        };
        say!(rep, "  scoring/telemetry car-count mismatch: {car_count_mismatch}/{snapshots} ({:.2}%)", pct(car_count_mismatch));
        say!(rep, "  player mID mismatch between the two:  {id_mismatch}/{snapshots} ({:.2}%)", pct(id_mismatch));
        say!(rep, "  snapshots with no player telemetry:   {no_player}");
        say!(rep, "  snapshots with no player scoring row: {no_player_row}");
        say!(rep, "  (pyLMUSharedMemory skips a copy on exactly the first check. A few");
        say!(rep, "   percent is normal and the port would retry; a large share means the");
        say!(rep, "   bridge needs its own retry loop to replace read_versioned().)");
        say!(rep);

        // -- safety car --
        say!(rep, "--- 7. Safety car: the one field with no LMU_Data equivalent ---");
        say!(rep);
        say!(rep, "  {:<11} {:<11} {:<8} {:<8} {}", "sc_exists", "sc_active", "phase", "yellow", "snapshots");
        sc_rows.sort_by(|a, b| b.4.cmp(&a.4));
        for (exists, active, phase, yellow, count) in &sc_rows {
            let e = if *exists == 255 { "n/a".into() } else { exists.to_string() };
            let a = if *active == 255 { "n/a".into() } else { active.to_string() };
            say!(rep, "  {e:<11} {a:<11} {phase:<8} {yellow:<8} {count}");
        }
        say!(rep);
        let saw_fcy = sc_rows.iter().any(|r| r.2 == 6 || r.3 > 0);
        if smmp.iter().any(|b| b.name.contains("Rules")) {
            say!(rep, "  sc_active comes from the plugin's Rules buffer. If it only ever reads");
            say!(rep, "  1 together with phase=6, mGamePhase alone reconstructs the safety car");
            say!(rep, "  and the Rules buffer is not needed.");
        } else {
            say!(rep, "  No Rules buffer in this run, so there is nothing to cross-check");
            say!(rep, "  against — expected with the plugin removed. What LMU_Data offers as a");
            say!(rep, "  substitute is mGamePhase=6 (full course yellow) and mYellowFlagState.");
            say!(
                rep,
                "  Full course yellow seen in this run: {}",
                if saw_fcy { "yes" } else { "no" }
            );
            say!(rep, "  mSafetyCarExists (is a safety car configured at all) has no equivalent");
            say!(rep, "  in LMU_Data under any circumstances.");
        }
        say!(rep);

        // -- cross-check (baseline runs only) --
        say!(rep, "--- 8. Same value from both maps (plugin runs only) ---");
        say!(rep);
        if xstats.iter().all(|s| s.0 == 0) {
            say!(rep, "  Skipped: no plugin telemetry buffer to compare against. Expected");
            say!(rep, "  during the plugin-free proof — and not needed for it. Section 4's");
            say!(rep, "  plausibility windows do that job without a second source.");
        } else {
            say!(rep, "  {:<30} {:>10}  {}", "field", "max |delta|", "samples");
            for (i, f) in XFIELDS.iter().enumerate() {
                say!(rep, "  {:<30} {:>10.6}  {}", f.name, xstats[i].1, xstats[i].0);
            }
            say!(rep);
            say!(rep, "  0.000000 means both maps decode to identical bits — switching the");
            say!(rep, "  bridge to LMU_Data changes no number the dashboard shows. Small");
            say!(rep, "  non-zero deltas on fast-moving fields (RPM, mElapsedTime) are the");
            say!(rep, "  sampling skew between the two reads, not a decoding difference.");
        }
        say!(rep);

        // -- verdict --
        say!(rep, "=== VERDICT ===");
        say!(rep);
        let total = CHECKS.len() + STRING_CHECKS.len();
        say!(rep, "  Plugin absent during this run:  {}", yes_no(plugin_absent));
        say!(rep, "  LMU_Data scoring writing:       {}", yes_no(scoring_rate.is_live()));
        say!(rep, "  LMU_Data telemetry writing:     {}", yes_no(telem_rate.is_live()));
        say!(rep, "  Fields proven:                  {ok_count}/{total}");
        say!(rep, "  Fields decoding but all-zero:   {zero_ok_count}/{total} (legal zeros)");
        say!(rep, "  Fields failing:                 {}/{total}", gaps.len());
        say!(rep, "  Laps completed:                 {completed_laps}");
        say!(rep);

        if !gaps.is_empty() {
            say!(rep, "  Failing fields:");
            for (name, v) in &gaps {
                say!(rep, "    {:<32} {}", name, v.label());
            }
            say!(rep);
        }

        let proven = plugin_absent
            && scoring_rate.is_live()
            && telem_rate.is_live()
            && gaps.is_empty();

        if proven {
            say!(rep, "  ==> PROVEN: with the plugin not installed, LMU_Data supplied every");
            say!(rep, "      field the bridge reads today, at {:.0} Hz scoring and {:.0} Hz", scoring_rate.hz(elapsed), telem_rate.hz(elapsed));
            say!(rep, "      telemetry. The rFactor2SharedMemoryMapPlugin is not required.");
            say!(rep, "      Remaining exception: the safety car (section 7).");
            if completed_laps == 0 {
                say!(rep);
                say!(rep, "      Qualified: no lap was completed, so the lap-timing and per-lap");
                say!(rep, "      fuel fields passed on their sentinels rather than on data.");
                say!(rep, "      Repeat with at least one full lap before calling those proven.");
            }
        } else if !plugin_absent {
            say!(rep, "  ==> INCONCLUSIVE as a plugin-free proof: plugin buffers were mapped");
            say!(rep, "      during this run. The coverage table above is still valid as a");
            say!(rep, "      baseline — repeat with the DLL renamed for the actual proof.");
        } else if !telem_rate.is_live() || !scoring_rate.is_live() {
            say!(rep, "  ==> INCONCLUSIVE: LMU_Data did not tick. Sit in a session and on");
            say!(rep, "      track — a paused sim or a menu looks exactly like a dead writer.");
        } else {
            say!(rep, "  ==> NOT PROVEN: {} field(s) above did not check out. Each one is", gaps.len());
            say!(rep, "      either genuinely missing from LMU_Data or decoded at the wrong");
            say!(rep, "      offset; IMPLAUSIBLE points at the layout, SUSPECT at the field.");
            say!(rep, "      A field the session could not exercise (no pitstop, no damage)");
            say!(rep, "      shows up here too — check the list before treating it as a bug.");
        }

        rep.save(out);
    }

    /// Locate a vehicle in the plugin's telemetry buffer by slot ID.
    ///
    /// The SMMP buffer maps 128 slots and has no player index, so this is the
    /// same linear scan the bridge does today.
    fn find_smmp_vehicle(t: &Mapped, id: i32) -> Option<rF2VehicleTelemetry> {
        unsafe {
            let n: i32 = t.at(SMMP_TELEM_NUM_VEHICLES_OFFSET);
            let n = n.clamp(0, 128) as usize;
            for i in 0..n {
                let off = SMMP_TELEM_VEHICLES_OFFSET + i * size_of::<rF2VehicleTelemetry>();
                let veh: rF2VehicleTelemetry = t.at(off);
                if veh.mID == id {
                    return Some(veh);
                }
            }
        }
        None
    }

    fn yes_no(b: bool) -> &'static str {
        if b {
            "yes"
        } else {
            "NO"
        }
    }
}
