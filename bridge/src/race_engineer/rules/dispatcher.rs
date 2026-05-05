use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::{FrequencyLevel, FrequencyMask, Priority, Rule, RuleEvent, SessionMask};
use crate::race_engineer::state::{EngineerState, SessionType};

use tracing::info;

// ---------------------------------------------------------------------------
// EngineerBehavior — user-controlled settings snapshot
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct EngineerBehavior {
    pub enabled: bool,
    pub frequency: FrequencyLevel,
    pub mute_in_qualifying: bool,
    /// When true and session = Practice: all rules run regardless of SessionMask
    pub debug_all_rules_in_practice: bool,
    /// Voice ID to use for rule-fired TTS synthesis. None = no synthesis.
    pub active_voice: Option<String>,
    /// Pilot name spoken in selected callouts. None or empty = no name used.
    pub pilot_name: Option<String>,
    /// When true the name is never injected, even if pilot_name is set.
    pub mute_name: bool,
}

impl Default for EngineerBehavior {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: FrequencyLevel::Medium,
            mute_in_qualifying: false,
            debug_all_rules_in_practice: false,
            active_voice: None,
            pilot_name: None,
            mute_name: false,
        }
    }
}

// ---------------------------------------------------------------------------
// RuleDispatcher
// ---------------------------------------------------------------------------

pub struct RuleDispatcher {
    rules: Vec<Box<dyn Rule>>,
    /// rule_id → last fired Instant (for per-rule cooldown)
    cooldowns: HashMap<&'static str, Instant>,
    /// Last time any non-Critical event was dispatched (global cooldown)
    last_non_critical_fire: Option<Instant>,
    pub behavior: EngineerBehavior,
}

/// Minimum gap between two non-Critical callouts (3 seconds).
const GLOBAL_COOLDOWN: Duration = Duration::from_secs(3);

impl RuleDispatcher {
    pub fn new(rules: Vec<Box<dyn Rule>>, behavior: EngineerBehavior) -> Self {
        Self {
            rules,
            cooldowns: HashMap::new(),
            last_non_critical_fire: None,
            behavior,
        }
    }

    /// Process one 10 Hz tick. Returns events sorted by priority (Critical first).
    pub fn tick(
        &mut self,
        current: &EngineerState,
        previous: Option<&EngineerState>,
    ) -> Vec<RuleEvent> {
        if !self.behavior.enabled {
            return Vec::new();
        }
        if self.behavior.mute_in_qualifying
            && current.session_type == SessionType::Qualifying
        {
            return Vec::new();
        }

        let effective_session_mask = if self.behavior.debug_all_rules_in_practice
            && current.session_type == SessionType::Practice
        {
            SessionMask::ALL
        } else {
            current.session_type.to_mask()
        };

        let freq_mask = self.behavior.frequency.to_mask();

        let now = Instant::now();
        let mut events: Option<Vec<RuleEvent>> = None;

        for rule in &self.rules {
            // Session filter
            if !rule.session_mask().intersects(effective_session_mask) {
                continue;
            }
            // Frequency filter
            if !rule.frequency_mask().contains(freq_mask) {
                continue;
            }
            // In garage stall: mute everything — the driver is not on track yet.
            if current.in_garage {
                continue;
            }
            // On pit lane: mute non-Critical only.
            if current.in_pit && rule.priority() != Priority::Critical {
                continue;
            }
            // Per-rule cooldown
            if let Some(&last_fired) = self.cooldowns.get(rule.id()) {
                if now.duration_since(last_fired) < rule.cooldown() {
                    continue;
                }
            }
            // Global cooldown (non-Critical only)
            if rule.priority() != Priority::Critical {
                if let Some(last_nc) = self.last_non_critical_fire {
                    if now.duration_since(last_nc) < GLOBAL_COOLDOWN {
                        continue;
                    }
                }
            }

            if let Some(event) = rule.evaluate(current, previous) {
                info!(
                    "Rule fired: {} priority={} template={}",
                    event.rule_id,
                    event.priority.as_str(),
                    event.template_key,
                );
                self.cooldowns.insert(rule.id(), now);
                if event.priority != Priority::Critical {
                    self.last_non_critical_fire = Some(now);
                }
                let evts = events.get_or_insert_with(Vec::new);
                evts.push(event);
            }
        }

        let mut events = events.unwrap_or_default();
        // Critical first, then High, then Info; within same priority: FIFO (stable sort)
        events.sort_by(|a, b| b.priority.cmp(&a.priority));
        events
    }

    /// Update behavior settings from a frontend command.
    pub fn update_behavior(&mut self, behavior: EngineerBehavior) {
        self.behavior = behavior;
    }
}

// ---------------------------------------------------------------------------
// Default rule set constructor
// ---------------------------------------------------------------------------

pub fn build_default_rules() -> Vec<Box<dyn Rule>> {
    use super::{
        flag_rules::*, fuel_rules::*, pit_rules::{PitWindowOpeningRule, DrivethroughPenaltyRule, DqWarningRule, PitlaneExitBriefingRule}, damage_rules::*,
        session_rules::{FiveMinutesRemainingRule, LastLapRule, RaceFinishedRule},
        position_rules::{PositionGainedRule, PositionLostRule, GapAheadMediumRule, GapAheadHighRule, GapBehindMediumRule, GapBehindHighRule},
        pace_rules::*, tire_rules::*,
        weather_rules::*,
    };

    vec![
        // Flags
        Box::new(RedFlagRule),
        Box::new(YellowFlagOwnSectorRule),
        Box::new(BlueFlagRule),
        Box::new(GreenFlagRule),

        // Fuel / VE
        Box::new(FuelCriticalRule),
        Box::new(FuelLowRule),
        Box::new(VeLowRule),

        // Pit
        Box::new(PitWindowOpeningRule),
        Box::new(DrivethroughPenaltyRule),
        Box::new(DqWarningRule),
        Box::new(PitlaneExitBriefingRule),

        // Damage
        Box::new(DamageReportedRule),

        // Session timing
        Box::new(FiveMinutesRemainingRule),
        Box::new(LastLapRule),
        Box::new(RaceFinishedRule),

        // Position / gaps
        Box::new(PositionGainedRule),
        Box::new(PositionLostRule),
        Box::new(GapAheadMediumRule),
        Box::new(GapAheadHighRule),
        Box::new(GapBehindMediumRule),
        Box::new(GapBehindHighRule),

        // Pace
        Box::new(PersonalBestRule),
        Box::new(PaceDroppingRule),
        Box::new(SectorDeltaRule),
        Box::new(SessionBestOvertakenRule),
        Box::new(ClassAheadSlowerRule),
        Box::new(ClassAheadFasterRule),
        Box::new(ClassBehindFasterRule),
        Box::new(ClassBehindSlowerRule),
        Box::new(ClassBestLapRule),

        // Tires
        Box::new(TireTempsOutOfRangeRule),
        Box::new(TireTempsInRangeRule),
        Box::new(TireWear50Rule),
        Box::new(TireWear75Rule),
        Box::new(TireWear90Rule),

        // Weather
        Box::new(RainStartingRule),
        Box::new(RainClearingRule),
        Box::new(TrackDryingRule),
        Box::new(RainEscalationRule),
        Box::new(AmbientTempChangeRule::new()),
        Box::new(TrackTempChangeRule::new()),
    ]
}
