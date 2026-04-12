//! DB query functions for post-race WebSocket commands.
//!
//! Each public function maps to one [`ClientCommand`] variant and returns the
//! matching [`ServerMessage`] variant.  All functions are **synchronous** — they
//! must be called from inside `tokio::task::spawn_blocking`.

use anyhow::Result;
use rusqlite::Connection;

use crate::protocol::messages::{
    ClientCommand, PostRaceComparedLap, PostRaceDriverEventSummary, PostRaceDriverLapEntry,
    PostRaceDriverSummary, PostRaceEvent, PostRaceEventsSummary, PostRaceLapData,
    PostRaceSessionMeta, PostRaceStintData, ServerMessage,
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
        ClientCommand::PostRaceInit { results_path } => post_race_init(results_path.as_deref()),
        ClientCommand::PostRaceSessionDetail { session_id } => post_race_session_detail(session_id),
        ClientCommand::PostRaceDriverLaps { driver_id } => post_race_driver_laps(driver_id),
        ClientCommand::PostRaceCompare { driver_ids } => post_race_compare(driver_ids),
        ClientCommand::PostRaceStintSummary { driver_id } => post_race_stint_summary(driver_id),
        ClientCommand::PostRaceEvents { session_id } => post_race_events(session_id),
        ClientCommand::PostRaceFunFacts => post_race_fun_facts(),
        // Fuel-calculator commands are dispatched in websocket::server before reaching here.
        _ => ServerMessage::PostRaceError {
            message: "Command not handled by post_race module".to_string(),
        },
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

fn post_race_init(results_path: Option<&str>) -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB init failed: {e}")),
    };

    let custom_path = results_path
        .filter(|s| !s.trim().is_empty())
        .map(std::path::Path::new);

    let import_result = match db.ensure_initialized(custom_path) {
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
        Ok((drivers, has_events)) => ServerMessage::PostRaceSessionDetail {
            session_id,
            drivers,
            has_events,
        },
        Err(e) => db_error(format!("Session detail query failed: {e}")),
    }
}

fn query_session_detail(
    conn: &Connection,
    session_id: i64,
) -> Result<(Vec<PostRaceDriverSummary>, bool)> {
    // Determine session type to pick the right gap strategy.
    let session_type: String = conn.query_row(
        "SELECT COALESCE(session_type, '') FROM sessions WHERE id = ?1",
        rusqlite::params![session_id],
        |row| row.get(0),
    )?;
    let is_race = session_type.contains("Race");

    // Fetch driver base data.
    let mut stmt = conn.prepare(
        "SELECT id, name, car_type, car_class, car_number, team_name, is_player,
                position, class_position, best_lap_time, total_laps, pitstops, finish_status,
                finish_time
         FROM drivers
         WHERE session_id = ?1
         ORDER BY position",
    )?;

    struct DriverRow {
        summary: PostRaceDriverSummary,
        finish_time: Option<f64>,
    }

    let driver_rows: Vec<DriverRow> = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(DriverRow {
                summary: PostRaceDriverSummary {
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
                    gap_to_leader: None,
                    laps_behind: None,
                },
                finish_time: row.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut drivers: Vec<PostRaceDriverSummary> = driver_rows.iter().map(|r| r.summary.clone()).collect();

    if is_race {
        // Build finish_time map: driver_id → finish_time
        let finish_times: std::collections::HashMap<i64, f64> = driver_rows
            .iter()
            .filter_map(|r| r.finish_time.map(|ft| (r.summary.id, ft)))
            .collect();
        compute_race_gaps(conn, session_id, &mut drivers, &finish_times)?;
    } else {
        compute_quali_gaps(&mut drivers);
    }

    let has_events: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE session_id = ?1)",
        rusqlite::params![session_id],
        |row| row.get(0),
    )?;

    Ok((drivers, has_events))
}

/// Qualifying/Practice gap: difference in best_lap_time vs. leader.
fn compute_quali_gaps(drivers: &mut Vec<PostRaceDriverSummary>) {
    let leader_best = drivers
        .iter()
        .find(|d| d.position == Some(1))
        .and_then(|d| d.best_lap_time);

    let Some(leader_best) = leader_best else { return };

    for driver in drivers.iter_mut() {
        if driver.position == Some(1) {
            continue;
        }
        // None best_lap_time → gap stays None (rendered as "–" / "NO TIME")
        driver.gap_to_leader = driver.best_lap_time.map(|bt| bt - leader_best);
    }
}

/// Race gap: uses finish_time when available; falls back to elapsed_time-based logic.
/// Drivers that are laps down get `laps_behind` set instead of a time gap.
fn compute_race_gaps(
    conn: &Connection,
    session_id: i64,
    drivers: &mut Vec<PostRaceDriverSummary>,
    finish_times: &std::collections::HashMap<i64, f64>,
) -> Result<()> {
    let leader_id = match drivers.iter().find(|d| d.position == Some(1)) {
        Some(l) => l.id,
        None => return Ok(()),
    };

    // --- finish_time path ---
    if let Some(&leader_ft) = finish_times.get(&leader_id) {
        let leader_laps = drivers
            .iter()
            .find(|d| d.id == leader_id)
            .and_then(|d| d.total_laps);

        for driver in drivers.iter_mut() {
            if driver.position == Some(1) {
                continue;
            }
            let laps_diff = match (leader_laps, driver.total_laps) {
                (Some(ll), Some(dl)) if ll > dl => Some((ll as i64 - dl as i64) as i32),
                _ => None,
            };
            if let Some(diff) = laps_diff {
                driver.laps_behind = Some(diff);
                // No time gap for lap-down drivers.
            } else if let Some(&driver_ft) = finish_times.get(&driver.id) {
                driver.gap_to_leader = Some(driver_ft - leader_ft);
            }
            // If finish_time missing for this specific driver, gap stays None.
        }
        return Ok(());
    }

    // --- Fallback: elapsed_time-based logic ---
    let mut et_stmt = conn.prepare(
        "SELECT l.driver_id, l.lap_num, l.elapsed_time
         FROM laps l
         INNER JOIN (
             SELECT driver_id, MAX(lap_num) AS max_lap
             FROM laps
             WHERE session_id = ?1 AND elapsed_time IS NOT NULL
             GROUP BY driver_id
         ) mx ON l.driver_id = mx.driver_id AND l.lap_num = mx.max_lap
         WHERE l.session_id = ?1 AND l.elapsed_time IS NOT NULL",
    )?;

    let et_map: std::collections::HashMap<i64, (u32, f64)> = et_stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .map(|(did, lap, et)| (did, (lap, et)))
        .collect();

    let (leader_last_lap, leader_et_final) = match et_map.get(&leader_id) {
        Some(&v) => v,
        None => return Ok(()),
    };

    let mut leader_et_by_lap: std::collections::HashMap<u32, f64> = std::collections::HashMap::new();
    {
        let mut lap_stmt = conn.prepare(
            "SELECT lap_num, elapsed_time FROM laps
             WHERE driver_id = ?1 AND elapsed_time IS NOT NULL
             ORDER BY lap_num",
        )?;
        for row in lap_stmt
            .query_map(rusqlite::params![leader_id], |row| {
                Ok((row.get::<_, u32>(0)?, row.get::<_, f64>(1)?))
            })?
            .flatten()
        {
            leader_et_by_lap.insert(row.0, row.1);
        }
    }

    for driver in drivers.iter_mut() {
        if driver.position == Some(1) {
            continue;
        }
        let Some(&(driver_last_lap, driver_et)) = et_map.get(&driver.id) else {
            continue;
        };

        let laps_diff = leader_last_lap as i64 - driver_last_lap as i64;
        if laps_diff > 0 {
            driver.laps_behind = Some(laps_diff as i32);
            if let Some(&leader_et_at_lap) = leader_et_by_lap.get(&driver_last_lap) {
                let gap = driver_et - leader_et_at_lap;
                driver.gap_to_leader = Some(gap.abs());
            }
        } else {
            let gap = driver_et - leader_et_final;
            driver.gap_to_leader = Some(gap.abs());
        }
    }

    Ok(())
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
    // Fetch lap data including elapsed_time for incident mapping.
    struct LapRow {
        data: PostRaceLapData,
        elapsed_time: Option<f64>,
    }

    let mut stmt = conn.prepare(
        "SELECT lap_num, position, lap_time, s1, s2, s3, top_speed,
                fuel_level, fuel_used,
                tw_fl, tw_fr, tw_rl, tw_rr,
                compound_fl, compound_fr, compound_rl, compound_rr,
                is_pit, stint_number, elapsed_time,
                ve_level, ve_used
         FROM laps
         WHERE driver_id = ?1
         ORDER BY lap_num",
    )?;

    let mut laps: Vec<LapRow> = stmt
        .query_map(rusqlite::params![driver_id], |row| {
            Ok(LapRow {
                data: PostRaceLapData {
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
                    ve_level: row.get(20)?,
                    ve_used: row.get(21)?,
                    incidents: vec![],
                },
                elapsed_time: row.get(19)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Fetch incidents for this driver via session + driver name join.
    let incidents = query_driver_incidents(conn, driver_id)?;

    // Map each incident to a lap by elapsed_time range.
    // Lap N covers (et[N-1], et[N]] where et[0] = 0.0.
    for incident in incidents {
        let et = incident.elapsed_time;
        // Find the lap whose elapsed_time is the smallest value >= incident et.
        let idx = laps.iter().position(|l| {
            l.elapsed_time.map(|lap_et| lap_et >= et).unwrap_or(false)
        });
        if let Some(i) = idx {
            laps[i].data.incidents.push(incident);
        }
    }

    Ok(laps.into_iter().map(|l| l.data).collect())
}

fn query_driver_incidents(conn: &Connection, driver_id: i64) -> Result<Vec<PostRaceEvent>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.event_type, e.elapsed_time, e.driver_name, e.target_name,
                e.severity, e.message
         FROM events e
         INNER JOIN drivers d ON d.session_id = e.session_id AND d.name = e.driver_name
         WHERE d.id = ?1
         ORDER BY e.elapsed_time",
    )?;

    let rows = stmt.query_map(rusqlite::params![driver_id], |row| {
        let et: f64 = row.get(2)?;
        Ok(PostRaceEvent {
            id: row.get(0)?,
            event_type: row.get(1)?,
            elapsed_time: et,
            elapsed_time_formatted: format_elapsed_time(et),
            driver_name: row.get(3)?,
            target_name: row.get(4)?,
            severity: row.get(5)?,
            message: row.get(6)?,
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
    ve_level: Option<f64>,
    ve_used: Option<f64>,
}

fn query_stint_summary(conn: &Connection, driver_id: i64) -> Result<Vec<PostRaceStintData>> {
    let mut stmt = conn.prepare(
        "SELECT stint_number, lap_time, fuel_level,
                tw_fl, tw_fr, tw_rl, tw_rr, compound_fl,
                ve_level, ve_used
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
                ve_level: row.get(8)?,
                ve_used: row.get(9)?,
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

        // VE aggregation — only meaningful when at least one lap has ve_used data.
        let ve_used_laps: Vec<f64> = group.iter().filter_map(|r| r.ve_used).collect();
        let (ve_consumed, avg_ve_per_lap) = if ve_used_laps.is_empty() {
            (None, None)
        } else {
            let total: f64 = ve_used_laps.iter().sum();
            let avg = total / ve_used_laps.len() as f64;
            (Some(total), Some(avg))
        };
        // ve_start / ve_end: first and last lap that have a non-None ve_level.
        let ve_start = group.iter().find_map(|r| r.ve_level);
        let ve_end = group.iter().rev().find_map(|r| r.ve_level);

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
            ve_start,
            ve_end,
            ve_consumed,
            avg_ve_per_lap,
        });

        i = j;
    }

    Ok(stints)
}

// ---------------------------------------------------------------------------
// 6. post_race_events
// ---------------------------------------------------------------------------

fn post_race_events(session_id: i64) -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => return db_error(format!("DB unavailable: {e}")),
    };
    let conn = db.lock();
    match query_events(&conn, session_id) {
        Ok((summary, driver_summaries, events)) => ServerMessage::PostRaceEvents {
            session_id,
            summary,
            driver_summaries,
            events,
        },
        Err(e) => db_error(format!("Events query failed: {e}")),
    }
}

fn query_events(
    conn: &Connection,
    session_id: i64,
) -> Result<(
    PostRaceEventsSummary,
    Vec<PostRaceDriverEventSummary>,
    Vec<PostRaceEvent>,
)> {
    // Session-wide summary via SQL aggregation.
    let summary = conn.query_row(
        "SELECT
             COUNT(CASE WHEN event_type = 'incident' THEN 1 END),
             COUNT(CASE WHEN event_type = 'incident' AND target_name IS NOT NULL THEN 1 END),
             COUNT(CASE WHEN event_type = 'incident' AND target_name IS NULL THEN 1 END),
             COUNT(CASE WHEN event_type = 'penalty' THEN 1 END),
             COUNT(CASE WHEN event_type = 'track_limit' THEN 1 END),
             COUNT(CASE WHEN event_type = 'damage' THEN 1 END)
         FROM events WHERE session_id = ?1",
        rusqlite::params![session_id],
        |row| {
            Ok(PostRaceEventsSummary {
                total_incidents: row.get(0)?,
                vehicle_contacts: row.get(1)?,
                object_contacts: row.get(2)?,
                penalties: row.get(3)?,
                track_limit_warnings: row.get(4)?,
                damage_reports: row.get(5)?,
            })
        },
    )?;

    // Per-driver summaries via SQL GROUP BY.
    let mut ds_stmt = conn.prepare(
        "SELECT
             driver_name,
             COUNT(CASE WHEN event_type = 'incident' THEN 1 END),
             COUNT(CASE WHEN event_type = 'incident' AND target_name IS NOT NULL THEN 1 END),
             COUNT(CASE WHEN event_type = 'incident' AND target_name IS NULL THEN 1 END),
             AVG(CASE WHEN event_type = 'incident' THEN severity END),
             MAX(CASE WHEN event_type = 'incident' THEN severity END),
             COUNT(CASE WHEN event_type = 'penalty' THEN 1 END),
             COUNT(CASE WHEN event_type = 'track_limit' THEN 1 END),
             SUM(CASE WHEN event_type = 'track_limit' THEN COALESCE(warning_points, 0) ELSE 0 END)
         FROM events
         WHERE session_id = ?1 AND driver_name IS NOT NULL
         GROUP BY driver_name
         ORDER BY COUNT(CASE WHEN event_type = 'incident' THEN 1 END) DESC",
    )?;

    let driver_summaries: Vec<PostRaceDriverEventSummary> = ds_stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(PostRaceDriverEventSummary {
                driver_name: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                incidents_total: row.get(1)?,
                incidents_vehicle: row.get(2)?,
                incidents_object: row.get(3)?,
                avg_severity: row.get(4)?,
                max_severity: row.get(5)?,
                penalties: row.get(6)?,
                track_limit_warnings: row.get(7)?,
                track_limit_points: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // All events, sorted chronologically.
    let mut ev_stmt = conn.prepare(
        "SELECT id, event_type, elapsed_time, driver_name, target_name, severity, message
         FROM events
         WHERE session_id = ?1
         ORDER BY elapsed_time",
    )?;

    let events: Vec<PostRaceEvent> = ev_stmt
        .query_map(rusqlite::params![session_id], |row| {
            let et: f64 = row.get(2)?;
            Ok(PostRaceEvent {
                id: row.get(0)?,
                event_type: row.get(1)?,
                elapsed_time: et,
                elapsed_time_formatted: format_elapsed_time(et),
                driver_name: row.get(3)?,
                target_name: row.get(4)?,
                severity: row.get(5)?,
                message: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok((summary, driver_summaries, events))
}

// ---------------------------------------------------------------------------
// 7. post_race_fun_facts
// ---------------------------------------------------------------------------

fn post_race_fun_facts() -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(_) => return ServerMessage::PostRaceFunFacts { facts: vec![], player_name: None },
    };
    let conn = db.lock();
    match query_fun_facts(&conn) {
        Ok((facts, player_name)) => ServerMessage::PostRaceFunFacts { facts, player_name },
        Err(_) => ServerMessage::PostRaceFunFacts { facts: vec![], player_name: None },
    }
}

fn query_fun_facts(conn: &Connection) -> Result<(Vec<String>, Option<String>)> {
    let mut facts: Vec<String> = Vec::new();

    // Player name (most frequent name with is_player = 1)
    let player_name: Option<String> = conn
        .query_row(
            "SELECT name FROM drivers WHERE is_player = 1 AND name != ''
             GROUP BY name ORDER BY COUNT(*) DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();

    // Total valid laps across all sessions and all drivers
    let total_laps: i64 = conn
        .query_row("SELECT COUNT(*) FROM laps WHERE lap_time IS NOT NULL AND lap_time > 0", [], |r| r.get(0))
        .unwrap_or(0);
    if total_laps > 0 {
        facts.push(format!("Total laps in database: {}", fmt_number(total_laps)));
    }

    // Total sessions
    let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap_or(0);
    if sessions > 0 {
        facts.push(format!("Sessions recorded: {}", fmt_number(sessions)));
    }

    // Favorite track (by session count)
    let fav_track: Option<(String, i64)> = conn
        .query_row(
            "SELECT track_venue, COUNT(*) as cnt FROM sessions
             WHERE track_venue IS NOT NULL AND track_venue != ''
             GROUP BY track_venue ORDER BY cnt DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((track, cnt)) = fav_track {
        facts.push(format!(
            "Favorite track: {} ({} session{})",
            track,
            cnt,
            if cnt == 1 { "" } else { "s" }
        ));
    }

    // Most driven car class (player only, filtered by name to avoid other is_player=1 entries)
    let fav_class: Option<(String, i64)> = player_name.as_deref().and_then(|pname| {
        conn.query_row(
            "SELECT car_class, SUM(total_laps) as lap_cnt FROM drivers
             WHERE is_player = 1 AND name = ?1 AND car_class IS NOT NULL AND car_class != ''
             GROUP BY car_class ORDER BY lap_cnt DESC LIMIT 1",
            [pname],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        ).ok()
    });
    if let Some((class, laps)) = fav_class {
        facts.push(format!("Most driven class: {} ({} laps)", class, fmt_number(laps)));
    }

    // Player wins (position 1 in Race sessions)
    let wins: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 1 AND d.position = 1 AND s.session_type LIKE '%Race%'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    facts.push(format!("Race wins: {}", wins));

    // Top rival (most shared sessions with the player)
    let rival: Option<(String, i64)> = conn
        .query_row(
            "SELECT d.name, COUNT(*) as cnt FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 0 AND d.name IS NOT NULL AND d.name != ''
             GROUP BY d.name ORDER BY cnt DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((name, cnt)) = rival {
        if cnt > 1 {
            facts.push(format!(
                "Top rival: {} ({} shared session{})",
                name,
                cnt,
                if cnt == 1 { "" } else { "s" }
            ));
        }
    }

    // Total pitstops (player only, filtered by name to avoid other is_player=1 entries)
    let pitstops: i64 = player_name.as_deref().and_then(|pname| {
        conn.query_row(
            "SELECT COALESCE(SUM(pitstops), 0) FROM drivers WHERE is_player = 1 AND name = ?1",
            [pname],
            |r| r.get::<_, i64>(0),
        ).ok()
    }).unwrap_or(0);
    if pitstops > 0 {
        facts.push(format!("Pitstops made: {}", fmt_number(pitstops)));
    }

    // ── Konsistenz / Pace ──────────────────────────────────────────────────────

    // Most consistent race: race session with lowest stddev of player lap times (≥5 laps)
    // SQLite variance: avg(x²) - avg(x)² = population variance
    let consistent_race: Option<(String, f64)> = conn
        .query_row(
            "SELECT s.track_venue,
                    AVG(l.lap_time * l.lap_time) - AVG(l.lap_time) * AVG(l.lap_time) AS variance
             FROM laps l
             INNER JOIN drivers d ON l.driver_id = d.id
             INNER JOIN sessions s ON l.session_id = s.id
             WHERE d.is_player = 1
               AND l.lap_time IS NOT NULL AND l.lap_time > 0
               AND l.is_pit = 0
               AND s.session_type LIKE '%Race%'
             GROUP BY d.id
             HAVING COUNT(l.id) >= 5
             ORDER BY variance ASC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)),
        )
        .ok();
    if let Some((track, variance)) = consistent_race {
        if variance >= 0.0 {
            let stddev = variance.sqrt();
            facts.push(format!("Most consistent race: {} — ±{:.3}s avg lap variance", track, stddev));
        }
    }

    // Clean streak: longest consecutive laps without an incident across all player sessions
    let clean_streak = compute_clean_streak(conn).unwrap_or(0);
    if clean_streak >= 10 {
        facts.push(format!(
            "Longest clean streak: {} consecutive laps without incident",
            fmt_number(clean_streak)
        ));
    }

    // ── Zeitlich / Progression ─────────────────────────────────────────────────

    // First recorded session: earliest session date + track
    let first_session: Option<(String, String)> = conn
        .query_row(
            "SELECT s.date_time, COALESCE(s.track_venue, '?') FROM sessions s
             INNER JOIN drivers d ON d.session_id = s.id
             WHERE d.is_player = 1 AND s.date_time IS NOT NULL
             ORDER BY s.date_time ASC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    if let Some((dt_str, track)) = first_session {
        if let Some(label) = fmt_date_short(&dt_str) {
            facts.push(format!("Racing since: {} at {}", label, track));
        }
    }

    // Longest race: most laps driven by player in a single race session
    let longest_race: Option<(String, i64)> = conn
        .query_row(
            "SELECT s.track_venue, d.total_laps FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 1 AND s.session_type LIKE '%Race%' AND d.total_laps IS NOT NULL
             ORDER BY d.total_laps DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((track, laps)) = longest_race {
        if laps >= 5 {
            facts.push(format!("Longest race: {} laps at {}", laps, track));
        }
    }

    // Improvement trend: track with ≥6 player sessions, first-third vs last-third avg best lap
    if let Some(trend_fact) = compute_improvement_trend(conn) {
        facts.push(trend_fact);
    }

    // ── Sozial / Multiplayer ───────────────────────────────────────────────────

    // Nemesis: driver who finished directly ahead of player most often (player pos = nemesis pos + 1)
    let nemesis: Option<(String, i64)> = conn
        .query_row(
            "SELECT d_nem.name, COUNT(*) as cnt
             FROM drivers d_player
             INNER JOIN drivers d_nem
                 ON d_nem.session_id = d_player.session_id
                AND d_nem.position = d_player.position - 1
             INNER JOIN sessions s ON s.id = d_player.session_id
             WHERE d_player.is_player = 1
               AND d_player.position IS NOT NULL AND d_player.position > 1
               AND s.session_type LIKE '%Race%'
               AND d_nem.is_player = 0
               AND d_nem.name IS NOT NULL AND d_nem.name != ''
             GROUP BY d_nem.name ORDER BY cnt DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((name, cnt)) = nemesis {
        if cnt >= 2 {
            facts.push(format!(
                "Nemesis: {} beat you {} time{}",
                name,
                cnt,
                if cnt == 1 { "" } else { "s" }
            ));
        }
    }

    // Overtake magnet: biggest positions gained in a single race (lap 1 pos → finish pos)
    let overtake_magnet: Option<(i64, String)> = conn
        .query_row(
            "SELECT (fl.position - d.position) AS gain, s.track_venue
             FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             INNER JOIN (
                 SELECT driver_id, MIN(position) AS position
                 FROM laps
                 WHERE lap_num <= 2 AND position IS NOT NULL AND position > 0
                 GROUP BY driver_id
             ) fl ON fl.driver_id = d.id
             WHERE d.is_player = 1
               AND s.session_type LIKE '%Race%'
               AND d.position IS NOT NULL AND d.position > 0
               AND fl.position IS NOT NULL
               AND (fl.position - d.position) > 0
             ORDER BY gain DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    if let Some((gain, track)) = overtake_magnet {
        if gain >= 3 {
            facts.push(format!("Best comeback: +{} positions at {}", gain, track));
        }
    }

    // Backmarker sessions: sessions where player finished in bottom half of field
    let backmarker_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             INNER JOIN (
                 SELECT session_id, COUNT(*) AS driver_count FROM drivers GROUP BY session_id
             ) dc ON dc.session_id = d.session_id
             WHERE d.is_player = 1
               AND d.position IS NOT NULL
               AND CAST(d.position AS REAL) > CAST(dc.driver_count AS REAL) / 2.0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if backmarker_sessions >= 3 {
        facts.push(format!("Backmarker sessions: {} — stay humble!", fmt_number(backmarker_sessions)));
    }

    // ── Auto / Klasse ──────────────────────────────────────────────────────────

    // Most winning car: car_type with most race wins
    let winning_car: Option<(String, i64)> = conn
        .query_row(
            "SELECT d.car_type, COUNT(*) as wins FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 1 AND d.position = 1
               AND s.session_type LIKE '%Race%'
               AND d.car_type IS NOT NULL AND d.car_type != ''
             GROUP BY d.car_type ORDER BY wins DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((car, wins)) = winning_car {
        if wins >= 1 {
            facts.push(format!("Most winning car: {} ({} win{})", car, wins, if wins == 1 { "" } else { "s" }));
        }
    }

    // Class hopper vs specialist: count distinct car classes
    let class_count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT car_class) FROM drivers
             WHERE is_player = 1 AND car_class IS NOT NULL AND car_class != ''",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if class_count >= 1 {
        let label = match class_count {
            1 | 2 => format!("Class specialist — {} class{}", class_count, if class_count == 1 { "" } else { "es" }),
            3 => "Versatile racer — 3 different classes".to_string(),
            _ => format!("Class hopper — {} different classes!", class_count),
        };
        facts.push(label);
    }

    // Night owl / Early bird: most common hour bucket from player session timestamps
    if let Some(time_fact) = compute_time_of_day_fact(conn) {
        facts.push(time_fact);
    }

    // ── Milestones ─────────────────────────────────────────────────────────────

    // Total player laps (sum of total_laps from player driver records)
    let player_lap_count: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total_laps), 0) FROM drivers WHERE is_player = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Lap milestone: next milestone and how many to go
    const MILESTONES: &[i64] = &[100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000];
    if player_lap_count > 0 {
        if let Some(&next) = MILESTONES.iter().find(|&&m| m > player_lap_count) {
            let remaining = next - player_lap_count;
            let pct_done = player_lap_count as f64 / next as f64;
            if pct_done >= 0.85 {
                facts.push(format!(
                    "Almost there: {} laps to your {}th lap!",
                    remaining,
                    fmt_number(next)
                ));
            } else {
                facts.push(format!(
                    "Next milestone: {} laps — {} to go",
                    fmt_number(next),
                    fmt_number(remaining)
                ));
            }
        } else {
            // Passed all milestones
            facts.push(format!("Milestone legend: {} laps driven!", fmt_number(player_lap_count)));
        }
    }

    // Podium rate: % of race sessions where player finished P1–P3
    let podium_rate: Option<(i64, i64)> = conn
        .query_row(
            "SELECT
                 COUNT(CASE WHEN d.position <= 3 THEN 1 END),
                 COUNT(*)
             FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 1
               AND s.session_type LIKE '%Race%'
               AND d.position IS NOT NULL",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((podiums, total_races)) = podium_rate {
        if total_races >= 3 {
            let rate = podiums as f64 / total_races as f64 * 100.0;
            facts.push(format!("Podium rate: {:.0}% ({} of {} races)", rate, podiums, total_races));
        }
    }

    Ok((facts, player_name))
}

/// Computes the longest consecutive sequence of laps without an incident
/// across all player sessions.
fn compute_clean_streak(conn: &Connection) -> Result<i64> {
    // All player driver IDs, ordered for determinism.
    let mut driver_stmt = conn.prepare(
        "SELECT d.id, d.session_id FROM drivers d
         INNER JOIN sessions s ON s.id = d.session_id
         WHERE d.is_player = 1
         ORDER BY s.date_time ASC, d.id ASC",
    )?;
    let player_drivers: Vec<(i64, i64)> = driver_stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut lap_stmt = conn.prepare(
        "SELECT lap_num, elapsed_time FROM laps WHERE driver_id = ?1 ORDER BY lap_num",
    )?;
    let mut inc_stmt = conn.prepare(
        "SELECT e.elapsed_time FROM events e
         INNER JOIN drivers d ON d.session_id = e.session_id AND d.name = e.driver_name
         WHERE d.id = ?1 AND e.event_type = 'incident'",
    )?;

    struct LapRow { elapsed_time: Option<f64> }

    let mut global_max: i64 = 0;
    let mut current: i64 = 0;

    for (driver_id, _) in &player_drivers {
        let laps: Vec<LapRow> = lap_stmt
            .query_map(rusqlite::params![driver_id], |r| Ok(LapRow { elapsed_time: r.get(1)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        if laps.is_empty() {
            continue;
        }

        let incident_ets: Vec<f64> = inc_stmt
            .query_map(rusqlite::params![driver_id], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        // Mark each lap as clean or dirty by checking incident elapsed_time ranges.
        let mut prev_et: f64 = 0.0;
        for lap in &laps {
            let this_et = lap.elapsed_time.unwrap_or(f64::MAX);
            let has_incident = incident_ets.iter().any(|&et| et > prev_et && et <= this_et);
            if has_incident {
                global_max = global_max.max(current);
                current = 0;
            } else {
                current += 1;
            }
            if lap.elapsed_time.is_some() {
                prev_et = this_et;
            }
        }
        // End-of-session: reset streak (don't carry across sessions).
        global_max = global_max.max(current);
        current = 0;
    }

    Ok(global_max)
}

/// Finds the track where the player has the most sessions (≥ 6) and
/// compares first-third vs last-third average best lap time.
fn compute_improvement_trend(conn: &Connection) -> Option<String> {
    let track: String = conn
        .query_row(
            "SELECT s.track_venue FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 1
               AND d.best_lap_time IS NOT NULL AND d.best_lap_time > 0
               AND s.track_venue IS NOT NULL
             GROUP BY s.track_venue
             HAVING COUNT(*) >= 6
             ORDER BY COUNT(*) DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()?;

    let mut stmt = conn
        .prepare(
            "SELECT d.best_lap_time FROM drivers d
             INNER JOIN sessions s ON s.id = d.session_id
             WHERE d.is_player = 1 AND s.track_venue = ?1
               AND d.best_lap_time IS NOT NULL AND d.best_lap_time > 0
             ORDER BY s.date_time ASC",
        )
        .ok()?;

    let times: Vec<f64> = stmt
        .query_map(rusqlite::params![track], |r| r.get(0))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    let n = times.len();
    if n < 6 {
        return None;
    }

    let split = (n / 3).max(1);
    let early_avg: f64 = times[..split].iter().sum::<f64>() / split as f64;
    let late_avg: f64 = times[n - split..].iter().sum::<f64>() / split as f64;
    let improvement = early_avg - late_avg; // positive = faster now

    if improvement > 0.1 {
        Some(format!("Improving at {}: {:.3}s faster than first sessions", track, improvement))
    } else if improvement < -0.1 {
        Some(format!("Slower at {} lately: {:.3}s off early pace", track, improvement.abs()))
    } else {
        None
    }
}

/// Returns a "Night Owl / Early Bird" fact based on the most common hour bucket
/// across all player sessions.
fn compute_time_of_day_fact(conn: &Connection) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.date_time FROM sessions s
             INNER JOIN drivers d ON d.session_id = s.id
             WHERE d.is_player = 1 AND s.date_time IS NOT NULL",
        )
        .ok()?;

    let date_times: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    let mut buckets = [0i32; 4]; // [night(22-6), morning(6-12), afternoon(12-18), evening(18-22)]
    let mut total = 0;

    for dt in &date_times {
        if let Some(h) = parse_hour(dt) {
            let bucket = match h {
                6..=11  => 1, // morning
                12..=17 => 2, // afternoon
                18..=21 => 3, // evening
                _       => 0, // night (22–5)
            };
            buckets[bucket] += 1;
            total += 1;
        }
    }

    if total < 3 {
        return None;
    }

    let best_bucket = buckets.iter().enumerate().max_by_key(|&(_, v)| v)?.0;
    let labels = ["Night Owl", "Morning Racer", "Afternoon Racer", "Evening Racer"];
    let hours  = ["usually after 22:00", "usually before noon", "peak time 12–18", "peak time 18–22"];

    Some(format!("{}: {}", labels[best_bucket], hours[best_bucket]))
}

/// Parses a date_time string (Unix timestamp or ISO-like) and returns the local hour (0–23).
fn parse_hour(dt: &str) -> Option<u32> {
    let trimmed = dt.trim();
    // Unix timestamp (all digits)
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        let ts: i64 = trimmed.parse().ok()?;
        // UTC hour from Unix timestamp
        let hour = ((ts % 86400) / 3600).rem_euclid(24) as u32;
        return Some(hour);
    }
    // "YYYY-MM-DD HH:MM:SS" or "YYYY/MM/DD HH:MM:SS"
    let normalized = trimmed.replace('/', "-");
    if normalized.len() >= 13 {
        return normalized[11..13].parse().ok();
    }
    None
}

/// Formats a date_time string as "14 Mar 2025".
fn fmt_date_short(dt: &str) -> Option<String> {
    let trimmed = dt.trim();
    const MONTHS: &[&str] = &[
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    // Unix timestamp
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        let ts: i64 = trimmed.parse().ok()?;
        // Simple Gregorian calendar computation (good from 1970–2100)
        let days = ts / 86400;
        let (y, m, d) = days_to_ymd(days);
        let month = MONTHS.get((m as usize).saturating_sub(1))?;
        return Some(format!("{} {} {}", d, month, y));
    }

    // "YYYY-MM-DD ..." or "YYYY/MM/DD ..."
    let normalized = trimmed.replace('/', "-");
    if normalized.len() >= 10 {
        let year:  i32 = normalized[0..4].parse().ok()?;
        let month: u32 = normalized[5..7].parse().ok()?;
        let day:   u32 = normalized[8..10].parse().ok()?;
        let m_label = MONTHS.get((month as usize).saturating_sub(1))?;
        return Some(format!("{} {} {}", day, m_label, year));
    }
    None
}

/// Converts days since Unix epoch (1970-01-01) to (year, month, day).
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn fmt_number(n: i64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push('\'');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}

fn fmt_lap(secs: f64) -> String {
    if secs <= 0.0 {
        return "--:--.---".to_string();
    }
    let m = (secs / 60.0) as u64;
    let s = secs - (m as f64) * 60.0;
    format!("{}:{:06.3}", m, s)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Format elapsed time in seconds as "M:SS".
fn format_elapsed_time(seconds: f64) -> String {
    let total_secs = seconds as u64;
    let minutes = total_secs / 60;
    let secs = total_secs % 60;
    format!("{}:{:02}", minutes, secs)
}
