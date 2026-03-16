//! Button-counting electronics tracker.
//!
//! Maintains counters for TC, TC Cut, ABS, Engine Map, ARB, Brake Bias,
//! Regen and Brake Migration. Values are clamped to per-control ranges.
//!
//! Call `reset()` on session changes to return to configured defaults.
//! Call `apply_garage_data()` after a garage API fetch to load live values
//! and dynamic ranges (min/max) for the current car.

use std::collections::HashMap;

use crate::app_config::{ElectronicsBindings, ElectronicsDefaults};
use crate::garage_api::GarageData;
use crate::input::ElectronicsEvent;
use crate::shared_memory::types::{LmuExtendedBuffer, bytes_to_str};

// ---------------------------------------------------------------------------
// Value ranges (clamping bounds per control)
// ---------------------------------------------------------------------------

struct Ranges {
    tc:              (i32, i32),
    tc_cut:          (i32, i32),
    tc_slip:         (i32, i32),
    abs:             (i32, i32),
    engine_map:      (i32, i32),
    front_arb:       (i32, i32),
    rear_arb:        (i32, i32),
    brake_bias:      (f64, f64),
    regen:           (i32, i32),
    brake_migration: (i32, i32),
}

impl Default for Ranges {
    fn default() -> Self {
        Self {
            tc:              (0,  12),
            tc_cut:          (0,  12),
            tc_slip:         (0,  12),
            abs:             (0,  12),
            engine_map:      (1,  10),
            front_arb:       (1,   6),
            rear_arb:        (1,   6),
            brake_bias:      (50.0, 65.0),
            regen:           (0,  11),
            brake_migration: (0,  10),
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot — cheap copyable view of current state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ElectronicsSnapshot {
    pub tc:                  i32,
    pub tc_cut:              i32,
    pub tc_slip:             i32,
    pub abs:                 i32,
    pub engine_map:          i32,
    pub front_arb:           i32,
    pub rear_arb:            i32,
    pub brake_bias:          f64,
    pub regen:               i32,
    pub brake_migration:     i32,
    pub brake_migration_max: i32,
    pub buttons_configured:  bool,
    /// In-game display labels from the garage API (e.g. "engine_map" → "40kW").
    /// Empty when no garage data has been fetched yet.
    pub garage_labels:       HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

pub struct ElectronicsTracker {
    pub tc:              i32,
    pub tc_cut:          i32,
    pub tc_slip:         i32,
    pub abs:             i32,
    pub engine_map:      i32,
    pub front_arb:       i32,
    pub rear_arb:        i32,
    pub brake_bias:      f64,
    pub regen:           i32,
    pub brake_migration: i32,

    defaults:      ElectronicsDefaults,
    ranges:        Ranges,
    garage_labels: HashMap<String, String>,
}

impl ElectronicsTracker {
    pub fn new(defaults: &ElectronicsDefaults) -> Self {
        Self {
            tc:              defaults.tc,
            tc_cut:          defaults.tc_cut,
            tc_slip:         defaults.tc_slip,
            abs:             defaults.abs,
            engine_map:      defaults.engine_map,
            front_arb:       defaults.front_arb,
            rear_arb:        defaults.rear_arb,
            brake_bias:      defaults.brake_bias,
            regen:           defaults.regen,
            brake_migration: defaults.brake_migration,
            defaults: defaults.clone(),
            ranges:   Ranges::default(),
            garage_labels: HashMap::new(),
        }
    }

    /// Update the stored defaults without resetting current values.
    /// New defaults take effect on the next `reset()` (session change).
    pub fn update_defaults(&mut self, defaults: &ElectronicsDefaults) {
        self.defaults = defaults.clone();
    }

    /// Reset all values to the configured defaults (call on session change).
    pub fn reset(&mut self) {
        self.tc              = self.defaults.tc;
        self.tc_cut          = self.defaults.tc_cut;
        self.tc_slip         = self.defaults.tc_slip;
        self.abs             = self.defaults.abs;
        self.engine_map      = self.defaults.engine_map;
        self.front_arb       = self.defaults.front_arb;
        self.rear_arb        = self.defaults.rear_arb;
        self.brake_bias      = self.defaults.brake_bias;
        self.regen           = self.defaults.regen;
        self.brake_migration = self.defaults.brake_migration;
        // Keep garage_labels — they are still valid for the same car.
        // They are cleared in apply_garage_data when new data arrives.
    }

    /// Apply live garage values fetched from the LMU REST API.
    ///
    /// Only available fields (where `available == true`) are applied.
    /// Also updates dynamic min/max ranges for each control.
    pub fn apply_garage_data(&mut self, data: &GarageData) {
        self.garage_labels.clear();

        macro_rules! apply_int {
            ($field:expr, $target:expr, $range:expr, $label_key:expr) => {
                if $field.available {
                    let lo = $field.min_value;
                    let hi = $field.max_value.max(lo); // guard against lo > hi
                    $range = (lo, hi);
                    $target = $field.value.clamp(lo, hi);
                    if !$field.string_value.is_empty() {
                        self.garage_labels.insert($label_key.to_string(), $field.string_value.clone());
                    }
                }
            };
        }

        apply_int!(data.tc,              self.tc,              self.ranges.tc,              "tc");
        apply_int!(data.tc_cut,          self.tc_cut,          self.ranges.tc_cut,          "tc_cut");
        apply_int!(data.tc_slip,         self.tc_slip,         self.ranges.tc_slip,         "tc_slip");
        apply_int!(data.abs,             self.abs,             self.ranges.abs,             "abs");
        apply_int!(data.engine_map,      self.engine_map,      self.ranges.engine_map,      "engine_map");
        apply_int!(data.front_arb,       self.front_arb,       self.ranges.front_arb,       "front_arb");
        apply_int!(data.rear_arb,        self.rear_arb,        self.ranges.rear_arb,        "rear_arb");
        apply_int!(data.regen,           self.regen,           self.ranges.regen,           "regen");
        apply_int!(data.brake_migration, self.brake_migration, self.ranges.brake_migration, "brake_migration");

        // Brake bias: parse front % from "52.3:47.7"
        if data.brake_bias.available {
            if let Some(front_pct) = parse_bb_front(&data.brake_bias.string_value) {
                self.brake_bias = front_pct.clamp(self.ranges.brake_bias.0, self.ranges.brake_bias.1);
                if !data.brake_bias.string_value.is_empty() {
                    self.garage_labels.insert("brake_bias".to_string(), data.brake_bias.string_value.clone());
                }
            }
        }

        tracing::info!(
            "Garage data applied — TC={} ARB={}/{} map={} regen={} bias={:.1}",
            self.tc, self.front_arb, self.rear_arb, self.engine_map, self.regen, self.brake_bias
        );
    }

    /// Apply a single input event, clamping the result to the control's range.
    pub fn apply_event(&mut self, event: ElectronicsEvent) {
        match event {
            ElectronicsEvent::TcIncrease        => self.tc = (self.tc + 1).min(self.ranges.tc.1),
            ElectronicsEvent::TcDecrease        => self.tc = (self.tc - 1).max(self.ranges.tc.0),
            ElectronicsEvent::TcCutIncrease     => self.tc_cut = (self.tc_cut + 1).min(self.ranges.tc_cut.1),
            ElectronicsEvent::TcCutDecrease     => self.tc_cut = (self.tc_cut - 1).max(self.ranges.tc_cut.0),
            ElectronicsEvent::TcSlipIncrease    => self.tc_slip = (self.tc_slip + 1).min(self.ranges.tc_slip.1),
            ElectronicsEvent::TcSlipDecrease    => self.tc_slip = (self.tc_slip - 1).max(self.ranges.tc_slip.0),
            ElectronicsEvent::AbsIncrease       => self.abs = (self.abs + 1).min(self.ranges.abs.1),
            ElectronicsEvent::AbsDecrease       => self.abs = (self.abs - 1).max(self.ranges.abs.0),
            ElectronicsEvent::EngineMapIncrease => self.engine_map = (self.engine_map + 1).min(self.ranges.engine_map.1),
            ElectronicsEvent::EngineMapDecrease => self.engine_map = (self.engine_map - 1).max(self.ranges.engine_map.0),
            ElectronicsEvent::FrontArbIncrease  => self.front_arb = (self.front_arb + 1).min(self.ranges.front_arb.1),
            ElectronicsEvent::FrontArbDecrease  => self.front_arb = (self.front_arb - 1).max(self.ranges.front_arb.0),
            ElectronicsEvent::RearArbIncrease   => self.rear_arb = (self.rear_arb + 1).min(self.ranges.rear_arb.1),
            ElectronicsEvent::RearArbDecrease   => self.rear_arb = (self.rear_arb - 1).max(self.ranges.rear_arb.0),
            ElectronicsEvent::BrakeBiasIncrease => self.brake_bias = (self.brake_bias + 0.5).min(self.ranges.brake_bias.1),
            ElectronicsEvent::BrakeBiasDecrease => self.brake_bias = (self.brake_bias - 0.5).max(self.ranges.brake_bias.0),
            ElectronicsEvent::RegenIncrease     => self.regen = (self.regen + 1).min(self.ranges.regen.1),
            ElectronicsEvent::RegenDecrease     => self.regen = (self.regen - 1).max(self.ranges.regen.0),
            ElectronicsEvent::BrakeMigrationIncrease => self.brake_migration = (self.brake_migration + 1).min(self.ranges.brake_migration.1),
            ElectronicsEvent::BrakeMigrationDecrease => self.brake_migration = (self.brake_migration - 1).max(self.ranges.brake_migration.0),
        }

        // Keep garage_labels display strings in sync after a button press.
        // We update only numeric-style labels where the string is just the number.
        // Labels like "P4", "40kW" stay as-is until the next garage fetch.
    }

    /// When DMA is active, sync live values from the LMU extended buffer.
    /// Called every poll tick. Fields that have a button binding are skipped —
    /// button counting is the authoritative source for those controls.
    pub fn sync_from_dma(
        &mut self,
        lmu: &LmuExtendedBuffer,
        rear_brake_bias_raw: f64,
        bindings: &ElectronicsBindings,
    ) {
        if lmu.mDirectMemoryAccessEnabled == 0 {
            return;
        }
        // Helper: true if either direction of a control has a binding configured.
        let bound = |a: &Option<_>, b: &Option<_>| a.is_some() || b.is_some();

        if !bound(&bindings.tc_increase, &bindings.tc_decrease) {
            self.tc = lmu.mpTractionControl.clamp(self.ranges.tc.0, self.ranges.tc.1);
        }
        if !bound(&bindings.farb_increase, &bindings.farb_decrease) {
            self.front_arb = lmu.mFront_ABR.clamp(self.ranges.front_arb.0, self.ranges.front_arb.1);
        }
        if !bound(&bindings.rarb_increase, &bindings.rarb_decrease) {
            self.rear_arb = lmu.mRear_ABR.clamp(self.ranges.rear_arb.0, self.ranges.rear_arb.1);
        }
        if !bound(&bindings.brake_migration_increase, &bindings.brake_migration_decrease) {
            self.brake_migration = lmu.mpBrakeMigration
                .clamp(self.ranges.brake_migration.0, self.ranges.brake_migration.1);
        }
        // Always update the max range — it is metadata, not a user-controlled value.
        if lmu.mpBrakeMigrationMax > 0 {
            self.ranges.brake_migration.1 = lmu.mpBrakeMigrationMax;
        }
        if !bound(&bindings.brake_bias_increase, &bindings.brake_bias_decrease) {
            let front_pct = (1.0 - rear_brake_bias_raw) * 100.0;
            self.brake_bias = front_pct.clamp(self.ranges.brake_bias.0, self.ranges.brake_bias.1);
        }
        if !bound(&bindings.engine_map_increase, &bindings.engine_map_decrease) {
            let map_name = bytes_to_str(&lmu.mpMotorMap);
            if let Some(n) = parse_map_number(map_name) {
                self.engine_map = n.clamp(self.ranges.engine_map.0, self.ranges.engine_map.1);
            }
        }
    }

    /// Return a cheap snapshot of current values.
    pub fn snapshot(&self, buttons_configured: bool) -> ElectronicsSnapshot {
        ElectronicsSnapshot {
            tc:                  self.tc,
            tc_cut:              self.tc_cut,
            tc_slip:             self.tc_slip,
            abs:                 self.abs,
            engine_map:          self.engine_map,
            front_arb:           self.front_arb,
            rear_arb:            self.rear_arb,
            brake_bias:          self.brake_bias,
            regen:               self.regen,
            brake_migration:     self.brake_migration,
            brake_migration_max: self.ranges.brake_migration.1,
            buttons_configured,
            garage_labels:       self.garage_labels.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_map_number(name: &str) -> Option<i32> {
    let digits: String = name.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// "52.3:47.7" → 52.3
fn parse_bb_front(s: &str) -> Option<f64> {
    s.split(':').next()?.trim().parse().ok()
}
