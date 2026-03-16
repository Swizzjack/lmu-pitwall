use std::collections::VecDeque;

const MAX_SAMPLES: usize = 5;
const PIT_FUEL_THRESHOLD: f64 = 5.0; // litres — fuel increase above this = pit stop
const PIT_FLASH_TICKS: u32 = 90;     // ~3 seconds at 30 Hz

#[derive(Debug, Clone)]
pub struct FuelSnapshot {
    pub avg_consumption: f64,     // L/lap rolling avg (5 laps), 0.0 = no data yet
    pub laps_remaining: f64,      // current_fuel / avg; f64::INFINITY if avg=0
    pub stint_number: u32,        // 1-based, increments on each pit stop
    pub stint_laps: u32,          // laps completed in current stint
    pub stint_consumption: f64,   // total fuel used since stint start
    pub recommended: f64,         // fuel needed for remaining session laps + 0.5 lap reserve
    pub pit_detected: bool,       // true for ~3s after a pit stop is detected
}

impl Default for FuelSnapshot {
    fn default() -> Self {
        Self {
            avg_consumption: 0.0,
            laps_remaining: f64::INFINITY,
            stint_number: 1,
            stint_laps: 0,
            stint_consumption: 0.0,
            recommended: 0.0,
            pit_detected: false,
        }
    }
}

pub struct FuelTracker {
    lap_fuel_samples: VecDeque<f64>,  // rolling window of per-lap consumption
    fuel_at_lap_start: Option<f64>,   // fuel level when current lap began
    prev_fuel: Option<f64>,           // fuel level on previous tick (for pit detection)
    last_lap_number: i32,             // mTotalLaps on previous tick

    stint_number: u32,
    stint_start_lap: i32,
    stint_start_fuel: f64,
    stint_laps: u32,
    pit_flash_ticks: u32,             // countdown; pit_detected = true while > 0
}

impl FuelTracker {
    pub fn new() -> Self {
        Self {
            lap_fuel_samples: VecDeque::with_capacity(MAX_SAMPLES),
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
    /// * `current_fuel`  — mFuel for the player vehicle (litres)
    /// * `current_lap`   — mTotalLaps for the player vehicle (completed laps)
    /// * `in_pits`       — mInPits from scoring (true while car is in pit lane)
    /// * `session_laps_remaining` — laps left in session; ≤ 0 = time-based / unknown
    pub fn update(
        &mut self,
        current_fuel: f64,
        current_lap: i32,
        in_pits: bool,
        session_laps_remaining: i32,
    ) -> FuelSnapshot {
        // --- Pit stop detection (inter-tick fuel increase > threshold, only while in pits) ---
        // Requiring in_pits prevents false triggers from race-start fuel top-ups (rolling starts).
        if let Some(prev) = self.prev_fuel {
            if in_pits && current_fuel > prev + PIT_FUEL_THRESHOLD {
                self.stint_number += 1;
                self.stint_start_lap = current_lap;
                self.stint_start_fuel = current_fuel;
                self.stint_laps = 0;
                self.lap_fuel_samples.clear();
                self.fuel_at_lap_start = Some(current_fuel);
                self.pit_flash_ticks = PIT_FLASH_TICKS;
            }
        }
        self.prev_fuel = Some(current_fuel);

        // --- Initialise on first update ---
        if self.last_lap_number < 0 {
            self.last_lap_number = current_lap;
            self.fuel_at_lap_start = Some(current_fuel);
            self.stint_start_fuel = current_fuel;
            self.stint_start_lap = current_lap;
        }

        // --- Lap transition ---
        if current_lap > self.last_lap_number {
            if let Some(lap_start_fuel) = self.fuel_at_lap_start {
                let consumed = lap_start_fuel - current_fuel;
                // Skip first stint lap (warm-up / cold tyres) — only record from lap 2 onward.
                // Sanity bounds: must be positive and < 20 L/lap
                // Sanity bounds: must be positive and < 20 L/lap.
                // No first-lap skip — the median handles outlier warm-up laps.
                if consumed > 0.0 && consumed < 20.0 {
                    if self.lap_fuel_samples.len() >= MAX_SAMPLES {
                        self.lap_fuel_samples.pop_front();
                    }
                    self.lap_fuel_samples.push_back(consumed);
                }
            }
            self.last_lap_number = current_lap;
            self.fuel_at_lap_start = Some(current_fuel);
            self.stint_laps = (current_lap - self.stint_start_lap).max(0) as u32;
        }

        // --- Rolling median ---
        let avg = median(&self.lap_fuel_samples);

        // --- Derived values ---
        let laps_remaining = if avg > 0.0 {
            current_fuel / avg
        } else {
            f64::INFINITY
        };

        let stint_consumption = self.stint_start_fuel - current_fuel;

        let recommended = if session_laps_remaining > 0 && avg > 0.0 {
            let laps = session_laps_remaining as f64;
            laps * avg + avg * 0.5
        } else {
            0.0
        };

        // --- Pit flash countdown ---
        let pit_detected = self.pit_flash_ticks > 0;
        if self.pit_flash_ticks > 0 {
            self.pit_flash_ticks -= 1;
        }

        FuelSnapshot {
            avg_consumption: avg,
            laps_remaining,
            stint_number: self.stint_number,
            stint_laps: self.stint_laps,
            stint_consumption: stint_consumption.max(0.0),
            recommended,
            pit_detected,
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
