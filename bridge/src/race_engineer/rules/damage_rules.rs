use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct DamageReportedRule;

impl Rule for DamageReportedRule {
    fn id(&self) -> &'static str { "damage_reported" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(60) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let new_aero = current.damage.has_aero && !prev.damage.has_aero;
        let new_susp = current.damage.has_suspension && !prev.damage.has_suspension;
        let new_detach = current.damage.any_detached && !prev.damage.any_detached;

        if new_aero || new_susp || new_detach {
            let damage_type = if new_susp || new_detach { "suspension" } else { "aero" };
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "damage_reported",
                params: TemplateParams::new().set("damage_type", damage_type),
            })
        } else {
            None
        }
    }
}
