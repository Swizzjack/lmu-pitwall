use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct RainStartingRule;
pub struct RainClearingRule;
pub struct TrackDryingRule;
pub struct RainEscalationRule;

pub struct AmbientTempChangeRule {
    baseline_bits: AtomicU32,
    initialized: AtomicBool,
}

pub struct TrackTempChangeRule {
    baseline_bits: AtomicU32,
    initialized: AtomicBool,
}

impl AmbientTempChangeRule {
    pub fn new() -> Self {
        Self { baseline_bits: AtomicU32::new(0), initialized: AtomicBool::new(false) }
    }
}

impl TrackTempChangeRule {
    pub fn new() -> Self {
        Self { baseline_bits: AtomicU32::new(0), initialized: AtomicBool::new(false) }
    }
}

const RAIN_THRESHOLD: f32 = 0.1;
const DRYING_ENTRY: f32 = 0.3;
const DRYING_EXIT: f32 = 0.05;
const RAIN_HEAVY_THRESHOLD: f32 = 0.5;
const TEMP_CHANGE_THRESHOLD_C: f32 = 2.0;

impl Rule for RainStartingRule {
    fn id(&self) -> &'static str { "rain_starting" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let now = current.rain_intensity;
        let was = prev.map(|p| p.rain_intensity).unwrap_or(0.0);
        if now >= RAIN_THRESHOLD && was < RAIN_THRESHOLD {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "rain_starting",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for RainClearingRule {
    fn id(&self) -> &'static str { "rain_clearing" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let now = current.rain_intensity;
        let was = prev.map(|p| p.rain_intensity).unwrap_or(0.0);
        if now < RAIN_THRESHOLD && was >= RAIN_THRESHOLD {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "rain_clearing",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for TrackDryingRule {
    fn id(&self) -> &'static str { "track_drying" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        // Rain was notable (>0.3), now dropping into the drying zone (<=0.3 but still >0.05)
        let now = current.rain_intensity;
        let was = prev.rain_intensity;
        if was > DRYING_ENTRY && now <= DRYING_ENTRY && now > DRYING_EXIT {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "track_drying",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for RainEscalationRule {
    fn id(&self) -> &'static str { "rain_heavy" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let now = current.rain_intensity;
        let was = prev.map(|p| p.rain_intensity).unwrap_or(0.0);
        if now >= RAIN_HEAVY_THRESHOLD && was < RAIN_HEAVY_THRESHOLD {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "rain_heavy",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for AmbientTempChangeRule {
    fn id(&self) -> &'static str { "ambient_temp_change" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(600) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if !self.initialized.load(Ordering::Relaxed) {
            self.baseline_bits.store(current.ambient_temp_c.to_bits(), Ordering::Relaxed);
            self.initialized.store(true, Ordering::Relaxed);
            return None;
        }
        let baseline = f32::from_bits(self.baseline_bits.load(Ordering::Relaxed));
        let delta = current.ambient_temp_c - baseline;
        if delta.abs() >= TEMP_CHANGE_THRESHOLD_C {
            self.baseline_bits.store(current.ambient_temp_c.to_bits(), Ordering::Relaxed);
            let direction = if delta > 0.0 { "up" } else { "down" };
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "ambient_temp_change",
                params: TemplateParams::new()
                    .set("temp", format!("{:.0}", current.ambient_temp_c))
                    .set("delta", format!("{:.0}", delta.abs()))
                    .set("direction", direction),
            })
        } else {
            None
        }
    }
}

impl Rule for TrackTempChangeRule {
    fn id(&self) -> &'static str { "track_temp_change" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(600) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if !self.initialized.load(Ordering::Relaxed) {
            self.baseline_bits.store(current.track_temp_c.to_bits(), Ordering::Relaxed);
            self.initialized.store(true, Ordering::Relaxed);
            return None;
        }
        let baseline = f32::from_bits(self.baseline_bits.load(Ordering::Relaxed));
        let delta = current.track_temp_c - baseline;
        if delta.abs() >= TEMP_CHANGE_THRESHOLD_C {
            self.baseline_bits.store(current.track_temp_c.to_bits(), Ordering::Relaxed);
            let direction = if delta > 0.0 { "up" } else { "down" };
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "track_temp_change",
                params: TemplateParams::new()
                    .set("temp", format!("{:.0}", current.track_temp_c))
                    .set("delta", format!("{:.0}", delta.abs()))
                    .set("direction", direction),
            })
        } else {
            None
        }
    }
}
