use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct TireTempsOutOfRangeRule;
pub struct TireTempsInRangeRule;

const TEMP_HOT: f32  = 105.0;
const TEMP_COLD: f32 = 70.0;

fn any_out_of_range(temps: &[f32; 4]) -> bool {
    temps.iter().any(|&t| t > 1.0 && (t > TEMP_HOT || t < TEMP_COLD))
}

impl Rule for TireTempsOutOfRangeRule {
    fn id(&self) -> &'static str { "tire_temps_warning" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(90) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let temps = &current.tire_temps_c;
        if temps.iter().all(|&t| t < 1.0) { return None; }

        let hot  = temps.iter().filter(|&&t| t > TEMP_HOT).count();
        let cold = temps.iter().filter(|&&t| t > 1.0 && t < TEMP_COLD).count();

        let template_key = if hot > 0 {
            "tire_temps_hot_warning"
        } else if cold > 0 {
            "tire_temps_warning"
        } else {
            return None;
        };

        Some(RuleEvent {
            rule_id: self.id(),
            priority: self.priority(),
            template_key,
            params: TemplateParams::new(),
        })
    }
}

impl Rule for TireTempsInRangeRule {
    fn id(&self) -> &'static str { "tire_temps_ok" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let temps = &current.tire_temps_c;
        // Need valid temp readings
        if temps.iter().all(|&t| t < 1.0) { return None; }
        // Current must be fully in range
        if any_out_of_range(temps) { return None; }
        // Previous must have had at least one tire out of range
        let prev = prev?;
        if !any_out_of_range(&prev.tire_temps_c) { return None; }

        Some(RuleEvent {
            rule_id: self.id(),
            priority: self.priority(),
            template_key: "tire_temps_ok",
            params: TemplateParams::new(),
        })
    }
}
