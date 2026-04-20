pub mod dispatcher;
pub mod templates;
pub mod flag_rules;
pub mod fuel_rules;
pub mod pit_rules;
pub mod damage_rules;
pub mod session_rules;
pub mod position_rules;
pub mod pace_rules;
pub mod tire_rules;
pub mod weather_rules;

use std::time::Duration;

use crate::race_engineer::state::EngineerState;

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    Info,
    High,
    Critical,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

// ---------------------------------------------------------------------------
// SessionMask / FrequencyMask
// ---------------------------------------------------------------------------

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SessionMask: u8 {
        const PRACTICE   = 0b001;
        const QUALIFYING = 0b010;
        const RACE       = 0b100;
        const ALL        = 0b111;
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct FrequencyMask: u8 {
        const LOW    = 0b001;
        const MEDIUM = 0b010;
        const HIGH   = 0b100;
        const MEDIUM_AND_UP = 0b110;
        const ALL    = 0b111;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrequencyLevel {
    Low,
    Medium,
    High,
}

impl FrequencyLevel {
    pub fn to_mask(self) -> FrequencyMask {
        match self {
            Self::Low => FrequencyMask::LOW,
            Self::Medium => FrequencyMask::MEDIUM,
            Self::High => FrequencyMask::HIGH,
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "low" => Self::Low,
            "high" => Self::High,
            _ => Self::Medium,
        }
    }
}

impl crate::race_engineer::state::SessionType {
    pub fn to_mask(self) -> SessionMask {
        match self {
            Self::Practice => SessionMask::PRACTICE,
            Self::Qualifying => SessionMask::QUALIFYING,
            Self::Race => SessionMask::RACE,
            Self::Unknown => SessionMask::empty(),
        }
    }
}

// ---------------------------------------------------------------------------
// TemplateParams
// ---------------------------------------------------------------------------

/// Key-value parameters for template rendering.
/// Allocated only when a rule actually fires, not on every tick.
#[derive(Debug, Default, Clone)]
pub struct TemplateParams {
    pairs: Vec<(&'static str, String)>,
}

impl TemplateParams {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(mut self, key: &'static str, value: impl Into<String>) -> Self {
        self.pairs.push((key, value.into()));
        self
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &str)> {
        self.pairs.iter().map(|(k, v)| (*k, v.as_str()))
    }
}

// ---------------------------------------------------------------------------
// RuleEvent
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RuleEvent {
    pub rule_id: &'static str,
    pub priority: Priority,
    pub template_key: &'static str,
    pub params: TemplateParams,
}

// ---------------------------------------------------------------------------
// Rule trait
// ---------------------------------------------------------------------------

pub trait Rule: Send + Sync {
    fn id(&self) -> &'static str;
    fn priority(&self) -> Priority;
    fn cooldown(&self) -> Duration;
    fn session_mask(&self) -> SessionMask;
    fn frequency_mask(&self) -> FrequencyMask;

    /// Called per 10 Hz tick when rule is not in cooldown, session matches,
    /// and frequency level matches. Return Some(event) to fire.
    fn evaluate(
        &self,
        current: &EngineerState,
        previous: Option<&EngineerState>,
    ) -> Option<RuleEvent>;
}
