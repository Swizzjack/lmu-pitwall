use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::{EngineerState, SessionPhase, SessionType};

pub struct FiveMinutesRemainingRule;
pub struct LastLapRule;
pub struct RaceFinishedRule;

impl Rule for FiveMinutesRemainingRule {
    fn id(&self) -> &'static str { "five_minutes_remaining" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(3600) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let threshold = Duration::from_secs(5 * 60);
        let now_time = current.time_remaining?;
        let was_time = prev.and_then(|p| p.time_remaining).unwrap_or(Duration::MAX);
        if now_time <= threshold && was_time > threshold {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "five_minutes_remaining",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for LastLapRule {
    fn id(&self) -> &'static str { "last_lap" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(3600) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE | SessionMask::QUALIFYING }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let is_last = match current.session_type {
            SessionType::Race => {
                current.laps_remaining == Some(1) && prev.laps_remaining != Some(1)
            }
            SessionType::Qualifying => {
                // ~90s left: player can start one more lap but not two
                let threshold = Duration::from_secs(90);
                let now_time = current.time_remaining.unwrap_or(Duration::MAX);
                let was_time = prev.time_remaining.unwrap_or(Duration::MAX);
                now_time < threshold && was_time >= threshold
            }
            _ => false,
        };
        if is_last {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "last_lap",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for RaceFinishedRule {
    fn id(&self) -> &'static str { "race_finished" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(3600) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if current.session_phase == SessionPhase::Finished
            && prev.session_phase != SessionPhase::Finished
        {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "race_finished",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}
