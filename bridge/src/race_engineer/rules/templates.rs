use std::collections::HashMap;
use tracing::debug;
use super::TemplateParams;

pub struct TemplateRegistry {
    templates: HashMap<&'static str, &'static [&'static str]>,
}

impl TemplateRegistry {
    pub fn new() -> Self {
        let mut t: HashMap<&'static str, &'static [&'static str]> = HashMap::new();

        // Critical
        t.insert("red_flag", &[
            "Red flag, red flag. Session stopped.",
            "Red flag out. Slow down and await instructions.",
            "Red flag, bring it in safely.",
            "Red flag, {driver_name}. Slow down, session stopped.",
        ]);
        t.insert("fuel_critical_box", &[
            "Box this lap, box this lap. Fuel critical.",
            "You need to pit now. Box this lap.",
            "Box, box, box. Fuel is critical.",
            "Box this lap, {driver_name}. Fuel critical.",
        ]);
        t.insert("penalty_received", &[
            "That's a penalty. Serve when instructed.",
            "You've been given a penalty, stay calm and check the board.",
            "Penalty received. Serve it when you can.",
            "That's a penalty, {driver_name}. Serve it when instructed.",
        ]);
        t.insert("dq_warning", &[
            "Warning, track limits. One more and you're out.",
            "Track limits critical. No more mistakes.",
            "One more track limit and it's a DQ, focus.",
            "{driver_name}, one more track limit and you're out.",
        ]);

        // High
        t.insert("yellow_flag_sector", &[
            "Yellow flag in sector {sector}, take care.",
            "Yellows out, sector {sector}. Ease off.",
            "Yellow in {sector}, watch for incident.",
            "{driver_name}, yellows in sector {sector}. Ease off.",
        ]);
        t.insert("blue_flag", &[
            "Blue flag, faster car coming through.",
            "Blue flag behind, let them by when safe.",
            "Blue flags, there's a quicker car behind.",
            "{driver_name}, blue flag. Let them through.",
        ]);
        t.insert("damage_reported", &[
            "We've got some damage, take it easy.",
            "Damage on the car, try to bring it home.",
            "Something's broken, manage the car.",
            "Damage on the car, {driver_name}. Bring it home.",
        ]);
        t.insert("fuel_low", &[
            "Fuel's getting tight, {laps} laps left in the tank.",
            "We're on {laps} laps of fuel, start thinking pit.",
            "Fuel low, {laps} to go. Pit window is opening.",
            "Fuel's tight, {driver_name}. {laps} laps left.",
        ]);
        t.insert("ve_low", &[
            "Battery's getting low, {laps} laps of energy left.",
            "VE is tight, {laps} laps before we run dry.",
            "Energy low, {laps} laps. Watch your deployment.",
            "{driver_name}, battery's tight. {laps} laps of energy left.",
        ]);
        t.insert("pit_window_open", &[
            "Pit window's opening, {laps} laps till optimal.",
            "Start thinking about strategy, pit window is live.",
            "We're in the pit window now, plan your stop.",
            "Pit window's open, {driver_name}. Plan your stop.",
        ]);
        t.insert("last_lap", &[
            "Last lap, last lap. Bring it home.",
            "Final lap, stay clean.",
            "This is the last one, give it everything.",
            "Last lap, {driver_name}. Bring it home.",
        ]);
        t.insert("five_minutes_remaining", &[
            "Five minutes to go.",
            "Five minutes remaining, keep pushing.",
            "Five to go, stay focused.",
            "Five to go, {driver_name}. Stay focused.",
        ]);
        t.insert("race_finished", &[
            "Chequered flag. Well done, bring it home safely.",
            "That's it, race finished. Great drive today.",
            "Brilliant effort. Race over.",
            "And that's the chequered flag. Well done.",
            "Race over, {driver_name}. Fantastic effort today.",
            "Job done. Well driven.",
        ]);
        t.insert("rain_starting", &[
            "Rain's starting to come down, careful.",
            "We've got rain, conditions changing.",
            "Rain incoming, watch the grip.",
            "{driver_name}, rain's coming. Watch the grip.",
        ]);
        t.insert("rain_clearing", &[
            "Rain's easing off now.",
            "Conditions improving, rain clearing.",
            "Rain is backing off, track should recover.",
            "{driver_name}, rain's clearing. Track coming back.",
        ]);

        // Info
        t.insert("gap_ahead", &[
            "Gap to car ahead is {gap} seconds.",
            "Car ahead is {gap} seconds up the road.",
            "{gap} to the guy in front, {trend}.",
            "{driver_name}, car ahead is {gap} seconds. {trend}.",
        ]);
        t.insert("gap_behind", &[
            "Car behind is {gap} seconds back.",
            "{gap} seconds to the car behind you.",
            "Gap behind is {gap}, {trend}.",
            "{driver_name}, car behind is {gap} seconds. {trend}.",
        ]);
        t.insert("position_gained", &[
            "Nice move, P{position} now.",
            "You're up to P{position}, keep pushing.",
            "P{position}, well done.",
            "Nice move {driver_name}, P{position} now.",
        ]);
        t.insert("position_lost", &[
            "Lost a spot, P{position} now.",
            "You're down to P{position}, recover when you can.",
            "P{position} now, stay calm.",
            "P{position} now, {driver_name}. Stay calm.",
        ]);
        t.insert("personal_best", &[
            "Personal best, nicely done.",
            "That's a PB, keep it up.",
            "Fastest lap of your stint, good work.",
            "PB, {driver_name}. Keep it up.",
        ]);
        t.insert("pace_dropping", &[
            "Pace is dropping, focus on the lines.",
            "Lap times slipping, pick it back up.",
            "We're off pace, find some time.",
            "Pace is dropping, {driver_name}. Find some time.",
        ]);
        t.insert("sector_delta", &[
            "Sector {sector}, {delta} {direction}.",
            "{direction} {delta} in sector {sector}.",
            "Sector {sector} is {delta} {direction} vs your best.",
            "{driver_name}, sector {sector} is {delta} {direction}.",
        ]);
        t.insert("session_best_overtaken", &[
            "Someone's gone faster, session best is beaten.",
            "New session best, not yours.",
            "You've lost pole, someone went quicker.",
            "{driver_name}, session best is gone. Someone went quicker.",
        ]);
        t.insert("class_ahead_slower", &[
            "Driver ahead is running a bit slower. Good pace, keep pushing.",
            "You're gaining on the car ahead. Nice lap times.",
            "Car ahead is dropping off slightly. Good pace.",
            "{driver_name}, driver ahead is a bit slower. Good pace.",
        ]);
        t.insert("class_ahead_faster", &[
            "Driver ahead is pulling away. Push on if you can.",
            "Car ahead has stronger pace right now. Find some time.",
            "You're losing ground to the car ahead. Push harder.",
            "{driver_name}, driver ahead is faster. Push on.",
        ]);
        t.insert("class_behind_faster", &[
            "Driver behind is running faster. Push on if you can.",
            "Car behind is closing up. Lift the pace if possible.",
            "Faster car approaching from behind. Push a little.",
            "{driver_name}, car behind is faster. Push if you can.",
        ]);
        t.insert("class_behind_slower", &[
            "Good gap to the car behind. Maintain your pace.",
            "Driver behind is dropping off. You're pulling away nicely.",
            "Car behind is losing pace. Good work, keep it up.",
            "{driver_name}, you're pulling away from the car behind. Good pace.",
        ]);
        t.insert("class_best_lap", &[
            "That's the fastest lap in your class, well done.",
            "Class fastest lap is yours now, nice work.",
            "You've got the best lap in your class.",
            "{driver_name}, class fastest lap. Nice work.",
        ]);

        t.insert("tire_temps_warning", &[
            "Tires are too cold, manage them.",
            "Tire temps too cold, watch your pace.",
            "Tires aren't in the window yet, work them.",
            "Tire temps low, find some heat.",
            "{driver_name}, your tires are still cold.",
        ]);
        t.insert("tire_temps_ok", &[
            "Tires are back in the window.",
            "Tire temps back in range, good.",
            "Temps are looking good now, tires in the window.",
            "{driver_name}, tires are back in range.",
        ]);
        t.insert("tire_temps_hot_warning", &[
            "Tires are too hot, manage them.",
            "Tire temps too high, ease the pace.",
            "We've got hot tires, watch your style.",
            "{driver_name}, tires are overheating.",
        ]);
        t.insert("tire_wear_50", &[
            "Tires at fifty percent, halfway through this set.",
            "Half wear on the tires, plenty of life left.",
            "Tires at fifty, manage them from here.",
            "{driver_name}, tires at half life. Manage them.",
        ]);
        t.insert("tire_wear_75", &[
            "Tires at seventy-five percent, start thinking strategy.",
            "Three quarters worn, pit window approaching.",
            "Tires past seventy-five, plan the stop.",
            "{driver_name}, tires at seventy-five. Pit window opening.",
        ]);
        t.insert("tire_wear_90", &[
            "Tires at ninety percent, you need to box soon.",
            "Tires nearly done, get to pit lane.",
            "Tires shot, box this lap.",
            "{driver_name}, tires done. Box this lap.",
        ]);
        t.insert("green_flag", &[
            "Green flag, back to racing.",
            "Track's clear, green green green.",
            "All clear, push on.",
            "{driver_name}, green flag. Push on.",
        ]);
        t.insert("track_drying", &[
            "Track's drying out, grip is coming back.",
            "Drying line forming, watch for it.",
            "Track's improving, drier every lap.",
            "{driver_name}, track's drying. Grip is coming back.",
        ]);
        t.insert("rain_heavy", &[
            "Heavy rain now, take it easy.",
            "Rain's getting heavy, big drop in grip.",
            "It's coming down hard, watch yourself.",
            "{driver_name}, heavy rain. Watch the grip.",
        ]);
        t.insert("ambient_temp_change", &[
            "Air temp {direction} {delta} degrees, now {temp}.",
            "Temperature {direction} {delta}, sitting at {temp} now.",
            "Ambient's shifted {direction} {delta} degrees. Currently {temp}.",
            "{driver_name}, air temp {direction} {delta} degrees. Now at {temp}.",
        ]);
        t.insert("track_temp_change", &[
            "Track temp {direction} {delta} degrees, now {temp}.",
            "Track temperature {direction} {delta}, now {temp}. Tire window may shift.",
            "Track's {delta} degrees {direction}, sitting at {temp} now.",
            "{driver_name}, track temp {direction} {delta} degrees. Now {temp}.",
        ]);
        t.insert("pitlane_exit_briefing", &[
            "Track {condition}, {temp} degrees. Tires are {tire_status}.",
            "Out of the pits. Track is {condition}, {temp} ambient. Tires {tire_status}.",
            "Conditions {condition}, {temp} degrees. Tires {tire_status}.",
            "{driver_name}, out of the pits. Track {condition}, {temp} degrees. Tires {tire_status}.",
        ]);

        Self { templates: t }
    }

    /// Pick a random variant for key and substitute {placeholder} values.
    /// Variants containing a placeholder absent from params are excluded,
    /// so {driver_name} variants only appear when a name is provided.
    pub fn render(&self, key: &str, params: &TemplateParams) -> Option<String> {
        let variants = self.templates.get(key)?;
        if variants.is_empty() {
            return None;
        }

        let with_driver_name = variants.iter().filter(|v| v.contains("{driver_name}")).count();
        let has_pilot = params.get("driver_name").is_some();

        let available: Vec<&str> = variants.iter().copied()
            .filter(|v| Self::placeholders_satisfied(v, params))
            .collect();
        let pool: Vec<&str> = if available.is_empty() {
            variants.iter().copied().collect()
        } else {
            available
        };

        let idx = rand::random::<usize>() % pool.len();
        let template = pool[idx];

        let mut result = template.to_string();
        for (k, value) in params.iter() {
            result = result.replace(&format!("{{{k}}}"), value);
        }

        debug!(
            "Template render: key={key}, total_variants={}, with_driver_name={with_driver_name}, \
             has_pilot={has_pilot}, chosen_index={idx}, final_text={result}",
            variants.len()
        );

        Some(result)
    }

    fn placeholders_satisfied(template: &str, params: &TemplateParams) -> bool {
        let mut s = template;
        while let Some(start) = s.find('{') {
            s = &s[start + 1..];
            if let Some(end) = s.find('}') {
                if params.get(&s[..end]).is_none() {
                    return false;
                }
                s = &s[end + 1..];
            }
        }
        true
    }
}
