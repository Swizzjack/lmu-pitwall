use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct PersonalBestRule;
pub struct PaceDroppingRule;
pub struct SectorDeltaRule;
pub struct SessionBestOvertakenRule;
pub struct ClassPaceFasterRule;
pub struct ClassPaceSlowerRule;
pub struct ClassBestLapRule;

impl Rule for PersonalBestRule {
    fn id(&self) -> &'static str { "personal_best" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(10) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let current_best = current.best_lap_time_personal?;
        let prev_best = prev.and_then(|p| p.best_lap_time_personal);
        let is_new_pb = match prev_best {
            Some(pb) => current_best < pb,
            None => false, // Don't call out the very first timed lap
        };
        if is_new_pb {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "personal_best",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for PaceDroppingRule {
    fn id(&self) -> &'static str { "pace_dropping" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(60) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let best = current.best_lap_time_personal?;
        if current.recent_lap_times.len() < 3 { return None; }
        let avg_secs: f64 = current.recent_lap_times.iter().rev().take(3)
            .map(|d| d.as_secs_f64())
            .sum::<f64>() / 3.0;
        // Fire when average of last 3 laps is more than 2% slower than personal best
        if avg_secs > best.as_secs_f64() * 1.02 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "pace_dropping",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for SectorDeltaRule {
    fn id(&self) -> &'static str { "sector_delta" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(20) }
    fn session_mask(&self) -> SessionMask { SessionMask::QUALIFYING }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        for (i, (&curr_delta, &prev_delta)) in current.last_sector_deltas.iter()
            .zip(prev.last_sector_deltas.iter())
            .enumerate()
        {
            let curr_d = match curr_delta { Some(d) => d, None => continue };
            // Only fire when this delta just became available or changed substantially
            if let Some(pd) = prev_delta {
                if (curr_d - pd).abs() < 0.05 { continue; }
            }
            // Threshold: report deltas > 0.1s
            if curr_d.abs() < 0.1 { continue; }
            let direction = if curr_d < 0.0 { "up" } else { "down" };
            return Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "sector_delta",
                params: TemplateParams::new()
                    .set("sector", (i + 1).to_string())
                    .set("delta", format!("{:.2}", curr_d.abs()))
                    .set("direction", direction),
            });
        }
        None
    }
}

fn recent_avg_secs(state: &EngineerState, n: usize) -> Option<f64> {
    let count = state.recent_lap_times.len().min(n);
    if count < 2 { return None; }
    let sum: f64 = state.recent_lap_times.iter().rev().take(count)
        .map(|d| d.as_secs_f64())
        .sum();
    Some(sum / count as f64)
}

impl Rule for ClassPaceFasterRule {
    fn id(&self) -> &'static str { "class_pace_faster" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let my_avg = recent_avg_secs(current, 3)?;
        let rivals_avg = current.class_rivals_avg_last_lap?.as_secs_f64();
        if my_avg < rivals_avg * 0.99 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "class_pace_faster",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for ClassPaceSlowerRule {
    fn id(&self) -> &'static str { "class_pace_slower" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let my_avg = recent_avg_secs(current, 3)?;
        let rivals_avg = current.class_rivals_avg_last_lap?.as_secs_f64();
        if my_avg > rivals_avg * 1.02 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "class_pace_slower",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for ClassBestLapRule {
    fn id(&self) -> &'static str { "class_best_lap" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let my_pb = current.best_lap_time_personal?;
        let rivals_best = current.class_rivals_min_best_lap?;
        // Player must hold class fastest lap
        if my_pb >= rivals_best { return None; }
        // Only fire when the PB just improved this tick
        let prev_pb = prev.best_lap_time_personal.unwrap_or(Duration::MAX);
        if my_pb >= prev_pb { return None; }
        Some(RuleEvent {
            rule_id: self.id(),
            priority: self.priority(),
            template_key: "class_best_lap",
            params: TemplateParams::new(),
        })
    }
}

impl Rule for SessionBestOvertakenRule {
    fn id(&self) -> &'static str { "session_best_overtaken" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(30) }
    fn session_mask(&self) -> SessionMask { SessionMask::QUALIFYING }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::HIGH }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let session_best = current.best_lap_time_session?;
        let prev_session_best = prev.best_lap_time_session.unwrap_or(Duration::MAX);
        // Session best improved
        if session_best >= prev_session_best { return None; }
        // But not by the player (player's PB didn't improve this tick)
        let player_pb = current.best_lap_time_personal.unwrap_or(Duration::MAX);
        let prev_player_pb = prev.best_lap_time_personal.unwrap_or(Duration::MAX);
        if player_pb < prev_player_pb { return None; }
        Some(RuleEvent {
            rule_id: self.id(),
            priority: self.priority(),
            template_key: "session_best_overtaken",
            params: TemplateParams::new(),
        })
    }
}
