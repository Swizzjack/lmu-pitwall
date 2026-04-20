use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct TireTempsOutOfRangeRule;

const TEMP_HOT: f32 = 105.0;
const TEMP_COLD: f32 = 75.0;

impl Rule for TireTempsOutOfRangeRule {
    fn id(&self) -> &'static str { "tire_temps_warning" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(90) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let temps = &current.tire_temps_c;
        if temps.iter().all(|&t| t < 1.0) { return None; }

        let hot = temps.iter().filter(|&&t| t > TEMP_HOT).count();
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
