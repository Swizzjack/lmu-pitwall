use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct TireTempsOutOfRangeRule;
pub struct TireTempsInRangeRule;
pub struct TireWear50Rule;
pub struct TireWear75Rule;
pub struct TireWear90Rule;

const TEMP_HOT: f32  = 105.0;
const TEMP_COLD: f32 = 70.0;

const WEAR_50: f32 = 0.50;
const WEAR_75: f32 = 0.75;
const WEAR_90: f32 = 0.90;

fn max_wear(wear: &[f32; 4]) -> f32 {
    wear.iter().copied().fold(0.0_f32, f32::max)
}

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

impl Rule for TireWear50Rule {
    fn id(&self) -> &'static str { "tire_wear_50" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let now = max_wear(&current.tire_wear_pct);
        let was = max_wear(&prev.tire_wear_pct);
        // Upward crossing into [50%, 75%) — don't double-fire if already past 75%
        if now >= WEAR_50 && now < WEAR_75 && was < WEAR_50 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "tire_wear_50",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for TireWear75Rule {
    fn id(&self) -> &'static str { "tire_wear_75" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let now = max_wear(&current.tire_wear_pct);
        let was = max_wear(&prev.tire_wear_pct);
        if now >= WEAR_75 && now < WEAR_90 && was < WEAR_75 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "tire_wear_75",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for TireWear90Rule {
    fn id(&self) -> &'static str { "tire_wear_90" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(60) }
    fn session_mask(&self) -> SessionMask { SessionMask::PRACTICE | SessionMask::RACE }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let prev = prev?;
        let now = max_wear(&current.tire_wear_pct);
        let was = max_wear(&prev.tire_wear_pct);
        if now >= WEAR_90 && was < WEAR_90 {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "tire_wear_90",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}
