//! Parser for rFactor2 / LMU result XML files.
//!
//! Entry point: [`parse_result_xml`]

use std::path::Path;

use anyhow::{Context, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

// ---------------------------------------------------------------------------
// Public structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ParsedLap {
    pub lap_num: u32,
    /// In-game position at end of lap
    pub position: Option<u32>,
    /// Lap time in seconds; None for invalid laps ("--.----")
    pub lap_time: Option<f64>,
    pub s1: Option<f64>,
    pub s2: Option<f64>,
    pub s3: Option<f64>,
    pub top_speed: Option<f64>,
    pub fuel_level: Option<f64>,
    pub fuel_used: Option<f64>,
    pub tw_fl: Option<f64>,
    pub tw_fr: Option<f64>,
    pub tw_rl: Option<f64>,
    pub tw_rr: Option<f64>,
    /// Parsed compound string, e.g. "Medium" (leading "0," stripped)
    pub compound_fl: Option<String>,
    pub compound_fr: Option<String>,
    pub compound_rl: Option<String>,
    pub compound_rr: Option<String>,
    pub is_pit: bool,
    /// Stint number (1-based). The lap containing the pit flag still belongs
    /// to the *current* stint; the next lap starts a new one.
    pub stint_number: u32,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedDriver {
    pub name: String,
    pub car_type: Option<String>,
    pub car_class: Option<String>,
    pub car_number: Option<u32>,
    pub team_name: Option<String>,
    pub is_player: bool,
    pub position: Option<u32>,
    pub class_position: Option<u32>,
    pub best_lap_time: Option<f64>,
    pub total_laps: Option<u32>,
    pub pitstops: Option<u32>,
    pub finish_status: Option<String>,
    pub laps: Vec<ParsedLap>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedSession {
    /// E.g. "Practice1", "Qualify", "Race"
    pub session_type: String,
    pub track_venue: Option<String>,
    pub track_course: Option<String>,
    pub track_event: Option<String>,
    pub track_length: Option<f64>,
    pub game_version: Option<String>,
    pub date_time: Option<String>,
    pub time_string: Option<String>,
    pub race_time: Option<u32>,
    pub race_laps: Option<u32>,
    pub fuel_mult: Option<f64>,
    pub tire_mult: Option<f64>,
    pub drivers: Vec<ParsedDriver>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_TAGS: &[&str] = &[
    "Practice1",
    "Practice2",
    "Practice3",
    "Qualify",
    "Warmup",
    "Race",
];

fn parse_lap_time(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed.starts_with("--") {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// "0,Medium" → "Medium"; anything without a comma is returned as-is.
fn parse_compound(s: &str) -> String {
    match s.find(',') {
        Some(idx) => s[idx + 1..].to_string(),
        None => s.to_string(),
    }
}

fn attr_str<'a>(
    attrs: &quick_xml::events::attributes::Attributes<'a>,
    name: &[u8],
) -> Option<String> {
    attrs
        .clone()
        .filter_map(|a| a.ok())
        .find(|a| a.key.as_ref() == name)
        .and_then(|a| String::from_utf8(a.value.as_ref().to_vec()).ok())
}

fn attr_f64(attrs: &quick_xml::events::attributes::Attributes<'_>, name: &[u8]) -> Option<f64> {
    attr_str(attrs, name).and_then(|s| s.trim().parse().ok())
}

fn attr_u32(attrs: &quick_xml::events::attributes::Attributes<'_>, name: &[u8]) -> Option<u32> {
    attr_str(attrs, name).and_then(|s| s.trim().parse().ok())
}

// ---------------------------------------------------------------------------
// Parser state machine
// ---------------------------------------------------------------------------

/// Parse *all* sessions contained in a single result XML file.
///
/// Missing or malformed fields are silently treated as `None`/default rather
/// than returning an error — the file may represent an aborted session.
pub fn parse_result_xml(path: &Path) -> Result<Vec<ParsedSession>> {
    let xml = std::fs::read_to_string(path)
        .with_context(|| format!("Cannot read XML file: {}", path.display()))?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);

    // Shared metadata found under <RaceResults> (before the first session tag)
    let mut shared_venue: Option<String> = None;
    let mut shared_course: Option<String> = None;
    let mut shared_event: Option<String> = None;
    let mut shared_length: Option<f64> = None;
    let mut shared_version: Option<String> = None;
    let mut shared_datetime: Option<String> = None;
    let mut shared_timestring: Option<String> = None;
    let mut shared_race_time: Option<u32> = None;
    let mut shared_race_laps: Option<u32> = None;
    let mut shared_fuel_mult: Option<f64> = None;
    let mut shared_tire_mult: Option<f64> = None;

    let mut sessions: Vec<ParsedSession> = Vec::new();

    // Mutable state during parsing
    let mut current_session: Option<ParsedSession> = None;
    let mut current_driver: Option<ParsedDriver> = None;
    let mut current_lap: Option<ParsedLap> = None;

    // Which tag we are currently collecting text for
    let mut collecting_tag: Option<String> = None;
    // Current stint counter per driver (reset when a new Driver block starts)
    let mut current_stint: u32 = 1;

    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = std::str::from_utf8(e.name().as_ref())
                    .unwrap_or("")
                    .to_string();

                if SESSION_TAGS.contains(&tag.as_str()) {
                    // Start a new session, seeded with shared metadata
                    let s = ParsedSession {
                        session_type: tag.clone(),
                        track_venue: shared_venue.clone(),
                        track_course: shared_course.clone(),
                        track_event: shared_event.clone(),
                        track_length: shared_length,
                        game_version: shared_version.clone(),
                        date_time: shared_datetime.clone(),
                        time_string: shared_timestring.clone(),
                        race_time: shared_race_time,
                        race_laps: shared_race_laps,
                        fuel_mult: shared_fuel_mult,
                        tire_mult: shared_tire_mult,
                        ..Default::default()
                    };
                    // Session-level metadata may be overridden inside the tag
                    // (some XML variants repeat them per session).
                    // We handle that via the same text-collection path below.
                    current_session = Some(s);
                } else if tag == "Driver" {
                    current_driver = Some(ParsedDriver::default());
                    current_stint = 1;
                } else if tag == "Lap" {
                    let attrs = e.attributes();
                    let num = attr_u32(&attrs, b"num").unwrap_or(0);
                    let pos = attr_u32(&attrs, b"p");
                    let s1 = attr_f64(&attrs, b"s1");
                    let s2 = attr_f64(&attrs, b"s2");
                    let s3 = attr_f64(&attrs, b"s3");
                    let top_speed = attr_f64(&attrs, b"topspeed");
                    let fuel_level = attr_f64(&attrs, b"fuel");
                    let fuel_used = attr_f64(&attrs, b"fuelUsed");
                    let tw_fl = attr_f64(&attrs, b"twfl");
                    let tw_fr = attr_f64(&attrs, b"twfr");
                    let tw_rl = attr_f64(&attrs, b"twrl");
                    let tw_rr = attr_f64(&attrs, b"twrr");
                    let compound_fl = attr_str(&attrs, b"FL").map(|s| parse_compound(&s));
                    let compound_fr = attr_str(&attrs, b"FR").map(|s| parse_compound(&s));
                    let compound_rl = attr_str(&attrs, b"RL").map(|s| parse_compound(&s));
                    let compound_rr = attr_str(&attrs, b"RR").map(|s| parse_compound(&s));
                    let is_pit = attr_str(&attrs, b"pit")
                        .map(|v| v.trim() == "1")
                        .unwrap_or(false);

                    current_lap = Some(ParsedLap {
                        lap_num: num,
                        position: pos,
                        s1,
                        s2,
                        s3,
                        top_speed,
                        fuel_level,
                        fuel_used,
                        tw_fl,
                        tw_fr,
                        tw_rl,
                        tw_rr,
                        compound_fl,
                        compound_fr,
                        compound_rl,
                        compound_rr,
                        is_pit,
                        stint_number: current_stint,
                        ..Default::default()
                    });
                    collecting_tag = Some("Lap".to_string());
                } else {
                    collecting_tag = Some(tag);
                }
            }

            Ok(Event::Empty(ref e)) => {
                // <Lap .../> self-closing — same attribute handling, no text content
                let tag = std::str::from_utf8(e.name().as_ref())
                    .unwrap_or("")
                    .to_string();
                if tag == "Lap" {
                    let attrs = e.attributes();
                    let num = attr_u32(&attrs, b"num").unwrap_or(0);
                    let pos = attr_u32(&attrs, b"p");
                    let s1 = attr_f64(&attrs, b"s1");
                    let s2 = attr_f64(&attrs, b"s2");
                    let s3 = attr_f64(&attrs, b"s3");
                    let top_speed = attr_f64(&attrs, b"topspeed");
                    let fuel_level = attr_f64(&attrs, b"fuel");
                    let fuel_used = attr_f64(&attrs, b"fuelUsed");
                    let tw_fl = attr_f64(&attrs, b"twfl");
                    let tw_fr = attr_f64(&attrs, b"twfr");
                    let tw_rl = attr_f64(&attrs, b"twrl");
                    let tw_rr = attr_f64(&attrs, b"twrr");
                    let compound_fl = attr_str(&attrs, b"FL").map(|s| parse_compound(&s));
                    let compound_fr = attr_str(&attrs, b"FR").map(|s| parse_compound(&s));
                    let compound_rl = attr_str(&attrs, b"RL").map(|s| parse_compound(&s));
                    let compound_rr = attr_str(&attrs, b"RR").map(|s| parse_compound(&s));
                    let is_pit = attr_str(&attrs, b"pit")
                        .map(|v| v.trim() == "1")
                        .unwrap_or(false);

                    let lap = ParsedLap {
                        lap_num: num,
                        position: pos,
                        lap_time: None, // no text content
                        s1,
                        s2,
                        s3,
                        top_speed,
                        fuel_level,
                        fuel_used,
                        tw_fl,
                        tw_fr,
                        tw_rl,
                        tw_rr,
                        compound_fl,
                        compound_fr,
                        compound_rl,
                        compound_rr,
                        is_pit,
                        stint_number: current_stint,
                    };
                    if is_pit {
                        current_stint += 1;
                    }
                    if let Some(d) = current_driver.as_mut() {
                        d.laps.push(lap);
                    }
                }
            }

            Ok(Event::Text(ref e)) => {
                if let Some(ref tag) = collecting_tag.clone() {
                    let text = e.unescape().unwrap_or_default().trim().to_string();
                    if text.is_empty() {
                        continue;
                    }

                    // Lap text content = lap time
                    if tag == "Lap" {
                        if let Some(lap) = current_lap.as_mut() {
                            lap.lap_time = parse_lap_time(&text);
                        }
                        continue;
                    }

                    // Driver fields
                    if let Some(d) = current_driver.as_mut() {
                        match tag.as_str() {
                            "Name" | "n" => d.name = text,
                            "CarType" => d.car_type = Some(text),
                            "CarClass" => d.car_class = Some(text),
                            "CarNumber" => d.car_number = text.parse().ok(),
                            "TeamName" => d.team_name = Some(text),
                            "isPlayer" => d.is_player = text.trim() == "1",
                            "Position" => d.position = text.parse().ok(),
                            "ClassPosition" => d.class_position = text.parse().ok(),
                            "BestLapTime" => d.best_lap_time = parse_lap_time(&text),
                            "Laps" => d.total_laps = text.parse().ok(),
                            "Pitstops" => d.pitstops = text.parse().ok(),
                            "FinishStatus" => d.finish_status = Some(text),
                            _ => {}
                        }
                        continue;
                    }

                    // Session / shared metadata fields
                    let target_session = current_session.as_mut();
                    match tag.as_str() {
                        "TrackVenue" => {
                            if let Some(s) = target_session {
                                s.track_venue = Some(text.clone());
                            }
                            shared_venue = Some(text);
                        }
                        "TrackCourse" => {
                            if let Some(s) = target_session {
                                s.track_course = Some(text.clone());
                            }
                            shared_course = Some(text);
                        }
                        "TrackEvent" => {
                            if let Some(s) = target_session {
                                s.track_event = Some(text.clone());
                            }
                            shared_event = Some(text);
                        }
                        "TrackLength" => {
                            let v: Option<f64> = text.parse().ok();
                            if let Some(s) = target_session {
                                s.track_length = v;
                            }
                            shared_length = v;
                        }
                        "GameVersion" => {
                            if let Some(s) = target_session {
                                s.game_version = Some(text.clone());
                            }
                            shared_version = Some(text);
                        }
                        "DateTime" => {
                            if let Some(s) = target_session {
                                s.date_time = Some(text.clone());
                            }
                            shared_datetime = Some(text);
                        }
                        "TimeString" => {
                            if let Some(s) = target_session {
                                s.time_string = Some(text.clone());
                            }
                            shared_timestring = Some(text);
                        }
                        "RaceTime" => {
                            let v: Option<u32> = text.parse().ok();
                            if let Some(s) = target_session {
                                s.race_time = v;
                            }
                            shared_race_time = v;
                        }
                        "RaceLaps" => {
                            let v: Option<u32> = text.parse().ok();
                            if let Some(s) = target_session {
                                s.race_laps = v;
                            }
                            shared_race_laps = v;
                        }
                        "FuelMult" => {
                            let v: Option<f64> = text.parse().ok();
                            if let Some(s) = target_session {
                                s.fuel_mult = v;
                            }
                            shared_fuel_mult = v;
                        }
                        "TireMult" => {
                            let v: Option<f64> = text.parse().ok();
                            if let Some(s) = target_session {
                                s.tire_mult = v;
                            }
                            shared_tire_mult = v;
                        }
                        _ => {}
                    }
                }
            }

            Ok(Event::End(ref e)) => {
                let tag = std::str::from_utf8(e.name().as_ref())
                    .unwrap_or("")
                    .to_string();

                if tag == "Lap" {
                    if let Some(lap) = current_lap.take() {
                        let pit = lap.is_pit;
                        if let Some(d) = current_driver.as_mut() {
                            d.laps.push(lap);
                        }
                        if pit {
                            current_stint += 1;
                        }
                    }
                    collecting_tag = None;
                } else if tag == "Driver" {
                    if let Some(driver) = current_driver.take() {
                        if let Some(s) = current_session.as_mut() {
                            s.drivers.push(driver);
                        }
                    }
                    collecting_tag = None;
                } else if SESSION_TAGS.contains(&tag.as_str()) {
                    if let Some(session) = current_session.take() {
                        sessions.push(session);
                    }
                    collecting_tag = None;
                } else {
                    collecting_tag = None;
                }
            }

            Ok(Event::Eof) => break,
            Err(_) => break, // treat malformed XML gracefully
            _ => {}
        }
        buf.clear();
    }

    Ok(sessions)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rFactorXML>
  <RaceResults>
    <TrackVenue>Spa-Francorchamps</TrackVenue>
    <TrackCourse>GP</TrackCourse>
    <TrackLength>7.004</TrackLength>
    <GameVersion>1.0.0</GameVersion>
    <RaceLaps>5</RaceLaps>
    <FuelMult>1.0</FuelMult>
    <TireMult>1.0</TireMult>
    <Race>
      <Driver>
        <n>Driver One</n>
        <CarClass>GTE</CarClass>
        <CarNumber>1</CarNumber>
        <isPlayer>1</isPlayer>
        <Position>1</Position>
        <ClassPosition>1</ClassPosition>
        <BestLapTime>95.432</BestLapTime>
        <Laps>3</Laps>
        <Pitstops>1</Pitstops>
        <FinishStatus>Finished</FinishStatus>
        <Lap num="1" p="2" s1="30.1" s2="32.2" s3="33.1" fuel="50.0" fuelUsed="2.5" twfl="0.01" twfr="0.01" twrl="0.008" twrr="0.009" FL="0,Medium" FR="0,Medium" RL="0,Medium" RR="0,Medium">95.432</Lap>
        <Lap num="2" p="1" s1="30.5" s2="32.0" s3="33.0" fuel="47.5" fuelUsed="2.5" pit="1" FL="0,Medium" FR="0,Medium" RL="0,Medium" RR="0,Medium">96.000</Lap>
        <Lap num="3" p="1" s1="31.0" s2="32.5" s3="33.5" fuel="60.0" fuelUsed="3.0" FL="1,Hard" FR="1,Hard" RL="1,Hard" RR="1,Hard">97.000</Lap>
      </Driver>
    </Race>
    <Qualify>
      <Driver>
        <n>Driver One</n>
        <Position>1</Position>
        <BestLapTime>94.100</BestLapTime>
        <Laps>2</Laps>
        <Lap num="1" p="1">--.----</Lap>
        <Lap num="2" p="1">94.100</Lap>
      </Driver>
    </Qualify>
  </RaceResults>
</rFactorXML>"#;

    fn parse_sample() -> Vec<ParsedSession> {
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(SAMPLE_XML.as_bytes()).unwrap();
        parse_result_xml(tmp.path()).unwrap()
    }

    // Helper: parse from string directly (avoids tempfile dep in unit tests)
    fn parse_str(xml: &str) -> Vec<ParsedSession> {
        use std::io::Write;
        let dir = std::env::temp_dir();
        let path = dir.join("lmu_pitwall_test.xml");
        std::fs::write(&path, xml).unwrap();
        parse_result_xml(&path).unwrap()
    }

    #[test]
    fn parses_two_sessions() {
        let sessions = parse_str(SAMPLE_XML);
        assert_eq!(sessions.len(), 2);
        let types: Vec<&str> = sessions.iter().map(|s| s.session_type.as_str()).collect();
        assert!(types.contains(&"Race"));
        assert!(types.contains(&"Qualify"));
    }

    #[test]
    fn shared_metadata_propagated() {
        let sessions = parse_str(SAMPLE_XML);
        for s in &sessions {
            assert_eq!(s.track_venue.as_deref(), Some("Spa-Francorchamps"));
            assert_eq!(s.track_length, Some(7.004));
            assert_eq!(s.race_laps, Some(5));
        }
    }

    #[test]
    fn driver_fields_parsed() {
        let sessions = parse_str(SAMPLE_XML);
        let race = sessions.iter().find(|s| s.session_type == "Race").unwrap();
        let driver = &race.drivers[0];
        assert_eq!(driver.name, "Driver One");
        assert!(driver.is_player);
        assert_eq!(driver.position, Some(1));
        assert_eq!(driver.car_class.as_deref(), Some("GTE"));
        assert_eq!(driver.best_lap_time, Some(95.432));
        assert_eq!(driver.total_laps, Some(3));
        assert_eq!(driver.pitstops, Some(1));
    }

    #[test]
    fn lap_times_parsed() {
        let sessions = parse_str(SAMPLE_XML);
        let race = sessions.iter().find(|s| s.session_type == "Race").unwrap();
        let laps = &race.drivers[0].laps;
        assert_eq!(laps[0].lap_time, Some(95.432));
        assert_eq!(laps[1].lap_time, Some(96.0));
    }

    #[test]
    fn invalid_lap_time_is_none() {
        let sessions = parse_str(SAMPLE_XML);
        let qual = sessions
            .iter()
            .find(|s| s.session_type == "Qualify")
            .unwrap();
        assert_eq!(qual.drivers[0].laps[0].lap_time, None);
        assert_eq!(qual.drivers[0].laps[1].lap_time, Some(94.1));
    }

    #[test]
    fn stint_numbers_correct() {
        let sessions = parse_str(SAMPLE_XML);
        let race = sessions.iter().find(|s| s.session_type == "Race").unwrap();
        let laps = &race.drivers[0].laps;
        // Lap 1: stint 1, Lap 2: stint 1 (pit lap), Lap 3: stint 2
        assert_eq!(laps[0].stint_number, 1);
        assert_eq!(laps[1].stint_number, 1);
        assert!(laps[1].is_pit);
        assert_eq!(laps[2].stint_number, 2);
    }

    #[test]
    fn compound_index_stripped() {
        let sessions = parse_str(SAMPLE_XML);
        let race = sessions.iter().find(|s| s.session_type == "Race").unwrap();
        let laps = &race.drivers[0].laps;
        assert_eq!(laps[0].compound_fl.as_deref(), Some("Medium"));
        assert_eq!(laps[2].compound_fl.as_deref(), Some("Hard"));
    }

    #[test]
    fn sector_and_fuel_attrs_parsed() {
        let sessions = parse_str(SAMPLE_XML);
        let race = sessions.iter().find(|s| s.session_type == "Race").unwrap();
        let lap = &race.drivers[0].laps[0];
        assert_eq!(lap.s1, Some(30.1));
        assert_eq!(lap.s2, Some(32.2));
        assert_eq!(lap.s3, Some(33.1));
        assert_eq!(lap.fuel_level, Some(50.0));
        assert_eq!(lap.fuel_used, Some(2.5));
    }
}
