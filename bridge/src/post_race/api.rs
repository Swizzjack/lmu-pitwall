//! DB query functions for post-race WebSocket commands.
//!
//! Each public function maps to one [`ClientCommand`] variant and returns the
//! matching [`ServerMessage`] variant.  All functions are **synchronous** — they
//! must be called from inside `tokio::task::spawn_blocking`.

use anyhow::Result;
use rusqlite::Connection;

use crate::protocol::messages::{
    ClientCommand, PostRaceComparedLap, PostRaceDriverLapEntry, PostRaceDriverSummary,
    PostRaceLapData, PostRaceSessionMeta, PostRaceStintData, ServerMessage,
};

use super::database::get_db;

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/// Dispatch a [`ClientCommand`] to the appropriate query function.
///
/// Should be called from `tokio::task::spawn_blocking` — never from an async
/// context directly, as rusqlite is blocking.
pub fn handle_command(cmd: ClientCommand) -> ServerMessage {
    match cmd {
        ClientCommand::PostRaceInit => post_race_init(),
        ClientCommand::PostRaceSessionDetail { session_id } => post_race_session_detail(session_id),
        ClientCommand::PostRaceDriverLaps { driver_id } => post_race_driver_laps(driver_id),
        ClientCommand::PostRaceCompare { driver_ids } => post_race_compare(driver_ids),
        ClientCommand::PostRaceStintSummary { driver_id } => post_race_stint_summary(driver_id),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn db_error(msg: impl std::fmt::Display) -> ServerMessage {
    ServerMessage::PostRaceError {
        message: msg.to_string(),
    }
}

// ---------------------------------------------------------------------------
// 1. post_race_init
// ---------------------------------------------------------------------------

fn post_race_init() -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB init failed: {e}")),
    };

    let import_result = match db.ensure_initialized() {
        Ok(r) => r,
        Err(e) => return db_error(format!("Import failed: {e}")),
    };

    let conn = db.lock();
    match query_sessions(&conn) {
        Ok(sessions) => {
            let total = sessions.len();
            ServerMessage::PostRaceSessions {
                sessions,
                total_sessions: total,
                new_imported: import_result.new_imported,
                files_found: import_result.total_files,
                import_errors: import_result.errors.len(),
            }
        }
        Err(e) => db_error(format!("Session query failed: {e}")),
    }
}

fn query_sessions(conn: &Connection) -> Result<Vec<PostRaceSessionMeta>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.track_venue, s.track_course, s.track_event, s.date_time,
                s.session_type, s.game_version, s.race_laps,
                COUNT(DISTINCT d.id) AS driver_count,
                COUNT(l.id)          AS total_laps
         FROM sessions s
         LEFT JOIN drivers d ON d.session_id = s.id
         LEFT JOIN laps    l ON l.session_id = s.id
         GROUP BY s.id
         ORDER BY s.imported_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(PostRaceSessionMeta {
            id: row.get(0)?,
            track_venue: row.get(1)?,
            track_course: row.get(2)?,
            track_event: row.get(3)?,
            date_time: row.get(4)?,
            session_type: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            game_version: row.get(6)?,
            race_laps: row.get(7)?,
            driver_count: row.get(8)?,
            total_laps: row.get(9)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 2. post_race_session_detail
// ---------------------------------------------------------------------------

fn post_race_session_detail(session_id: i64) -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB unavailable: {e}")),
    };
    let conn = db.lock();
    match query_session_detail(&conn, session_id) {
        Ok(drivers) => ServerMessage::PostRaceSessionDetail {
            session_id,
            drivers,
        },
        Err(e) => db_error(format!("Session detail query failed: {e}")),
    }
}

fn query_session_detail(conn: &Connection, session_id: i64) -> Result<Vec<PostRaceDriverSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, car_type, car_class, car_number, team_name, is_player,
                position, class_position, best_lap_time, total_laps, pitstops, finish_status
         FROM drivers
         WHERE session_id = ?1
         ORDER BY position",
    )?;

    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(PostRaceDriverSummary {
            id: row.get(0)?,
            name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            car_type: row.get(2)?,
            car_class: row.get(3)?,
            car_number: row.get(4)?,
            team_name: row.get(5)?,
            is_player: row.get::<_, bool>(6)?,
            position: row.get(7)?,
            class_position: row.get(8)?,
            best_lap_time: row.get(9)?,
            total_laps: row.get(10)?,
            pitstops: row.get(11)?,
            finish_status: row.get(12)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 3. post_race_driver_laps
// ---------------------------------------------------------------------------

fn post_race_driver_laps(driver_id: i64) -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB unavailable: {e}")),
    };
    let conn = db.lock();
    match query_driver_laps(&conn, driver_id) {
        Ok(laps) => ServerMessage::PostRaceDriverLaps { driver_id, laps },
        Err(e) => db_error(format!("Driver laps query failed: {e}")),
    }
}

fn query_driver_laps(conn: &Connection, driver_id: i64) -> Result<Vec<PostRaceLapData>> {
    let mut stmt = conn.prepare(
        "SELECT lap_num, position, lap_time, s1, s2, s3, top_speed,
                fuel_level, fuel_used,
                tw_fl, tw_fr, tw_rl, tw_rr,
                compound_fl, compound_fr, compound_rl, compound_rr,
                is_pit, stint_number
         FROM laps
         WHERE driver_id = ?1
         ORDER BY lap_num",
    )?;

    let rows = stmt.query_map(rusqlite::params![driver_id], |row| {
        Ok(PostRaceLapData {
            lap_num: row.get::<_, u32>(0)?,
            position: row.get(1)?,
            lap_time: row.get(2)?,
            s1: row.get(3)?,
            s2: row.get(4)?,
            s3: row.get(5)?,
            top_speed: row.get(6)?,
            fuel_level: row.get(7)?,
            fuel_used: row.get(8)?,
            tw_fl: row.get(9)?,
            tw_fr: row.get(10)?,
            tw_rl: row.get(11)?,
            tw_rr: row.get(12)?,
            compound_fl: row.get(13)?,
            compound_fr: row.get(14)?,
            compound_rl: row.get(15)?,
            compound_rr: row.get(16)?,
            is_pit: row.get::<_, bool>(17)?,
            stint_number: row.get::<_, u32>(18)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

// ---------------------------------------------------------------------------
// 4. post_race_compare
// ---------------------------------------------------------------------------

fn post_race_compare(driver_ids: Vec<i64>) -> ServerMessage {
    if driver_ids.is_empty() {
        return ServerMessage::PostRaceCompare {
            reference_driver_id: 0,
            laps: vec![],
        };
    }

    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB unavailable: {e}")),
    };
    let conn = db.lock();

    // Load laps per driver (id, lap_num, lap_time, s1, s2, s3)
    struct RawLap {
        driver_id: i64,
        lap_num: u32,
        lap_time: Option<f64>,
        s1: Option<f64>,
        s2: Option<f64>,
        s3: Option<f64>,
    }

    let mut all_laps: Vec<RawLap> = Vec::new();

    let mut stmt = match conn.prepare(
        "SELECT lap_num, lap_time, s1, s2, s3
         FROM laps WHERE driver_id = ?1 ORDER BY lap_num",
    ) {
        Ok(s) => s,
        Err(e) => return db_error(format!("Compare prepare failed: {e}")),
    };

    for &did in &driver_ids {
        let rows = stmt.query_map(rusqlite::params![did], |row| {
            Ok(RawLap {
                driver_id: did,
                lap_num: row.get::<_, u32>(0)?,
                lap_time: row.get(1)?,
                s1: row.get(2)?,
                s2: row.get(3)?,
                s3: row.get(4)?,
            })
        });

        match rows {
            Ok(iter) => {
                for r in iter.flatten() {
                    all_laps.push(r);
                }
            }
            Err(e) => return db_error(format!("Compare query failed: {e}")),
        }
    }

    // Collect all unique lap numbers, sorted
    let mut lap_nums: Vec<u32> = all_laps.iter().map(|l| l.lap_num).collect();
    lap_nums.sort_unstable();
    lap_nums.dedup();

    let reference_driver_id = driver_ids[0];

    let compared_laps = lap_nums
        .into_iter()
        .map(|lap_num| {
            // Reference lap time (first driver)
            let ref_time: Option<f64> = all_laps
                .iter()
                .find(|l| l.driver_id == reference_driver_id && l.lap_num == lap_num)
                .and_then(|l| l.lap_time);

            let drivers = driver_ids
                .iter()
                .map(|&did| {
                    let lap = all_laps
                        .iter()
                        .find(|l| l.driver_id == did && l.lap_num == lap_num);
                    let lap_time = lap.and_then(|l| l.lap_time);
                    let delta = match (lap_time, ref_time) {
                        (Some(t), Some(r)) => Some(t - r),
                        _ => None,
                    };
                    PostRaceDriverLapEntry {
                        driver_id: did,
                        lap_time,
                        delta,
                        s1: lap.and_then(|l| l.s1),
                        s2: lap.and_then(|l| l.s2),
                        s3: lap.and_then(|l| l.s3),
                    }
                })
                .collect();

            PostRaceComparedLap { lap_num, drivers }
        })
        .collect();

    ServerMessage::PostRaceCompare {
        reference_driver_id,
        laps: compared_laps,
    }
}

// ---------------------------------------------------------------------------
// 5. post_race_stint_summary
// ---------------------------------------------------------------------------

fn post_race_stint_summary(driver_id: i64) -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB unavailable: {e}")),
    };
    let conn = db.lock();
    match query_stint_summary(&conn, driver_id) {
        Ok(stints) => ServerMessage::PostRaceStintSummary { driver_id, stints },
        Err(e) => db_error(format!("Stint summary query failed: {e}")),
    }
}

struct RawLapRow {
    stint_number: u32,
    lap_time: Option<f64>,
    fuel_level: Option<f64>,
    tw_fl: Option<f64>,
    tw_fr: Option<f64>,
    tw_rl: Option<f64>,
    tw_rr: Option<f64>,
    compound_fl: Option<String>,
}

fn query_stint_summary(conn: &Connection, driver_id: i64) -> Result<Vec<PostRaceStintData>> {
    let mut stmt = conn.prepare(
        "SELECT stint_number, lap_time, fuel_level,
                tw_fl, tw_fr, tw_rl, tw_rr, compound_fl
         FROM laps
         WHERE driver_id = ?1
         ORDER BY stint_number, lap_num",
    )?;

    let rows: Vec<RawLapRow> = stmt
        .query_map(rusqlite::params![driver_id], |row| {
            Ok(RawLapRow {
                stint_number: row.get::<_, u32>(0)?,
                lap_time: row.get(1)?,
                fuel_level: row.get(2)?,
                tw_fl: row.get(3)?,
                tw_fr: row.get(4)?,
                tw_rl: row.get(5)?,
                tw_rr: row.get(6)?,
                compound_fl: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Group by stint_number (rows are already sorted by stint then lap)
    let mut stints: Vec<PostRaceStintData> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let stint_num = rows[i].stint_number;
        let j = rows[i..]
            .iter()
            .position(|r| r.stint_number != stint_num)
            .map(|off| i + off)
            .unwrap_or(rows.len());

        let group = &rows[i..j];

        let valid_times: Vec<f64> = group.iter().filter_map(|r| r.lap_time).collect();
        let avg_pace = if valid_times.is_empty() {
            None
        } else {
            Some(valid_times.iter().sum::<f64>() / valid_times.len() as f64)
        };
        let best_lap = valid_times.iter().cloned().reduce(f64::min);
        let worst_lap = valid_times.iter().cloned().reduce(f64::max);

        let first = &group[0];
        let last = &group[group.len() - 1];

        let fuel_consumed = match (first.fuel_level, last.fuel_level) {
            (Some(s), Some(e)) => Some(s - e),
            _ => None,
        };

        stints.push(PostRaceStintData {
            stint_number: stint_num,
            lap_count: group.len(),
            avg_pace,
            best_lap,
            worst_lap,
            fuel_start: first.fuel_level,
            fuel_end: last.fuel_level,
            fuel_consumed,
            tw_fl_start: first.tw_fl,
            tw_fr_start: first.tw_fr,
            tw_rl_start: first.tw_rl,
            tw_rr_start: first.tw_rr,
            tw_fl_end: last.tw_fl,
            tw_fr_end: last.tw_fr,
            tw_rl_end: last.tw_rl,
            tw_rr_end: last.tw_rr,
            compound: first.compound_fl.clone(),
        });

        i = j;
    }

    Ok(stints)
}
