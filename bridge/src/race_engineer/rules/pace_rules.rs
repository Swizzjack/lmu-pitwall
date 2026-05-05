use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct PersonalBestRule;
pub struct PaceDroppingRule;
pub struct SectorDeltaRule;
pub struct SessionBestOvertakenRule;
pub struct ClassAheadSlowerRule;
pub struct ClassAheadFasterRule;
pub struct ClassBehindFasterRule;
pub struct ClassBehindSlowerRule;
pub struct ClassBestLapRule;

/// True only on the tick where a new completed lap was appended to recent_lap_times.
/// Prevents mid-lap pace judgements — rules should judge pace when a lap is finished, not every 10 Hz tick.
fn lap_just_completed(current: &EngineerState, prev: &EngineerState) -> bool {
    current.recent_lap_times.back() != prev.recent_lap_times.back()
        || current.recent_lap_times.len() != prev.recent_lap_times.len()
}

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

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        // Only judge pace immediately after a lap completes, not mid-lap on every 10 Hz tick.
        if !lap_just_completed(current, prev) { return None; }

        let best = current.best_lap_time_personal?;
        let best_secs = best.as_secs_f64();

        // Suppress when a PB was just set this tick — PersonalBestRule handles the callout.
        if let Some(prev_best) = prev.best_lap_time_personal {
            if best < prev_best { return None; }
        }

        // Suppress when the most recently completed lap was near-PB (within 0.5%) —
        // the driver is clearly on pace, not dropping.
        if let Some(&last) = current.recent_lap_times.back() {
            if last.as_secs_f64() <= best_secs * 1.005 { return None; }
        }

        // Average of last 3 valid laps, ignoring outliers >10% slower than PB
        // (out-laps, yellow-laps, off-track incidents skew the window otherwise).
        let outlier_cutoff = best_secs * 1.10;
        let valid: Vec<f64> = current.recent_lap_times.iter().rev()
            .filter(|d| d.as_secs_f64() <= outlier_cutoff)
            .take(3)
            .map(|d| d.as_secs_f64())
            .collect();
        if valid.len() < 3 { return None; }
        let avg_secs: f64 = valid.iter().sum::<f64>() / 3.0;

        if avg_secs > best_secs * 1.02 {
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

impl Rule for ClassAheadSlowerRule {
    fn id(&self) -> &'static str { "class_ahead_slower" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if !lap_just_completed(current, prev) { return None; }
        let my_avg = recent_avg_secs(current, 3)?;
        let ahead = current.class_car_ahead_last_lap?.as_secs_f64();
        if my_avg < ahead * 0.99 {
            Some(RuleEvent { rule_id: self.id(), priority: self.priority(),
                template_key: "class_ahead_slower", params: TemplateParams::new() })
        } else { None }
    }
}

impl Rule for ClassAheadFasterRule {
    fn id(&self) -> &'static str { "class_ahead_faster" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if !lap_just_completed(current, prev) { return None; }
        let my_avg = recent_avg_secs(current, 3)?;
        let ahead = current.class_car_ahead_last_lap?.as_secs_f64();
        if my_avg > ahead * 1.01 {
            Some(RuleEvent { rule_id: self.id(), priority: self.priority(),
                template_key: "class_ahead_faster", params: TemplateParams::new() })
        } else { None }
    }
}

impl Rule for ClassBehindFasterRule {
    fn id(&self) -> &'static str { "class_behind_faster" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if !lap_just_completed(current, prev) { return None; }
        let my_avg = recent_avg_secs(current, 3)?;
        let behind = current.class_car_behind_last_lap?.as_secs_f64();
        if behind < my_avg * 0.99 {
            Some(RuleEvent { rule_id: self.id(), priority: self.priority(),
                template_key: "class_behind_faster", params: TemplateParams::new() })
        } else { None }
    }
}

impl Rule for ClassBehindSlowerRule {
    fn id(&self) -> &'static str { "class_behind_slower" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(120) }
    fn session_mask(&self) -> SessionMask { SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        if !lap_just_completed(current, prev) { return None; }
        let my_avg = recent_avg_secs(current, 3)?;
        let behind = current.class_car_behind_last_lap?.as_secs_f64();
        if behind > my_avg * 1.01 {
            Some(RuleEvent { rule_id: self.id(), priority: self.priority(),
                template_key: "class_behind_slower", params: TemplateParams::new() })
        } else { None }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Instant;
    use crate::race_engineer::state::{
        CarClass, DamageState, EngineerState, FlagState, PitState, SessionPhase, SessionType,
    };

    fn make_state(laps_secs: &[u64], best_secs: u64) -> EngineerState {
        let recent = laps_secs.iter().map(|&s| Duration::from_secs(s)).collect::<VecDeque<_>>();
        let last_lap = laps_secs.last().map(|&s| Duration::from_secs(s));
        EngineerState {
            tick_time: Instant::now(),
            session_type: SessionType::Practice,
            session_phase: SessionPhase::Green,
            time_remaining: None,
            laps_remaining: None,
            total_laps_driven: laps_secs.len() as u32,
            player_position: 1,
            player_class_position: 1,
            player_class: CarClass::Unknown,
            player_lap: laps_secs.len() as u32 + 1,
            in_pit: false,
            in_garage: false,
            pit_state: PitState::None,
            fuel_remaining_l: 50.0,
            fuel_laps_left: 10.0,
            ve_laps_left: f32::INFINITY,
            effective_laps_left: 10.0,
            last_lap_time: last_lap,
            best_lap_time_personal: Some(Duration::from_secs(best_secs)),
            best_lap_time_session: None,
            current_lap_time: Duration::ZERO,
            last_sector_deltas: [None; 3],
            recent_lap_times: recent,
            gap_ahead: None,
            gap_behind: None,
            active_flags: FlagState::default(),
            tire_temps_c: [80.0; 4],
            tire_wear_pct: [1.0; 4],
            damage: DamageState::default(),
            ambient_temp_c: 20.0,
            track_temp_c: 25.0,
            rain_intensity: 0.0,
            num_penalties: 0,
            class_rivals_avg_last_lap: None,
            class_rivals_min_best_lap: None,
            class_car_ahead_last_lap: None,
            class_car_behind_last_lap: None,
        }
    }

    /// Simulate a lap completion: prev has N laps, current has N+1 laps (new lap appended).
    fn with_new_lap(prev_laps: &[u64], new_lap: u64, best_secs: u64) -> (EngineerState, EngineerState) {
        let prev = make_state(prev_laps, best_secs);
        let mut new_laps = prev_laps.to_vec();
        new_laps.push(new_lap);
        let current = make_state(&new_laps, best_secs);
        (prev, current)
    }

    #[test]
    fn pb_lap_suppresses_pace_dropping() {
        // Last lap IS the PB — rule must stay silent
        let (prev, current) = with_new_lap(&[93, 92], 89, 89);
        // The new lap appended is 89 == PB
        assert!(PaceDroppingRule.evaluate(&current, Some(&prev)).is_none());
    }

    #[test]
    fn near_pb_lap_suppresses_pace_dropping() {
        // Last lap is 89.5s, PB is 89s — within 0.5% → suppress
        let prev = make_state(&[93, 92], 89);
        let mut current = make_state(&[93, 92, 89], 89); // 89s == best; let's use 89 (~0%)
        // Simulate "almost PB": set last lap to Duration::from_millis(89_400) < 89 * 1.005 = 89.445
        current.recent_lap_times.pop_back();
        current.recent_lap_times.push_back(Duration::from_millis(89_400));
        current.last_lap_time = Some(Duration::from_millis(89_400));
        assert!(PaceDroppingRule.evaluate(&current, Some(&prev)).is_none());
    }

    #[test]
    fn outlier_lap_filtered_prevents_false_positive() {
        // recent laps: [90, 150, 91] — 150s is an out-lap outlier (>89*1.10=97.9)
        // Without filter: avg = 110.3 > 89*1.02 = 90.78 → would fire. With filter: only 2 valid → skip.
        let (prev, current) = with_new_lap(&[90, 150], 91, 89);
        assert!(PaceDroppingRule.evaluate(&current, Some(&prev)).is_none());
    }

    #[test]
    fn genuine_pace_drop_fires() {
        // Three consistently slow laps, no outliers, last lap not near PB → must fire
        let (prev, current) = with_new_lap(&[93, 92], 94, 89);
        // avg of [93, 92, 94] = 93 > 89 * 1.02 = 90.78, last lap 94 > 89 * 1.005 = 89.445
        assert!(PaceDroppingRule.evaluate(&current, Some(&prev)).is_some());
    }

    #[test]
    fn mid_lap_does_not_fire() {
        // current and prev have the same recent_lap_times.back() → no lap completed → skip
        let state = make_state(&[93, 92, 94], 89);
        let prev = state.clone();
        assert!(PaceDroppingRule.evaluate(&state, Some(&prev)).is_none());
    }

    #[test]
    fn no_prev_does_not_fire() {
        let state = make_state(&[93, 92, 94], 89);
        assert!(PaceDroppingRule.evaluate(&state, None).is_none());
    }
}
