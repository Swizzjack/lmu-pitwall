use std::collections::VecDeque;

const MAX_SAMPLES: usize = 10;        // rolling window size for fuel and lap time samples
const PIT_FUEL_THRESHOLD: f64 = 5.0; // litres — fuel increase above this = pit stop
const PIT_FLASH_TICKS: u32 = 90;     // ~3 seconds at 30 Hz
const MAX_VALID_FUEL: f64 = 1000.0;  // no race car has > 1000 L tank
const MAX_VALID_LAP: i32 = 9_999;    // safety cap for mTotalLaps sentinel values
const MAX_VALID_CONSUMPTION: f64 = 100.0; // L/lap upper limit

#[derive(Debug, Clone)]
pub struct FuelSnapshot {
    pub avg_consumption: f64,   // L/lap rolling median; 0.0 = no valid data yet
    pub sample_count: u32,      // number of fuel-consumption samples collected
    pub laps_remaining: f64,    // current_fuel / avg; Infinity if avg = 0
    pub stint_number: u32,      // 1-based, increments on each pit stop
    pub stint_laps: u32,        // laps completed in current stint (including outlap)
    pub stint_consumption: f64, // total fuel used since stint start
    pub recommended: f64,       // kept for protocol compatibility; always 0.0
    pub pit_detected: bool,     // true for ~3 s after a pit stop is detected
    pub avg_lap_time: f64,      // rolling median lap time (s); 0.0 = no valid data yet
    pub lap_time_count: u32,    // number of lap-time samples collected
}

impl Default for FuelSnapshot {
    fn default() -> Self {
        Self {
            avg_consumption: 0.0,
            sample_count: 0,
            laps_remaining: f64::INFINITY,
            stint_number: 1,
            stint_laps: 0,
            stint_consumption: 0.0,
            recommended: 0.0,
            pit_detected: false,
            avg_lap_time: 0.0,
            lap_time_count: 0,
        }
    }
}

pub struct FuelTracker {
    lap_fuel_samples: VecDeque<f64>,  // rolling per-lap consumption
    lap_time_samples: VecDeque<f64>,  // rolling per-lap times (seconds)
    fuel_at_lap_start: Option<f64>,   // fuel when current lap began
    prev_fuel: Option<f64>,           // fuel from previous valid tick (for pit detection)
    last_lap_number: i32,             // mTotalLaps on previous tick; -1 = uninitialised

    stint_number: u32,
    stint_start_lap: i32,
    stint_start_fuel: f64,
    stint_laps: u32,
    pit_flash_ticks: u32,             // counts down; pit_detected = true while > 0
}

impl FuelTracker {
    pub fn new() -> Self {
        Self {
            lap_fuel_samples: VecDeque::with_capacity(MAX_SAMPLES),
            lap_time_samples: VecDeque::with_capacity(MAX_SAMPLES),
            fuel_at_lap_start: None,
            prev_fuel: None,
            last_lap_number: -1,
            stint_number: 1,
            stint_start_lap: 0,
            stint_start_fuel: 0.0,
            stint_laps: 0,
            pit_flash_ticks: 0,
        }
    }

    /// Called every telemetry tick.
    ///
    /// * `current_fuel`          — mFuel for the player vehicle (litres)
    /// * `current_lap`           — mTotalLaps for the player vehicle (completed laps)
    /// * `in_pits`               — mInPits from scoring
    /// * `session_laps_remaining`— laps left; ≤ 0 = time-based / unknown
    /// * `last_lap_time`         — mLastLapTime from scoring (seconds); ≤ 0 = invalid
    pub fn update(
        &mut self,
        current_fuel: f64,
        current_lap: i32,
        in_pits: bool,
        session_laps_remaining: i32,
        last_lap_time: f64,
    ) -> FuelSnapshot {
        // Always count down pit-flash independently of input validity
        if self.pit_flash_ticks > 0 {
            self.pit_flash_ticks -= 1;
        }

        // --- Input validation: reject sentinel / garbage values ---
        // mTotalLaps is i16 → max 32767; mFuel should never be negative or huge
        let fuel_valid = current_fuel >= 0.0 && current_fuel <= MAX_VALID_FUEL;
        let lap_valid  = current_lap >= 0 && current_lap <= MAX_VALID_LAP;

        if !fuel_valid || !lap_valid {
            // Return snapshot based on last known good state without updating it
            let display_fuel = self.prev_fuel.unwrap_or(0.0);
            return self.build_snapshot(display_fuel);
        }

        // --- Pit stop detection (fuel spike while in pits) ---
        if let Some(prev) = self.prev_fuel {
            if in_pits && current_fuel > prev + PIT_FUEL_THRESHOLD {
                self.stint_number    += 1;
                self.stint_start_lap  = current_lap;
                self.stint_start_fuel = current_fuel;
                self.stint_laps       = 0;
                self.lap_fuel_samples.clear();
                self.lap_time_samples.clear();
                self.fuel_at_lap_start = Some(current_fuel);
                self.pit_flash_ticks   = PIT_FLASH_TICKS;
            }
        }
        self.prev_fuel = Some(current_fuel);

        // --- Session restart detection ---
        // A restart of the same session keeps the same session key, so the outer
        // session-change guard in main.rs does not fire.  The reliable signal is
        // mTotalLaps dropping back below the last recorded lap number.  When that
        // happens, discard all stale samples and re-initialise from scratch.
        if self.last_lap_number >= 0 && current_lap < self.last_lap_number {
            self.lap_fuel_samples.clear();
            self.lap_time_samples.clear();
            self.fuel_at_lap_start = None;
            self.prev_fuel         = Some(current_fuel);
            self.last_lap_number   = -1;
            self.stint_number      = 1;
            self.stint_start_lap   = current_lap;
            self.stint_start_fuel  = current_fuel;
            self.stint_laps        = 0;
            self.pit_flash_ticks   = 0;
        }

        // --- First valid update: initialise tracker state ---
        if self.last_lap_number < 0 {
            self.last_lap_number   = current_lap;
            self.fuel_at_lap_start = Some(current_fuel);
            self.stint_start_fuel  = current_fuel;
            self.stint_start_lap   = current_lap;
        }

        // --- Lap transition ---
        if current_lap > self.last_lap_number {
            // Skip the first lap of each stint (outlap / formation lap).
            // self.stint_laps holds the count BEFORE this transition, so
            // 0 means the outlap just finished → skip its data.
            // For stint_laps >= 1, the lap that just finished is a real racing lap → record.
            if self.stint_laps >= 1 {
                // Fuel consumption sample
                if let Some(lap_start_fuel) = self.fuel_at_lap_start {
                    let consumed = lap_start_fuel - current_fuel;
                    if consumed > 0.0 && consumed < MAX_VALID_CONSUMPTION {
                        if self.lap_fuel_samples.len() >= MAX_SAMPLES {
                            self.lap_fuel_samples.pop_front();
                        }
                        self.lap_fuel_samples.push_back(consumed);
                    }
                }
                // Lap time sample
                if last_lap_time > 10.0 && last_lap_time < 600.0 {
                    if self.lap_time_samples.len() >= MAX_SAMPLES {
                        self.lap_time_samples.pop_front();
                    }
                    self.lap_time_samples.push_back(last_lap_time);
                }
            }

            self.last_lap_number   = current_lap;
            self.fuel_at_lap_start = Some(current_fuel);
            self.stint_laps = (current_lap - self.stint_start_lap).max(0) as u32;
        }

        // Suppress unused warning — session_laps_remaining kept for potential future use
        let _ = session_laps_remaining;

        self.build_snapshot(current_fuel)
    }

    fn build_snapshot(&self, current_fuel: f64) -> FuelSnapshot {
        let avg = median(&self.lap_fuel_samples);
        let laps_remaining = if avg > 0.0 {
            current_fuel / avg
        } else {
            f64::INFINITY
        };
        let stint_consumption = (self.stint_start_fuel - current_fuel).max(0.0);
        let avg_lap_time = median(&self.lap_time_samples);

        FuelSnapshot {
            avg_consumption:  avg,
            sample_count:     self.lap_fuel_samples.len() as u32,
            laps_remaining,
            stint_number:     self.stint_number,
            stint_laps:       self.stint_laps,
            stint_consumption,
            recommended:      0.0,
            pit_detected:     self.pit_flash_ticks > 0,
            avg_lap_time,
            lap_time_count:   self.lap_time_samples.len() as u32,
        }
    }
}

fn median(samples: &VecDeque<f64>) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = samples.iter().copied().collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}
