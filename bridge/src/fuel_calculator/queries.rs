//! SQLite queries for the Fuel Calculator.
//!
//! All functions are read-only — no schema changes are made here.
//! Column names are taken directly from the PostRace schema in `database.rs`.

use anyhow::{bail, Result};
use rusqlite::Connection;

use super::types::{CarOption, FuelCalcOptions, FuelCalcResult, TrackOption};

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn std_dev(values: &[f64], avg: f64) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let variance = values.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / values.len() as f64;
    variance.sqrt()
}

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

struct LapData {
    fuel_used: f64,
    ve_used: Option<f64>,
    lap_time: Option<f64>,
    session_id: i64,
}

// ---------------------------------------------------------------------------
// Public: get_options
// ---------------------------------------------------------------------------

/// Return all track/car combinations for which valid player race laps exist.
pub fn get_options(conn: &Connection) -> Result<FuelCalcOptions> {
    // All distinct versions, newest first.
    let mut ver_stmt = conn.prepare(
        "SELECT DISTINCT game_version
         FROM sessions
         WHERE game_version IS NOT NULL
         ORDER BY game_version DESC",
    )?;
    let game_versions: Vec<String> = ver_stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Version of the newest session.
    let current_version: Option<String> = conn
        .query_row(
            "SELECT game_version FROM sessions
             WHERE game_version IS NOT NULL
             ORDER BY date_time DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();

    // Valid lap = player, race session, not lap 1, not inlap (is_pit=1),
    //             not outlap-after-pit (prev lap is_pit=1), has fuel data.
    let mut opts_stmt = conn.prepare(
        "SELECT
             s.track_venue,
             s.track_course,
             s.track_length,
             d.car_class,
             d.car_type,
             COUNT(DISTINCT s.id) AS session_count,
             COUNT(l.id)          AS total_laps
         FROM sessions s
         JOIN drivers d  ON d.session_id = s.id AND d.is_player = 1
         JOIN laps    l  ON l.driver_id = d.id
         LEFT JOIN laps prev_l
                      ON prev_l.driver_id = l.driver_id
                     AND prev_l.lap_num   = l.lap_num - 1
         WHERE s.session_type LIKE '%Race%'
           AND s.track_venue IS NOT NULL
           AND l.lap_num   > 1
           AND l.is_pit    = 0
           AND (prev_l.id IS NULL OR prev_l.is_pit = 0)
           AND l.fuel_used > 0
           AND l.lap_time IS NOT NULL
         GROUP BY s.track_venue, s.track_course, s.track_length,
                  d.car_class, d.car_type
         ORDER BY s.track_venue, d.car_class, d.car_type",
    )?;

    struct RowData {
        track_venue: String,
        track_course: Option<String>,
        track_length: Option<f64>,
        car_class: Option<String>,
        car_name: Option<String>,
        session_count: u32,
        total_laps: u32,
    }

    let rows: Vec<RowData> = opts_stmt
        .query_map([], |row| {
            Ok(RowData {
                track_venue: row.get(0)?,
                track_course: row.get(1)?,
                track_length: row.get(2)?,
                car_class: row.get(3)?,
                car_name: row.get(4)?,
                session_count: row.get::<_, u32>(5)?,
                total_laps: row.get::<_, u32>(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Group rows by track_venue.
    let mut tracks: Vec<TrackOption> = Vec::new();
    for row in rows {
        let track = match tracks.iter_mut().find(|t| t.track_venue == row.track_venue) {
            Some(t) => t,
            None => {
                tracks.push(TrackOption {
                    track_venue: row.track_venue.clone(),
                    track_course: row.track_course.clone(),
                    track_length: row.track_length,
                    cars: Vec::new(),
                });
                tracks.last_mut().unwrap()
            }
        };
        track.cars.push(CarOption {
            car_class: row.car_class,
            car_name: row.car_name,
            session_count: row.session_count,
            total_laps: row.total_laps,
        });
    }

    Ok(FuelCalcOptions {
        tracks,
        game_versions,
        current_version,
    })
}

// ---------------------------------------------------------------------------
// Public: compute
// ---------------------------------------------------------------------------

pub struct ComputeParams {
    pub track_venue: String,
    /// Matches `drivers.car_type`.
    pub car_name: String,
    pub race_laps: Option<u32>,
    pub race_minutes: Option<f64>,
    pub include_all_versions: bool,
}

pub fn compute(conn: &Connection, params: ComputeParams) -> Result<FuelCalcResult> {
    // Resolve version filter.
    let current_version: Option<String> = conn
        .query_row(
            "SELECT game_version FROM sessions
             WHERE game_version IS NOT NULL
             ORDER BY date_time DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();

    let version_filter_desc = if params.include_all_versions {
        "all versions".to_string()
    } else {
        current_version
            .as_deref()
            .map(|v| format!("v{v}"))
            .unwrap_or_else(|| "all versions".to_string())
    };
    let filter_version = if params.include_all_versions {
        None
    } else {
        current_version.as_deref()
    };

    // Fetch valid laps.
    let laps = query_valid_laps(conn, &params.track_venue, &params.car_name, filter_version)?;

    if laps.is_empty() {
        bail!(
            "No valid laps found for '{}' / '{}' ({}). \
             Try enabling 'include all versions'.",
            params.track_venue,
            params.car_name,
            version_filter_desc
        );
    }

    let laps_used = laps.len() as u32;
    let confidence = match laps_used {
        0..=9 => "low",
        10..=50 => "medium",
        _ => "high",
    }
    .to_string();

    // Distinct session count + fuel_mult from most recent session.
    let session_ids: std::collections::HashSet<i64> = laps.iter().map(|l| l.session_id).collect();
    let sessions_used = session_ids.len() as u32;

    let fuel_mult = query_fuel_mult(conn, &params.track_venue, &params.car_name, filter_version)
        .unwrap_or(1.0);

    // Fuel statistics.
    let fuel_values: Vec<f64> = laps.iter().map(|l| l.fuel_used).collect();
    let avg_fuel_per_lap = mean(&fuel_values);
    let fuel_std_dev = std_dev(&fuel_values, avg_fuel_per_lap);

    // VE statistics — only laps with ve_used > 0 count.
    let ve_values: Vec<f64> = laps
        .iter()
        .filter_map(|l| l.ve_used)
        .filter(|&v| v > 0.0)
        .collect();
    let has_ve = !ve_values.is_empty();
    let avg_ve_per_lap = has_ve.then(|| mean(&ve_values));
    let ve_std_dev = avg_ve_per_lap.map(|avg| std_dev(&ve_values, avg));

    // Lap time average (needed for race_minutes → race_laps conversion).
    let lap_times: Vec<f64> = laps.iter().filter_map(|l| l.lap_time).collect();
    let avg_lap_time = if lap_times.is_empty() {
        None
    } else {
        Some(mean(&lap_times))
    };

    // Resolve race_laps.
    let race_laps: u32 = match (params.race_laps, params.race_minutes) {
        (Some(laps), _) => laps,
        (None, Some(mins)) => {
            let avg_lt = avg_lap_time.ok_or_else(|| {
                anyhow::anyhow!("No lap time data available to estimate laps from race_minutes")
            })?;
            ((mins * 60.0 / avg_lt).ceil() as u32) + 1 // +1 safety margin
        }
        (None, None) => bail!("Must provide either race_laps or race_minutes"),
    };

    let total_fuel_needed = avg_fuel_per_lap * race_laps as f64;

    // Fuel capacity = max observed fuel_level (proxy for tank capacity after refuel).
    let fuel_capacity =
        query_fuel_capacity(conn, &params.track_venue, &params.car_name)?;

    // Fuel stint laps + pit stops.
    let (fuel_stint_laps, fuel_pit_stops) = compute_stint_and_stops(
        fuel_capacity,
        avg_fuel_per_lap,
        race_laps,
    );

    // VE stint laps + pit stops.
    let (ve_stint_laps, ve_pit_stops) = if let Some(avg_ve) = avg_ve_per_lap {
        // VE runs from 1.0 → 0.0; avg_ve_per_lap is the fraction consumed per lap.
        compute_stint_and_stops(Some(1.0), avg_ve, race_laps)
    } else {
        (None, None)
    };

    // Combined stint.
    let effective_stint_laps = match (fuel_stint_laps, ve_stint_laps) {
        (Some(f), Some(v)) => Some(f.min(v)),
        (a, b) => a.or(b),
    };

    let total_pit_stops = match (fuel_pit_stops, ve_pit_stops) {
        (Some(f), Some(v)) => Some(f.max(v)),
        (a, b) => a.or(b),
    };

    let limiting_factor = match (fuel_stint_laps, ve_stint_laps) {
        (Some(f), Some(v)) => Some(if f <= v { "fuel" } else { "ve" }.to_string()),
        (Some(_), None) => Some("fuel".to_string()),
        (None, Some(_)) => Some("ve".to_string()),
        (None, None) => None,
    };

    // Recommended start fuel: enough for the first stint plus a 5 % buffer,
    // capped at tank capacity. If no pit stops are needed, cover the full race.
    let recommended_start_fuel = {
        let first_stint_laps = fuel_stint_laps
            .filter(|_| fuel_pit_stops.unwrap_or(0) > 0)
            .unwrap_or(race_laps);
        let needed = avg_fuel_per_lap * (first_stint_laps as f64) * 1.05;
        Some(if let Some(cap) = fuel_capacity {
            needed.min(cap)
        } else {
            needed
        })
    };

    let recommended_start_ve = has_ve.then_some(1.0);

    // Car class from any matching driver row.
    let car_class = query_car_class(conn, &params.track_venue, &params.car_name)?;

    Ok(FuelCalcResult {
        track_venue: params.track_venue,
        car_class,
        car_name: params.car_name,
        sessions_used,
        laps_used,
        confidence,
        version_filter: version_filter_desc,
        fuel_mult,
        avg_fuel_per_lap,
        fuel_std_dev,
        total_fuel_needed,
        fuel_capacity,
        fuel_stint_laps,
        fuel_pit_stops,
        has_ve,
        avg_ve_per_lap,
        ve_std_dev,
        ve_stint_laps,
        ve_pit_stops,
        effective_stint_laps,
        total_pit_stops,
        limiting_factor,
        recommended_start_fuel,
        recommended_start_ve,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute stint length and number of pit stops given a tank/battery capacity,
/// consumption per lap, and race length.
///
/// Returns `(None, None)` if capacity or consumption is zero/unknown.
fn compute_stint_and_stops(
    capacity: Option<f64>,
    consumption_per_lap: f64,
    race_laps: u32,
) -> (Option<u32>, Option<u32>) {
    let Some(cap) = capacity else { return (None, None) };
    if consumption_per_lap <= 0.0 || cap <= 0.0 {
        return (None, None);
    }
    let stint_laps = (cap / consumption_per_lap).floor() as u32;
    if stint_laps == 0 {
        return (Some(0), None);
    }
    let pit_stops = if stint_laps >= race_laps {
        0
    } else {
        ((race_laps as f64 / stint_laps as f64).ceil() as u32).saturating_sub(1)
    };
    (Some(stint_laps), Some(pit_stops))
}

fn valid_laps_base_sql(with_version_filter: bool) -> String {
    let version_clause = if with_version_filter {
        "AND s.game_version = ?3"
    } else {
        ""
    };
    format!(
        "SELECT l.fuel_used, l.ve_used, l.lap_time, l.session_id
         FROM sessions s
         JOIN drivers d  ON d.session_id = s.id AND d.is_player = 1
         JOIN laps    l  ON l.driver_id = d.id
         LEFT JOIN laps prev_l
                      ON prev_l.driver_id = l.driver_id
                     AND prev_l.lap_num   = l.lap_num - 1
         WHERE s.track_venue    = ?1
           AND d.car_type       = ?2
           AND s.session_type LIKE '%Race%'
           AND l.lap_num   > 1
           AND l.is_pit    = 0
           AND (prev_l.id IS NULL OR prev_l.is_pit = 0)
           AND l.fuel_used > 0
           AND l.lap_time IS NOT NULL
           {version_clause}"
    )
}

fn query_valid_laps(
    conn: &Connection,
    track_venue: &str,
    car_name: &str,
    version: Option<&str>,
) -> Result<Vec<LapData>> {
    let sql = valid_laps_base_sql(version.is_some());

    let mut stmt = conn.prepare(&sql)?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<LapData> {
        Ok(LapData {
            fuel_used: row.get(0)?,
            ve_used: row.get(1)?,
            lap_time: row.get(2)?,
            session_id: row.get(3)?,
        })
    };

    let rows = if let Some(v) = version {
        stmt.query_map(rusqlite::params![track_venue, car_name, v], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(rusqlite::params![track_venue, car_name], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(rows)
}

fn query_fuel_capacity(
    conn: &Connection,
    track_venue: &str,
    car_name: &str,
) -> Result<Option<f64>> {
    // Max observed fuel_level is a proxy for tank capacity (seen right after refuelling).
    let result: Option<f64> = conn
        .query_row(
            "SELECT MAX(l.fuel_level)
             FROM sessions s
             JOIN drivers d ON d.session_id = s.id AND d.is_player = 1
             JOIN laps    l ON l.driver_id  = d.id
             WHERE s.track_venue = ?1
               AND d.car_type   = ?2
               AND l.fuel_level IS NOT NULL",
            rusqlite::params![track_venue, car_name],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    Ok(result)
}

fn query_fuel_mult(
    conn: &Connection,
    track_venue: &str,
    car_name: &str,
    version: Option<&str>,
) -> Option<f64> {
    let version_clause = if version.is_some() {
        "AND s.game_version = ?3"
    } else {
        ""
    };
    let sql = format!(
        "SELECT s.fuel_mult
         FROM sessions s
         JOIN drivers d ON d.session_id = s.id AND d.is_player = 1
         WHERE s.track_venue    = ?1
           AND d.car_type       = ?2
           AND s.session_type LIKE '%Race%'
           AND s.fuel_mult IS NOT NULL
           {version_clause}
         ORDER BY s.date_time DESC
         LIMIT 1"
    );

    if let Some(v) = version {
        conn.query_row(&sql, rusqlite::params![track_venue, car_name, v], |row| {
            row.get(0)
        })
        .ok()
        .flatten()
    } else {
        conn.query_row(&sql, rusqlite::params![track_venue, car_name], |row| {
            row.get(0)
        })
        .ok()
        .flatten()
    }
}

fn query_car_class(
    conn: &Connection,
    track_venue: &str,
    car_name: &str,
) -> Result<Option<String>> {
    let result: Option<String> = conn
        .query_row(
            "SELECT d.car_class
             FROM sessions s
             JOIN drivers d ON d.session_id = s.id AND d.is_player = 1
             WHERE s.track_venue = ?1 AND d.car_type = ?2
             LIMIT 1",
            rusqlite::params![track_venue, car_name],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    Ok(result)
}
