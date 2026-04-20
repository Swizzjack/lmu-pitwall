use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct RainStartingRule;
pub struct RainClearingRule;
pub struct TrackDryingRule;

const RAIN_THRESHOLD: f32 = 0.1;
const DRYING_ENTRY: f32 = 0.3;
const DRYING_EXIT: f32 = 0.05;

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
