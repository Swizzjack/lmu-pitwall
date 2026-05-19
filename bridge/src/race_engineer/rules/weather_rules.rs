use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use super::{FrequencyMask, Priority, Rule, RuleEvent, SessionMask, TemplateParams};
use crate::race_engineer::state::EngineerState;

pub struct RainStartingRule;
pub struct RainClearingRule;
pub struct TrackDryingRule;
pub struct RainEscalationRule;

pub struct AmbientTempChangeRule {
    baseline_bits: AtomicU32,
    initialized: AtomicBool,
}

pub struct TrackTempChangeRule {
    baseline_bits: AtomicU32,
    initialized: AtomicBool,
}

/// Warns once when a forecast node with significant rain chance is approximately
/// `window_seconds` away. Two instances cover the 10-min and 5-min windows.
pub struct RainForecastWarningRule {
    window_seconds: f32,
    rule_id: &'static str,
    template_key: &'static str,
}

impl AmbientTempChangeRule {
    pub fn new() -> Self {
        Self { baseline_bits: AtomicU32::new(0), initialized: AtomicBool::new(false) }
    }
}

impl TrackTempChangeRule {
    pub fn new() -> Self {
        Self { baseline_bits: AtomicU32::new(0), initialized: AtomicBool::new(false) }
    }
}

impl RainForecastWarningRule {
    pub fn ten_min() -> Self {
        Self { window_seconds: 600.0, rule_id: "rain_forecast_10min", template_key: "rain_forecast_10min" }
    }
    pub fn five_min() -> Self {
        Self { window_seconds: 300.0, rule_id: "rain_forecast_5min", template_key: "rain_forecast_5min" }
    }
}

const RAIN_THRESHOLD: f32 = 0.1;
const DRYING_ENTRY: f32 = 0.3;
const DRYING_EXIT: f32 = 0.05;
const RAIN_HEAVY_THRESHOLD: f32 = 0.5;
const TEMP_CHANGE_THRESHOLD_C: f32 = 2.0;
const FORECAST_RAIN_THRESHOLD: f32 = 0.3;
/// Fractions at which LMU places its five forecast nodes.
const NODE_FRACTIONS: [f32; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];
/// ±30 s tolerance window around the target warning time.
const FORECAST_TOLERANCE_S: f32 = 30.0;

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

impl Rule for RainEscalationRule {
    fn id(&self) -> &'static str { "rain_heavy" }
    fn priority(&self) -> Priority { Priority::High }
    fn cooldown(&self) -> Duration { Duration::from_secs(300) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, prev: Option<&EngineerState>) -> Option<RuleEvent> {
        let now = current.rain_intensity;
        let was = prev.map(|p| p.rain_intensity).unwrap_or(0.0);
        if now >= RAIN_HEAVY_THRESHOLD && was < RAIN_HEAVY_THRESHOLD {
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "rain_heavy",
                params: TemplateParams::new(),
            })
        } else {
            None
        }
    }
}

impl Rule for AmbientTempChangeRule {
    fn id(&self) -> &'static str { "ambient_temp_change" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(600) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if !self.initialized.load(Ordering::Relaxed) {
            self.baseline_bits.store(current.ambient_temp_c.to_bits(), Ordering::Relaxed);
            self.initialized.store(true, Ordering::Relaxed);
            return None;
        }
        let baseline = f32::from_bits(self.baseline_bits.load(Ordering::Relaxed));
        let delta = current.ambient_temp_c - baseline;
        if delta.abs() >= TEMP_CHANGE_THRESHOLD_C {
            self.baseline_bits.store(current.ambient_temp_c.to_bits(), Ordering::Relaxed);
            let direction = if delta > 0.0 { "up" } else { "down" };
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "ambient_temp_change",
                params: TemplateParams::new()
                    .set("temp", format!("{:.0}", current.ambient_temp_c))
                    .set("delta", format!("{:.0}", delta.abs()))
                    .set("direction", direction),
            })
        } else {
            None
        }
    }
}

impl Rule for TrackTempChangeRule {
    fn id(&self) -> &'static str { "track_temp_change" }
    fn priority(&self) -> Priority { Priority::Info }
    fn cooldown(&self) -> Duration { Duration::from_secs(600) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::MEDIUM_AND_UP }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        if !self.initialized.load(Ordering::Relaxed) {
            self.baseline_bits.store(current.track_temp_c.to_bits(), Ordering::Relaxed);
            self.initialized.store(true, Ordering::Relaxed);
            return None;
        }
        let baseline = f32::from_bits(self.baseline_bits.load(Ordering::Relaxed));
        let delta = current.track_temp_c - baseline;
        if delta.abs() >= TEMP_CHANGE_THRESHOLD_C {
            self.baseline_bits.store(current.track_temp_c.to_bits(), Ordering::Relaxed);
            let direction = if delta > 0.0 { "up" } else { "down" };
            Some(RuleEvent {
                rule_id: self.id(),
                priority: self.priority(),
                template_key: "track_temp_change",
                params: TemplateParams::new()
                    .set("temp", format!("{:.0}", current.track_temp_c))
                    .set("delta", format!("{:.0}", delta.abs()))
                    .set("direction", direction),
            })
        } else {
            None
        }
    }
}

impl Rule for RainForecastWarningRule {
    fn id(&self) -> &'static str { self.rule_id }
    fn priority(&self) -> Priority { Priority::High }
    // Cooldown slightly shorter than the gap between the two windows (300 s) so
    // the 5-min rule can still fire after the 10-min rule has already triggered.
    fn cooldown(&self) -> Duration { Duration::from_secs(240) }
    fn session_mask(&self) -> SessionMask { SessionMask::ALL }
    fn frequency_mask(&self) -> FrequencyMask { FrequencyMask::ALL }

    fn evaluate(&self, current: &EngineerState, _prev: Option<&EngineerState>) -> Option<RuleEvent> {
        // Skip if it is already raining — forecast warning is only useful while dry.
        if current.rain_intensity >= RAIN_THRESHOLD { return None; }

        let session_total_s = current.session_total_s;
        if session_total_s <= 0.0 { return None; }

        let time_remaining_s = current.time_remaining?.as_secs_f32();
        let current_session_s = session_total_s - time_remaining_s;

        for (i, &fraction) in NODE_FRACTIONS.iter().enumerate() {
            let node_time_s = fraction * session_total_s;
            let seconds_until = node_time_s - current_session_s;

            if seconds_until >= self.window_seconds - FORECAST_TOLERANCE_S
                && seconds_until <= self.window_seconds + FORECAST_TOLERANCE_S
            {
                if let Some(node) = current.weather_forecast.get(i) {
                    if node.rain_chance >= FORECAST_RAIN_THRESHOLD {
                        let minutes = ((seconds_until / 60.0).round() as u32).max(1);
                        return Some(RuleEvent {
                            rule_id: self.id(),
                            priority: self.priority(),
                            template_key: self.template_key,
                            params: TemplateParams::new()
                                .set("minutes", minutes.to_string())
                                .set("chance", format!("{:.0}", node.rain_chance * 100.0)),
                        });
                    }
                }
            }
        }
        None
    }
}
