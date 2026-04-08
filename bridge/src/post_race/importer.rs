//! Import pipeline: scans the LMU results folder, parses new XML files,
//! and persists them to the SQLite database.
//!
//! Entry points: [`scan_results_folder`], [`import_new_sessions`]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use super::xml_parser::parse_result_xml;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ImportResult {
    pub total_files: usize,
    pub new_imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// 1. Folder scan
// ---------------------------------------------------------------------------

/// Returns the default LMU results folder:
/// `C:\Program Files (x86)\Steam\steamapps\common\Le Mans Ultimate\UserData\Log\Results\`
pub fn default_results_folder() -> Option<PathBuf> {
    Some(PathBuf::from(
        r"C:\Program Files (x86)\Steam\steamapps\common\Le Mans Ultimate\UserData\Log\Results",
    ))
}

/// Recursively scans `folder` for `.xml` files and returns their paths.
/// Returns an empty Vec if the folder does not exist or is unreadable.
pub fn scan_results_folder(folder: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    scan_recursive(folder, &mut result);
    result
}

fn scan_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            scan_recursive(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("xml") {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. File hashing
// ---------------------------------------------------------------------------

/// Computes the SHA-256 of the file at `path` and returns it as a lowercase hex string.
pub fn compute_file_hash(path: &Path) -> Result<String> {
    let bytes =
        std::fs::read(path).with_context(|| format!("Cannot read file: {}", path.display()))?;
    let digest = Sha256::digest(&bytes);
    Ok(hex::encode(digest))
}

/// Computes a per-session hash: SHA-256 of `file_content + session_type`.
/// This makes sessions from the same XML file uniquely addressable.
fn session_hash(file_bytes: &[u8], session_type: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file_bytes);
    hasher.update(session_type.as_bytes());
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// 3. Import pipeline
// ---------------------------------------------------------------------------

/// Scans `results_folder`, skips already-imported sessions (by per-session hash),
/// and inserts new sessions/drivers/laps inside a single transaction per file.
pub fn import_new_sessions(db: &mut Connection, results_folder: &Path) -> Result<ImportResult> {
    let xml_files = scan_results_folder(results_folder);
    let mut res = ImportResult {
        total_files: xml_files.len(),
        ..Default::default()
    };

    for path in &xml_files {
        let file_bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                res.errors
                    .push(format!("{}: read error — {}", path.display(), e));
                continue;
            }
        };

        let sessions = match parse_result_xml(path) {
            Ok(s) => s,
            Err(e) => {
                res.errors
                    .push(format!("{}: parse error — {}", path.display(), e));
                continue;
            }
        };

        // Each session from a file gets its own unique hash.
        let mut any_new = false;
        for session in &sessions {
            let hash = session_hash(&file_bytes, &session.session_type);
            let exists: bool = db
                .query_row(
                    "SELECT 1 FROM sessions WHERE file_hash = ?1",
                    rusqlite::params![hash],
                    |_| Ok(true),
                )
                .unwrap_or(false);

            if exists {
                res.skipped += 1;
                continue;
            }

            // Insert inside a savepoint so a single bad session doesn't abort the file.
            let sp = match db.savepoint() {
                Ok(sp) => sp,
                Err(e) => {
                    res.errors.push(format!(
                        "{} [{}]: savepoint error — {}",
                        path.display(),
                        session.session_type,
                        e
                    ));
                    continue;
                }
            };

            match insert_session(&sp, &hash, path, session) {
                Ok(()) => {
                    sp.commit().ok();
                    res.new_imported += 1;
                    any_new = true;
                }
                Err(e) => {
                    res.errors.push(format!(
                        "{} [{}]: insert error — {}",
                        path.display(),
                        session.session_type,
                        e
                    ));
                    // savepoint rolls back on drop
                }
            }
        }

        if !any_new && sessions.is_empty() {
            res.skipped += 1;
        }
    }

    Ok(res)
}

// ---------------------------------------------------------------------------
// 4. INSERT helpers
// ---------------------------------------------------------------------------

fn insert_session(
    conn: &Connection,
    hash: &str,
    path: &Path,
    session: &super::xml_parser::ParsedSession,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sessions (
            file_hash, file_path, track_venue, track_course, track_event,
            track_length, game_version, session_type, date_time,
            race_time, race_laps, fuel_mult, tire_mult
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            hash,
            path.to_string_lossy().as_ref(),
            session.track_venue,
            session.track_course,
            session.track_event,
            session.track_length,
            session.game_version,
            session.session_type,
            session.date_time,
            session.race_time,
            session.race_laps,
            session.fuel_mult,
            session.tire_mult,
        ],
    )
    .context("INSERT session")?;

    let session_id = conn.last_insert_rowid();

    for driver in &session.drivers {
        insert_driver(conn, session_id, driver)?;
    }

    insert_events(conn, session_id, &session.events)?;

    Ok(())
}

fn insert_driver(
    conn: &Connection,
    session_id: i64,
    driver: &super::xml_parser::ParsedDriver,
) -> Result<()> {
    conn.execute(
        "INSERT INTO drivers (
            session_id, name, car_type, car_class, car_number,
            team_name, is_player, position, class_position,
            best_lap_time, total_laps, pitstops, finish_status
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            session_id,
            driver.name,
            driver.car_type,
            driver.car_class,
            driver.car_number,
            driver.team_name,
            driver.is_player,
            driver.position,
            driver.class_position,
            driver.best_lap_time,
            driver.total_laps,
            driver.pitstops,
            driver.finish_status,
        ],
    )
    .context("INSERT driver")?;

    let driver_id = conn.last_insert_rowid();

    for lap in &driver.laps {
        insert_lap(conn, driver_id, session_id, lap)?;
    }

    Ok(())
}

fn insert_events(
    conn: &Connection,
    session_id: i64,
    events: &[super::xml_parser::ParsedEvent],
) -> Result<()> {
    for ev in events {
        conn.execute(
            "INSERT INTO events (
                session_id, event_type, elapsed_time,
                driver_name, driver_id_xml, target_name,
                severity, penalty_type, reason, served,
                warning_points, current_points, resolution, message
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            rusqlite::params![
                session_id,
                ev.event_type,
                ev.elapsed_time,
                ev.driver_name,
                ev.driver_id_xml,
                ev.target_name,
                ev.severity,
                ev.penalty_type,
                ev.reason,
                ev.served,
                ev.warning_points,
                ev.current_points,
                ev.resolution,
                ev.message,
            ],
        )
        .context("INSERT event")?;
    }
    Ok(())
}

fn insert_lap(
    conn: &Connection,
    driver_id: i64,
    session_id: i64,
    lap: &super::xml_parser::ParsedLap,
) -> Result<()> {
    conn.execute(
        "INSERT INTO laps (
            driver_id, session_id, lap_num, position, lap_time,
            s1, s2, s3, top_speed, fuel_level, fuel_used,
            tw_fl, tw_fr, tw_rl, tw_rr,
            compound_fl, compound_fr, compound_rl, compound_rr,
            is_pit, stint_number, elapsed_time
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
        rusqlite::params![
            driver_id,
            session_id,
            lap.lap_num,
            lap.position,
            lap.lap_time,
            lap.s1,
            lap.s2,
            lap.s3,
            lap.top_speed,
            lap.fuel_level,
            lap.fuel_used,
            lap.tw_fl,
            lap.tw_fr,
            lap.tw_rl,
            lap.tw_rr,
            lap.compound_fl,
            lap.compound_fr,
            lap.compound_rl,
            lap.compound_rr,
            lap.is_pit,
            lap.stint_number,
            lap.elapsed_time,
        ],
    )
    .context("INSERT lap")?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::post_race::database::init_database;

    const SAMPLE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rFactorXML>
  <RaceResults>
    <TrackVenue>Monza</TrackVenue>
    <TrackLength>5.793</TrackLength>
    <RaceLaps>3</RaceLaps>
    <FuelMult>1.0</FuelMult>
    <TireMult>1.0</TireMult>
    <Race>
      <Driver>
        <n>Test Driver</n>
        <isPlayer>1</isPlayer>
        <Position>1</Position>
        <BestLapTime>88.5</BestLapTime>
        <Laps>2</Laps>
        <Pitstops>0</Pitstops>
        <FinishStatus>Finished</FinishStatus>
        <Lap num="1" p="1" s1="28.0" s2="30.0" s3="30.5" fuel="40.0" fuelUsed="2.0" FL="0,Medium" FR="0,Medium" RL="0,Medium" RR="0,Medium">88.5</Lap>
        <Lap num="2" p="1" s1="28.5" s2="30.5" s3="31.0" fuel="38.0" fuelUsed="2.0">90.0</Lap>
      </Driver>
    </Race>
    <Qualify>
      <Driver>
        <n>Test Driver</n>
        <Position>1</Position>
        <BestLapTime>87.0</BestLapTime>
        <Laps>1</Laps>
        <Lap num="1" p="1">87.0</Lap>
      </Driver>
    </Qualify>
  </RaceResults>
</rFactorXML>"#;

    fn write_sample_xml(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, SAMPLE_XML).unwrap();
        path
    }

    #[test]
    fn scan_finds_xml_files() {
        let dir = std::env::temp_dir();
        let path = write_sample_xml("lmu_scan_test.xml");
        let found = scan_results_folder(&dir);
        assert!(found.iter().any(|p| p == &path));
    }

    #[test]
    fn hash_is_deterministic() {
        let path = write_sample_xml("lmu_hash_test.xml");
        let h1 = compute_file_hash(&path).unwrap();
        let h2 = compute_file_hash(&path).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // hex SHA-256
    }

    #[test]
    fn import_inserts_two_sessions() {
        let path = write_sample_xml("lmu_import_test.xml");
        let mut db = init_database(Path::new(":memory:")).unwrap();
        let folder = path.parent().unwrap();

        // We call import directly with the known folder
        let result = import_new_sessions(&mut db, folder).unwrap();
        assert!(result.new_imported >= 2, "Race + Qualify = 2 sessions");
        assert_eq!(result.errors, Vec::<String>::new());
    }

    #[test]
    fn import_is_idempotent() {
        let path = write_sample_xml("lmu_idem_test.xml");
        let mut db = init_database(Path::new(":memory:")).unwrap();
        let folder = path.parent().unwrap();

        let r1 = import_new_sessions(&mut db, folder).unwrap();
        let r2 = import_new_sessions(&mut db, folder).unwrap();
        assert!(r1.new_imported >= 1);
        assert_eq!(r2.new_imported, 0);
        assert!(r2.skipped >= r1.new_imported);
    }

    #[test]
    fn laps_and_drivers_persisted() {
        let path = write_sample_xml("lmu_laps_test.xml");
        let mut db = init_database(Path::new(":memory:")).unwrap();
        let folder = path.parent().unwrap();
        import_new_sessions(&mut db, folder).unwrap();

        let lap_count: i64 = db
            .query_row("SELECT COUNT(*) FROM laps", [], |r| r.get(0))
            .unwrap();
        // Race: 2 laps, Qualify: 1 lap
        assert!(lap_count >= 3);

        let driver_count: i64 = db
            .query_row("SELECT COUNT(*) FROM drivers", [], |r| r.get(0))
            .unwrap();
        assert!(driver_count >= 2);
    }
}
