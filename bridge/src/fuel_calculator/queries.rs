//! SQLite queries for the Fuel Calculator.
//!
//! All functions are read-only — no schema changes are made here.
//! Column names are taken directly from the PostRace schema in `database.rs`.
//!
//! All fuel and VE values returned in `FuelCalcResult` are **percentages** (0–100),
//! converted from the raw 0.0–1.0 fractions stored in the DB.

use anyhow::{bail, Result};
use rusqlite::Connection;
use std::collections::HashMap;

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
// Helpers
// ---------------------------------------------------------------------------

/// SQL fragment for the session type filter.
/// Always includes Race sessions; optionally includes Practice sessions.
fn session_type_sql(include_practice: bool) -> &'static str {
    if include_practice {
        "(s.session_type LIKE '%Race%' OR s.session_type LIKE 'Practice%')"
    } else {
        "s.session_type LIKE '%Race%'"
    }
}

// ---------------------------------------------------------------------------
// Public: get_options
// ---------------------------------------------------------------------------

/// Return all track/car combinations for which valid player race laps exist,
/// including available FuelMult values per car.
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
        &format!("SELECT
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
         WHERE {sess}
           AND s.track_venue IS NOT NULL
           AND l.lap_num   > 1
           AND l.is_pit    = 0
           AND (prev_l.id IS NULL OR prev_l.is_pit = 0)
           AND l.fuel_used > 0
           AND l.lap_time IS NOT NULL
         GROUP BY s.track_venue, s.track_course, s.track_length,
                  d.car_class, d.car_type
         ORDER BY s.track_venue, d.car_class, d.car_type",
         sess = session_type_sql(true)),
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

    // Query FuelMult data: distinct values per track+car, ordered by most recent first.
    // GROUP BY (track_venue, car_type, fuel_mult) then order by MAX(date_time) DESC
    // so the first row per track+car is the default (most recent) FuelMult.
    let mut fm_stmt = conn.prepare(
        &format!("SELECT s.track_venue, d.car_type, s.fuel_mult, MAX(s.date_time) AS latest_dt
         FROM sessions s
         JOIN drivers d ON d.session_id = s.id AND d.is_player = 1
         WHERE {sess}
           AND s.fuel_mult IS NOT NULL
         GROUP BY s.track_venue, d.car_type, s.fuel_mult
         ORDER BY s.track_venue, d.car_type, latest_dt DESC",
         sess = session_type_sql(true)),
    )?;

    struct FmRow {
        track_venue: String,
        car_type: Option<String>,
        fuel_mult: f64,
    }

    let fm_rows: Vec<FmRow> = fm_stmt
        .query_map([], |row| {
            Ok(FmRow {
                track_venue: row.get(0)?,
                car_type: row.get(1)?,
                fuel_mult: row.get(2)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Build lookup: (track_venue, car_type) → (options_ascending, default_fuel_mult)
    // The fm_rows are ordered by latest_dt DESC, so the first occurrence per key = default.
    // options_ascending is sorted afterward.
    let mut fm_map: HashMap<(String, Option<String>), (Vec<f64>, Option<f64>)> =
        HashMap::new();
    for row in fm_rows {
        let key = (row.track_venue, row.car_type);
        let entry = fm_map.entry(key).or_default();
        if entry.1.is_none() {
            // First = most recent
            entry.1 = Some(row.fuel_mult);
        }
        entry.0.push(row.fuel_mult);
    }
    // Sort each options list ascending.
    for (opts, _) in fm_map.values_mut() {
        opts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }

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

        let fm_key = (row.track_venue.clone(), row.car_name.clone());
        let (fuel_mult_options, default_fuel_mult) = fm_map
            .get(&fm_key)
            .map(|(opts, def)| (opts.clone(), *def))
            .unwrap_or_default();

        track.cars.push(CarOption {
            car_class: row.car_class,
            car_name: row.car_name,
            session_count: row.session_count,
            total_laps: row.total_laps,
            fuel_mult_options,
            default_fuel_mult,
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
    /// If true, Practice sessions are included alongside Race sessions.
    pub include_practice: bool,
    /// FuelMult filter. `None` = auto (most recent session's FuelMult for this combo).
    pub fuel_mult: Option<f64>,
    /// Extra buffer laps added to recommended start fuel/VE. Default: 1.
    pub buffer_laps: u32,
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
    let filter_version: Option<&str> = if params.include_all_versions {
        None
    } else {
        current_version.as_deref()
    };

    // Determine FuelMult filter: use explicit override or auto-detect from most recent session.
    let filter_fuel_mult: Option<f64> = params.fuel_mult.or_else(|| {
        query_fuel_mult(conn, &params.track_venue, &params.car_name, filter_version, params.include_practice)
    });

    // Fetch valid laps.
    let laps = query_valid_laps(
        conn,
        &params.track_venue,
        &params.car_name,
        filter_version,
        filter_fuel_mult,
        params.include_practice,
    )?;

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

    // Distinct session count.
    let session_ids: std::collections::HashSet<i64> =
        laps.iter().map(|l| l.session_id).collect();
    let sessions_used = session_ids.len() as u32;

    let fuel_mult = filter_fuel_mult.unwrap_or(1.0);

    // Fuel statistics — convert raw fractions (0–1) to percentages (0–100).
    let fuel_values: Vec<f64> = laps.iter().map(|l| l.fuel_used * 100.0).collect();
    let avg_fuel_pct_per_lap = mean(&fuel_values);
    let fuel_std_dev_pct = std_dev(&fuel_values, avg_fuel_pct_per_lap);

    // VE statistics — only laps with ve_used > 0, also converted to %.
    let ve_values: Vec<f64> = laps
        .iter()
        .filter_map(|l| l.ve_used)
        .filter(|&v| v > 0.0)
        .map(|v| v * 100.0)
        .collect();
    let has_ve = !ve_values.is_empty();
    let avg_ve_pct_per_lap = has_ve.then(|| mean(&ve_values));
    let ve_std_dev_pct = avg_ve_pct_per_lap.map(|avg| std_dev(&ve_values, avg));

    // Lap time average in seconds (lap_time is stored in seconds).
    let lap_times: Vec<f64> = laps.iter().filter_map(|l| l.lap_time).filter(|&t| t > 0.0).collect();
    let avg_lap_time_secs = if lap_times.is_empty() {
        None
    } else {
        Some(mean(&lap_times))
    };

    // Resolve race_laps. Bug 2 fix: use floor() for time-based estimation.
    let estimated_laps: Option<u32>;
    let race_laps: u32 = match (params.race_laps, params.race_minutes) {
        (Some(laps), _) => {
            estimated_laps = None;
            laps
        }
        (None, Some(mins)) => {
            let avg_lt = avg_lap_time_secs.ok_or_else(|| {
                anyhow::anyhow!("No lap time data available to estimate laps from race_minutes")
            })?;
            let est = (mins * 60.0 / avg_lt).floor() as u32;
            estimated_laps = Some(est);
            est
        }
        (None, None) => bail!("Must provide either race_laps or race_minutes"),
    };

    let total_fuel_needed_pct = avg_fuel_pct_per_lap * race_laps as f64;

    // Stint laps + pit stops — capacity is 100% for both fuel and VE.
    let (fuel_stint_laps, fuel_pit_stops) =
        compute_stint_and_stops(avg_fuel_pct_per_lap, race_laps);

    let (ve_stint_laps, ve_pit_stops) = if let Some(avg_ve_pct) = avg_ve_pct_per_lap {
        compute_stint_and_stops(avg_ve_pct, race_laps)
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

    // Bug 3: Recommended start fuel/VE — (race_laps + buffer) × consumption, capped at 100%.
    let laps_with_buffer = race_laps as f64 + params.buffer_laps as f64;
    let recommended_start_fuel_pct =
        Some((laps_with_buffer * avg_fuel_pct_per_lap).min(100.0));
    let recommended_start_ve_pct = avg_ve_pct_per_lap
        .map(|ve_pct| (laps_with_buffer * ve_pct).min(100.0));

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
        avg_lap_time_secs,
        estimated_laps,
        race_laps,
        buffer_laps: params.buffer_laps,
        avg_fuel_pct_per_lap,
        fuel_std_dev_pct,
        total_fuel_needed_pct,
        fuel_stint_laps,
        fuel_pit_stops,
        has_ve,
        avg_ve_pct_per_lap,
        ve_std_dev_pct,
        ve_stint_laps,
        ve_pit_stops,
        effective_stint_laps,
        total_pit_stops,
        limiting_factor,
        recommended_start_fuel_pct,
        recommended_start_ve_pct,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute stint length and number of pit stops.
///
/// Tank/battery capacity is always 100% (we work in percent throughout).
fn compute_stint_and_stops(consumption_pct_per_lap: f64, race_laps: u32) -> (Option<u32>, Option<u32>) {
    if consumption_pct_per_lap <= 0.0 {
        return (None, None);
    }
    let stint_laps = (100.0_f64 / consumption_pct_per_lap).floor() as u32;
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

fn valid_laps_base_sql(with_version_filter: bool, with_fuel_mult_filter: bool, include_practice: bool) -> String {
    // ?1 = track_venue, ?2 = car_name, then optional ?3 / ?4 per active filter.
    let mut next_param = 2i32;

    let version_clause = if with_version_filter {
        next_param += 1;
        format!("AND s.game_version = ?{next_param}")
    } else {
        String::new()
    };

    let fuel_mult_clause = if with_fuel_mult_filter {
        next_param += 1;
        format!("AND s.fuel_mult = ?{next_param}")
    } else {
        String::new()
    };

    let sess = session_type_sql(include_practice);

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
           AND {sess}
           AND l.lap_num   > 1
           AND l.is_pit    = 0
           AND (prev_l.id IS NULL OR prev_l.is_pit = 0)
           AND l.fuel_used > 0
           AND l.lap_time IS NOT NULL
           {version_clause}
           {fuel_mult_clause}"
    )
}

fn query_valid_laps(
    conn: &Connection,
    track_venue: &str,
    car_name: &str,
    version: Option<&str>,
    fuel_mult: Option<f64>,
    include_practice: bool,
) -> Result<Vec<LapData>> {
    let sql = valid_laps_base_sql(version.is_some(), fuel_mult.is_some(), include_practice);
    let mut stmt = conn.prepare(&sql)?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<LapData> {
        Ok(LapData {
            fuel_used: row.get(0)?,
            ve_used: row.get(1)?,
            lap_time: row.get(2)?,
            session_id: row.get(3)?,
        })
    };

    let rows = match (version, fuel_mult) {
        (Some(v), Some(fm)) => stmt
            .query_map(rusqlite::params![track_venue, car_name, v, fm], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (Some(v), None) => stmt
            .query_map(rusqlite::params![track_venue, car_name, v], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (None, Some(fm)) => stmt
            .query_map(rusqlite::params![track_venue, car_name, fm], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (None, None) => stmt
            .query_map(rusqlite::params![track_venue, car_name], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };

    Ok(rows)
}

fn query_fuel_mult(
    conn: &Connection,
    track_venue: &str,
    car_name: &str,
    version: Option<&str>,
    include_practice: bool,
) -> Option<f64> {
    let version_clause = if version.is_some() {
        "AND s.game_version = ?3"
    } else {
        ""
    };
    let sess = session_type_sql(include_practice);
    let sql = format!(
        "SELECT s.fuel_mult
         FROM sessions s
         JOIN drivers d ON d.session_id = s.id AND d.is_player = 1
         WHERE s.track_venue    = ?1
           AND d.car_type       = ?2
           AND {sess}
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
