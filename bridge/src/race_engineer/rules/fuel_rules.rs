use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::{CarClass, EngineerState};

pub struct FuelCriticalRule;
pub struct FuelLowRule;
pub struct VeLowRule;

impl Rule for FuelCriticalRule {
    fn id(&self) -> &'static str { "fuel_critical" }
    fn priority(&self) -> Priority { Priority::Critical }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if !current.effective_laps_left.is_finite() { return None; }
        if current.total_laps_driven < 1 { return None; }
        if current.in_pit { return None; }
        if current.race_ending() { return None; }
        if current.effective_laps_left < 1.2 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "fuel_critical_box",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for FuelLowRule {
    fn id(&self) -> &'static str { "fuel_low" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(45) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if !current.effective_laps_left.is_finite() { return None; }
        if current.total_laps_driven < 1 { return None; }
        if current.race_ending() { return None; }
        let threshold = 3.0_f32;
        let now = current.effective_laps_left;
        let was = prev.map(|p| p.effective_laps_left).unwrap_or(f32::INFINITY);
        // Only trigger when crossing the 3-lap threshold downward
        // and enough race laps remain (don't double-fire with fuel_critical)
        let race_laps_ok = current.laps_remaining.map(|l| l > threshold as u32).unwrap_or(true);
        if now < threshold && was >= threshold && !current.in_pit && race_laps_ok {
            let laps = now.ceil() as u32;
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "fuel_low",
                params: TemplateParams::new().set("laps", laps.to_string()),
            })
        } else {
            None
        }
    }
}

impl Rule for VeLowRule {
    fn id(&self) -> &'static str { "ve_low" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(45) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if current.player_class != CarClass::Hypercar { return None; }
        if !current.ve_laps_left.is_finite() { return None; }
        if current.race_ending() { return None; }
        // Only fire if VE is the limiting factor over fuel
        if current.ve_laps_left >= current.fuel_laps_left { return None; }
        let threshold = 3.0_f32;
        let now = current.ve_laps_left;
        let was = prev
            .map(|p| p.ve_laps_left)
            .filter(|v| v.is_finite())
            .unwrap_or(f32::INFINITY);
        if now < threshold && was >= threshold {
            let laps = now.ceil() as u32;
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "ve_low",
                params: TemplateParams::new().set("laps", laps.to_string()),
            })
        } else {
            None
        }
    }
}
