use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct PitWindowOpeningRule;
pub struct DrivethroughPenaltyRule;
pub struct DqWarningRule;

impl Rule for PitWindowOpeningRule {
    fn id(&self) -> &'static str { "pit_window_open" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(60) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if current.race_ending() { return None; }
        let threshold = 5.0_f32;
        let now = current.effective_laps_left;
        let was = prev.map(|p| p.effective_laps_left).unwrap_or(f32::INFINITY);
        // Fire once when crossing the 5-lap threshold downward
        let race_laps_ok = current.laps_remaining.map(|l| l > threshold as u32).unwrap_or(true);
        if now < threshold && was >= threshold && !current.in_pit && race_laps_ok {
            let laps = now.ceil() as u32;
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "pit_window_open",
                params: TemplateParams::new().set("laps", laps.to_string()),
            })
        } else {
            None
        }
    }
}

impl Rule for DrivethroughPenaltyRule {
    fn id(&self) -> &'static str { "penalty_received" }
    fn priority(&self) -> Priority { Priority::Critical }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let now = current.num_penalties;
        let was = prev.map(|p| p.num_penalties).unwrap_or(0);
        if now > 0 && now > was {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "penalty_received",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for DqWarningRule {
    fn id(&self) -> &'static str { "dq_warning" }
    fn priority(&self) -> Priority { Priority::Critical }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, _current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        // Track-limit cut count not available in current state pipeline (requires LmuExtendedBuffer).
        None
    }
}

pub struct PitlaneExitBriefingRule;

impl Rule for PitlaneExitBriefingRule {
    fn id(&self) -> &'static str { "pitlane_exit_briefing" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(60) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        // Fire exactly on the tick where the car leaves the pitlane
        if current.in_pit || !prev.in_pit {
            return None;
        }

        let condition = if current.rain_intensity > 0.3 {
            "wet"
        } else if current.rain_intensity > 0.05 {
            "damp"
        } else {
            "dry"
        };

        let avg_tire_temp: f32 = current.tire_temps_c.iter().sum::<f32>() / 4.0;
        let tire_status = if avg_tire_temp < 60.0 {
            "cold"
        } else if avg_tire_temp < 85.0 {
            "warming up"
        } else {
            "up to temperature"
        };

        let temp = current.ambient_temp_c.round() as i32;

        Some(RuleEvent {
            rule_id: self.id(),
            priority: self.priority(),
            template_key: "pitlane_exit_briefing",
            params: TemplateParams::new()
                .set("condition", condition.to_string())
                .set("temp", temp.to_string())
                .set("tire_status", tire_status.to_string()),
        })
    }
}
