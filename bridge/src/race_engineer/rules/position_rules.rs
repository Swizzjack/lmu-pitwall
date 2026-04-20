use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct PositionGainedRule;
pub struct PositionLostRule;
/// Gap ahead at Medium frequency (90s cooldown).
pub struct GapAheadMediumRule;
/// Gap ahead at High frequency (30s cooldown).
pub struct GapAheadHighRule;
/// Gap behind at Medium frequency (90s cooldown).
pub struct GapBehindMediumRule;
/// Gap behind at High frequency (30s cooldown).
pub struct GapBehindHighRule;

impl Rule for PositionGainedRule {
    fn id(&self) -> &'static str { "position_gained" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if current.player_position > 0
            && prev.player_position > 0
            && current.player_position < prev.player_position
        {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "position_gained",
                params: TemplateParams::new().set("position", current.player_position.to_string()),
            })
        } else {
            None
        }
    }
}

impl Rule for PositionLostRule {
    fn id(&self) -> &'static str { "position_lost" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if current.player_position > 0
            && prev.player_position > 0
            && current.player_position > prev.player_position
        {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "position_lost",
                params: TemplateParams::new().set("position", current.player_position.to_string()),
            })
        } else {
            None
        }
    }
}

fn gap_ahead_event(rule_id: &'static str, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
    if current.in_pit { return None; }
    let gap = current.gap_ahead?;
    let trend = prev.and_then(|p| p.gap_ahead).map(|prev_gap| {
        let delta = gap - prev_gap;
        if delta < -0.2 { "closing" } else if delta > 0.2 { "pulling away" } else { "holding steady" }
    }).unwrap_or("holding steady");
    Some(RuleEvent {
        rule_id,
        priority: Priority::Info,
        template_key: "gap_ahead",
        params: TemplateParams::new()
            .set("gap", format!("{:.1}", gap))
            .set("trend", trend),
    })
}

fn gap_behind_event(rule_id: &'static str, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
    if current.in_pit { return None; }
    let gap = current.gap_behind?;
    let trend = prev.and_then(|p| p.gap_behind).map(|prev_gap| {
        let delta = gap - prev_gap;
        // Positive delta = car behind is falling further back
        if delta < -0.2 { "closing" } else if delta > 0.2 { "pulling away" } else { "holding steady" }
    }).unwrap_or("holding steady");
    Some(RuleEvent {
        rule_id,
        priority: Priority::Info,
        template_key: "gap_behind",
        params: TemplateParams::new()
            .set("gap", format!("{:.1}", gap))
            .set("trend", trend),
    })
}

impl Rule for GapAheadMediumRule {
    fn id(&self) -> &'static str { "gap_ahead_medium" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(150) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        gap_ahead_event(self.id(), current, prev)
    }
}

impl Rule for GapAheadHighRule {
    fn id(&self) -> &'static str { "gap_ahead_high" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        gap_ahead_event(self.id(), current, prev)
    }
}

impl Rule for GapBehindMediumRule {
    fn id(&self) -> &'static str { "gap_behind_medium" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(150) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        gap_behind_event(self.id(), current, prev)
    }
}

impl Rule for GapBehindHighRule {
    fn id(&self) -> &'static str { "gap_behind_high" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        gap_behind_event(self.id(), current, prev)
    }
}
