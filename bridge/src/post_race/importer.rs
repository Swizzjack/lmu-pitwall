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

    // These three run on every import, not just when something new landed:
    // each depends on knowledge that arrives later than the sessions it fixes
    // (a name learned from a race driven today identifies the player in an
    // online result imported last month), and all three are idempotent.
    learn_player_identities(db).context("learning player identities")?;
    resolve_local_player(db).context("resolving the local player")?;
    let filled = backfill_live_laps(db).context("backfilling live lap data")?;
    if filled > 0 {
        tracing::info!(laps = filled, "filled fuel/tire data from live capture");
    }

    Ok(res)
}

// ---------------------------------------------------------------------------
// 3b. Player identity
// ---------------------------------------------------------------------------

/// Records the player's name from results where `isPlayer` is unambiguous.
///
/// Offline exactly one driver carries `isPlayer=1`, so that name is the local
/// player's. Online *every* human carries it, so those sessions teach us
/// nothing and are excluded — which is precisely why we need this table.
fn learn_player_identities(db: &Connection) -> Result<()> {
    let mut stmt = db.prepare(
        "SELECT d.name, COUNT(*)
         FROM drivers d
         WHERE d.is_player = 1
           AND d.name != ''
           AND COALESCE((SELECT s.setting FROM sessions s WHERE s.id = d.session_id), '')
               != 'Multiplayer'
           AND (SELECT COUNT(*) FROM drivers x
                WHERE x.session_id = d.session_id AND x.is_player = 1) = 1
         GROUP BY d.name",
    )?;
    let names: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for (name, _count) in names {
        // Deliberately not passing the session count as seen_count: this runs
        // on every import over the same rows, so counting would inflate.
        // Presence in the table is what matters, not how often.
        db.execute(
            "INSERT INTO player_identity (name, source, seen_count, last_seen)
             VALUES (?1, 'xml', 1, NULL)
             ON CONFLICT(name) DO NOTHING",
            rusqlite::params![name],
        )
        .context("INSERT player_identity from xml")?;
    }

    // A name from shared memory or an offline result is direct evidence. Once
    // any of it exists, a guess made in its absence has no business surviving.
    db.execute(
        "DELETE FROM player_identity WHERE source = 'derived'
         AND EXISTS (SELECT 1 FROM player_identity WHERE source != 'derived')",
        [],
    )
    .context("dropping superseded derived identity")?;

    derive_identity_from_attendance(db)
}

/// Last resort for a database that has only ever seen online results: work out
/// who we are from attendance.
///
/// Everyone else on a public server comes and goes; the one driver in *every*
/// session is the one whose PC wrote the files. That is a guess, not evidence,
/// so it is hedged three ways — it runs only when nothing better is known, it
/// needs [`MIN_SESSIONS_FOR_ATTENDANCE`] sessions to have any force, and a tie
/// makes it abstain rather than pick. A league regular who never missed a race
/// produces a tie, not a wrong answer.
fn derive_identity_from_attendance(db: &Connection) -> Result<()> {
    let known: i64 =
        db.query_row("SELECT COUNT(*) FROM player_identity", [], |r| r.get(0))?;
    if known > 0 {
        return Ok(());
    }

    let sessions: i64 = db.query_row(
        "SELECT COUNT(*) FROM sessions WHERE setting = 'Multiplayer'",
        [],
        |r| r.get(0),
    )?;
    if sessions < MIN_SESSIONS_FOR_ATTENDANCE {
        return Ok(());
    }

    let candidates: Vec<String> = {
        let mut stmt = db.prepare(
            "SELECT d.name FROM drivers d
             JOIN sessions s ON s.id = d.session_id
             WHERE s.setting = 'Multiplayer' AND d.name != ''
             GROUP BY d.name
             HAVING COUNT(DISTINCT d.session_id) = ?1",
        )?;
        let v = stmt
            .query_map(rusqlite::params![sessions], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        v
    };

    match candidates.as_slice() {
        [name] => {
            tracing::info!(
                name = %name,
                sessions,
                "identified the player by attendance — the only driver present in every online session"
            );
            db.execute(
                "INSERT INTO player_identity (name, source, seen_count, last_seen)
                 VALUES (?1, 'derived', 1, NULL)
                 ON CONFLICT(name) DO NOTHING",
                rusqlite::params![name],
            )
            .context("INSERT derived player_identity")?;
        }
        many => tracing::debug!(
            candidates = many.len(),
            "attendance does not single out a player"
        ),
    }
    Ok(())
}

/// Works out which driver in each session is *us*, and writes that to
/// `is_self`.
///
/// `is_player` is left exactly as the XML wrote it, because it is not wrong:
/// it marks a human rather than an AI, which offline happens to single out the
/// local player and online does not. Overwriting it would throw away a true
/// fact to record a different one, so the two live in separate columns.
///
/// Offline, `is_self` simply follows `is_player`. Online it is the name match.
/// Either way the value is recomputed from scratch on every import rather than
/// edited in place, which makes the pass idempotent and self-healing: an online
/// race imported before we knew the player's name is corrected on the next
/// import after we learn it.
fn resolve_local_player(db: &Connection) -> Result<()> {
    // A session predating the `setting` column has no marker, but more than one
    // human is itself proof of multiplayer: offline only ever has one.
    const IS_MULTIPLAYER: &str = "s.setting = 'Multiplayer'
         OR (SELECT COUNT(*) FROM drivers x
             WHERE x.session_id = s.id AND x.is_player = 1) > 1";

    let target = format!(
        "CASE
            WHEN (SELECT {IS_MULTIPLAYER} FROM sessions s WHERE s.id = drivers.session_id)
                THEN (name IN (SELECT name FROM player_identity))
            ELSE is_player
         END"
    );

    let changed = db.execute(
        &format!("UPDATE drivers SET is_self = {target} WHERE is_self != {target}"),
        [],
    )?;

    if changed > 0 {
        // A session whose player we cannot name keeps every driver, lap and
        // result — it just has no row marked as ours until the name turns up.
        let unattributed: i64 = db.query_row(
            "SELECT COUNT(*) FROM sessions
             WHERE id NOT IN (SELECT session_id FROM drivers WHERE is_self = 1)",
            [],
            |r| r.get(0),
        )?;
        tracing::info!(
            drivers = changed,
            sessions_without_us = unattributed,
            "resolved which driver is the local player"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 3c. Live-capture backfill
// ---------------------------------------------------------------------------

/// Fills fuel / virtual energy / tire wear on player laps that the XML left
/// empty, from laps captured live while driving.
///
/// Returns the number of lap rows updated.
///
/// Only NULL columns are written, so an offline result — where LMU exports the
/// real numbers — always keeps its own values and this is a no-op. Online,
/// where the XML carries none of these attributes at all, it is the only source.
///
/// The match runs in two steps. First a captured session is *anchored* to an
/// XML driver: the same player name, the same lap numbers, and lap times
/// agreeing to within [`LAP_TIME_TOLERANCE`]. Written by the same sim to four
/// decimals, that is a near-unique fingerprint — see [`choose_anchors`] for how
/// a candidate is judged.
///
/// Once anchored, every remaining lap of that session is filled by lap number
/// alone. That second step is what covers the invalidated laps: a lap the
/// result exports as `--.----` has no time to match on, and in a real online
/// race two of twelve laps looked like that — laps that burned fuel like any
/// other and would otherwise stay blank.
fn backfill_live_laps(db: &Connection) -> Result<usize> {
    let candidates = anchor_candidates(db)?;
    let (anchors, mut rejected) = choose_anchors(candidates);

    // A capture that never even reached the candidate query — its driver name
    // matches no result, or no result has any lap it shares a number with —
    // has no rejection of its own to report. Name it explicitly: silence here
    // is the failure that is hardest to tell from having captured nothing.
    let accounted: Vec<String> = anchors
        .iter()
        .map(|(k, _)| k.clone())
        .chain(rejected.iter().map(|(k, _)| k.clone()))
        .collect();
    for (key, laps) in captured_sessions(db)? {
        if !accounted.contains(&key) {
            rejected.push((
                key,
                format!("no imported result mentions us with these {laps} laps"),
            ));
        }
    }

    for (key, why) in &rejected {
        tracing::info!(
            session = %key,
            reason = %why,
            "live capture could not be tied to a result — fuel/tire data stays empty"
        );
    }

    let mut updated = 0;
    for (session_key, driver_id) in &anchors {
        updated += db
            .execute(
                "UPDATE laps AS l SET
                    fuel_level = COALESCE(l.fuel_level, live.fuel_level),
                    fuel_used  = COALESCE(l.fuel_used,  live.fuel_used),
                    ve_level   = COALESCE(l.ve_level,   live.ve_level),
                    ve_used    = COALESCE(l.ve_used,    live.ve_used),
                    tw_fl      = COALESCE(l.tw_fl,      live.tw_fl),
                    tw_fr      = COALESCE(l.tw_fr,      live.tw_fr),
                    tw_rl      = COALESCE(l.tw_rl,      live.tw_rl),
                    tw_rr      = COALESCE(l.tw_rr,      live.tw_rr)
                 FROM live_laps AS live
                 WHERE live.session_key = ?1
                   AND l.driver_id = ?2
                   AND l.lap_num = live.lap_num
                   -- Touch only rows with something missing, so the count
                   -- reports work done rather than rows re-written with
                   -- their own values.
                   AND (l.fuel_level IS NULL OR l.fuel_used IS NULL
                        OR l.tw_fl IS NULL OR l.tw_fr IS NULL
                        OR l.tw_rl IS NULL OR l.tw_rr IS NULL)",
                rusqlite::params![session_key, driver_id],
            )
            .with_context(|| format!("filling laps from live session {session_key}"))?;
    }
    Ok(updated)
}

/// Every captured session and how many laps it holds.
fn captured_sessions(db: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt =
        db.prepare("SELECT session_key, COUNT(*) FROM live_laps GROUP BY session_key")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("listing captured sessions")?;
    Ok(rows)
}

/// One possible pairing of a captured session with an XML driver, weighed by
/// how the two agree on the laps they both know a time for.
#[derive(Debug, Clone, PartialEq)]
struct AnchorCandidate {
    driver_id: i64,
    session_key: String,
    /// Laps present in both, with times agreeing to within the tolerance.
    hits: i64,
    /// Laps present in both whose times disagree. One is enough to disqualify:
    /// the same driver's same lap cannot have two times.
    misses: i64,
}

/// Every driver row the captured laps could conceivably belong to.
///
/// Deliberately unfiltered by track or session type: LMU's `mTrackName` and the
/// XML's `TrackVenue` are not the same string, and a live `"Practice"` faces a
/// `"Practice1"` in the file. The lap times decide instead — they are the one
/// thing both sources spell identically.
fn anchor_candidates(db: &Connection) -> Result<Vec<AnchorCandidate>> {
    let mut stmt = db.prepare(
        "SELECT d.id, ll.session_key,
                SUM(CASE WHEN ABS(xl.lap_time - ll.lap_time) <= ?1 THEN 1 ELSE 0 END),
                SUM(CASE WHEN ABS(xl.lap_time - ll.lap_time)  > ?1 THEN 1 ELSE 0 END)
         FROM live_laps ll
         JOIN drivers d ON d.name = ll.player_name AND d.is_self = 1
         JOIN laps xl ON xl.driver_id = d.id AND xl.lap_num = ll.lap_num
         WHERE xl.lap_time IS NOT NULL AND ll.lap_time IS NOT NULL
         GROUP BY d.id, ll.session_key",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![LAP_TIME_TOLERANCE], |r| {
            Ok(AnchorCandidate {
                driver_id: r.get(0)?,
                session_key: r.get(1)?,
                hits: r.get(2)?,
                misses: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("reading anchor candidates")?;
    Ok(rows)
}

/// Decides which captured session belongs to which XML driver.
///
/// Returns the accepted `(session_key, driver_id)` pairs, plus the sessions
/// that were left unanchored and why — those are worth logging, because their
/// fuel and tire data is then lost for good.
///
/// A candidate has to survive three questions:
///
/// 1. **Does it agree at all?** At least one lap time in common.
/// 2. **Does it contradict itself?** A single disagreeing lap disqualifies the
///    pairing outright. This is what keeps our own history out: after a season
///    at the same track, some old lap of ours is bound to land within 50 ms of
///    one driven today — but it will differ on the laps around it, while the
///    session we actually drove agrees on all of them.
/// 3. **Is it the only reading?** Two survivors with the same number of
///    agreeing laps are a genuine ambiguity, and guessing there would write
///    one stint's fuel onto another's laps. It abstains instead.
fn choose_anchors(candidates: Vec<AnchorCandidate>) -> (Vec<(String, i64)>, Vec<(String, String)>) {
    use std::collections::HashMap;

    let mut rejected: Vec<(String, String)> = Vec::new();
    let mut by_session: HashMap<String, Vec<AnchorCandidate>> = HashMap::new();
    for c in candidates {
        by_session.entry(c.session_key.clone()).or_default().push(c);
    }

    let mut best: Vec<AnchorCandidate> = Vec::new();
    for (key, cands) in by_session {
        let mut clean: Vec<AnchorCandidate> =
            cands.into_iter().filter(|c| c.hits > 0 && c.misses == 0).collect();
        clean.sort_by_key(|c| -c.hits);
        match clean.as_slice() {
            [] => rejected.push((key, "no result has laps with these times".into())),
            [only] => best.push(only.clone()),
            [top, second, ..] if top.hits > second.hits => best.push(top.clone()),
            _ => rejected.push((key, "two results fit it equally well".into())),
        }
    }

    // The same driver row can only have been driven once. If two captured
    // sessions claim it, the stronger one wins and the other is dropped rather
    // than merged — a restart mid-session is the usual cause, and its earlier
    // laps are the ones that did not survive into the result.
    let mut claims: HashMap<i64, Vec<AnchorCandidate>> = HashMap::new();
    for c in best {
        claims.entry(c.driver_id).or_default().push(c);
    }

    let mut anchors: Vec<(String, i64)> = Vec::new();
    for (driver_id, mut cands) in claims {
        cands.sort_by_key(|c| -c.hits);
        match cands.as_slice() {
            [only] => anchors.push((only.session_key.clone(), driver_id)),
            [top, second, ..] if top.hits > second.hits => {
                for loser in &cands[1..] {
                    rejected.push((
                        loser.session_key.clone(),
                        "another capture matches the same result more closely".into(),
                    ));
                }
                anchors.push((top.session_key.clone(), driver_id));
            }
            _ => {
                for c in &cands {
                    rejected.push((c.session_key.clone(), "two captures fit the same result".into()));
                }
            }
        }
    }

    anchors.sort();
    rejected.sort();
    (anchors, rejected)
}

/// How far a live lap time may differ from the XML's before we refuse to treat
/// them as the same lap. Both come from the same sim, so this only absorbs
/// rounding.
const LAP_TIME_TOLERANCE: f64 = 0.05;

/// Below this many online sessions, "present in all of them" says nothing —
/// with two races a single shared opponent is unremarkable.
const MIN_SESSIONS_FOR_ATTENDANCE: i64 = 3;

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
            race_time, race_laps, fuel_mult, tire_mult, setting
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
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
            session.setting,
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
            team_name, is_player, is_self, position, class_position,
            best_lap_time, total_laps, pitstops, finish_status, finish_time
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?8,?9,?10,?11,?12,?13,?14)
         -- is_self is seeded from is_player (?7) so an offline import is right
         -- straight away; resolve_local_player then fixes the online ones.",
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
            driver.finish_time,
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
            is_pit, stint_number, elapsed_time,
            ve_level, ve_used
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
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
            lap.ve_level,
            lap.ve_used,
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

    /// Writes the sample into a folder of its own. Scanning is recursive, so a
    /// shared temp dir would let tests import each other's fixtures — which,
    /// running in parallel, they did.
    fn write_sample_xml(test_name: &str) -> PathBuf {
        let path = fixture_dir(test_name).join("sample.xml");
        std::fs::write(&path, SAMPLE_XML).unwrap();
        path
    }

    #[test]
    fn scan_finds_xml_files() {
        let path = write_sample_xml("scan");
        let found = scan_results_folder(path.parent().unwrap());
        assert!(found.iter().any(|p| p == &path));
    }

    #[test]
    fn hash_is_deterministic() {
        let path = write_sample_xml("hash");
        let h1 = compute_file_hash(&path).unwrap();
        let h2 = compute_file_hash(&path).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // hex SHA-256
    }

    #[test]
    fn import_inserts_two_sessions() {
        let path = write_sample_xml("import_two");
        let mut db = init_database(Path::new(":memory:")).unwrap();
        let folder = path.parent().unwrap();

        // We call import directly with the known folder
        let result = import_new_sessions(&mut db, folder).unwrap();
        assert!(result.new_imported >= 2, "Race + Qualify = 2 sessions");
        assert_eq!(result.errors, Vec::<String>::new());
    }

    #[test]
    fn import_is_idempotent() {
        let path = write_sample_xml("idempotent");
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
        let path = write_sample_xml("laps_persisted");
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

    // -----------------------------------------------------------------------
    // Multiplayer: isPlayer is set for every human, and no consumables exist
    // -----------------------------------------------------------------------

    /// A multiplayer result as LMU actually writes it: `Setting` says
    /// Multiplayer, every driver carries `isPlayer=1`, and not one `<Lap>` has
    /// a fuel, VE or tire-wear attribute.
    const MP_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rFactorXML>
  <RaceResults>
    <Setting>Multiplayer</Setting>
    <TrackVenue>Monza</TrackVenue>
    <Race>
      <Driver>
        <Name>Yerin Kim</Name>
        <isPlayer>1</isPlayer>
        <Position>1</Position>
        <Laps>2</Laps>
        <Lap num="1" p="1" FL="0,Medium">95.1000</Lap>
        <Lap num="2" p="1" FL="0,Medium">94.2000</Lap>
      </Driver>
      <Driver>
        <Name>Mirco Gyr</Name>
        <isPlayer>1</isPlayer>
        <Position>2</Position>
        <Laps>3</Laps>
        <Lap num="1" p="2" FL="0,Medium">95.5000</Lap>
        <Lap num="2" p="2" FL="0,Medium">94.0000</Lap>
        <Lap num="3" p="2" FL="0,Medium">--.----</Lap>
      </Driver>
      <Driver>
        <Name>Bas Beets</Name>
        <isPlayer>1</isPlayer>
        <Position>3</Position>
        <Laps>1</Laps>
        <Lap num="1" p="3" FL="0,Medium">96.8000</Lap>
      </Driver>
    </Race>
  </RaceResults>
</rFactorXML>"#;

    /// An offline result: one `isPlayer=1`, and LMU exports the consumables.
    const OFFLINE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rFactorXML>
  <RaceResults>
    <Setting>Race Weekend</Setting>
    <TrackVenue>Sebring</TrackVenue>
    <Race>
      <Driver>
        <Name>Robin Frijns</Name>
        <isPlayer>0</isPlayer>
        <Position>1</Position>
        <Laps>1</Laps>
        <Lap num="1" p="1" fuel="0.900" fuelUsed="0.030" twfl="0.98" twfr="0.98" twrl="0.97" twrr="0.97">108.0</Lap>
      </Driver>
      <Driver>
        <Name>Mirco Gyr</Name>
        <isPlayer>1</isPlayer>
        <Position>2</Position>
        <Laps>1</Laps>
        <Lap num="1" p="2" fuel="0.880" fuelUsed="0.040" twfl="0.96" twfr="0.96" twrl="0.95" twrr="0.95">109.0</Lap>
      </Driver>
    </Race>
  </RaceResults>
</rFactorXML>"#;

    /// Each test gets its own folder — the shared temp dir is scanned
    /// recursively, so fixtures would otherwise leak between tests.
    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lmu_pitwall_test_{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_xml(dir: &Path, name: &str, xml: &str) {
        std::fs::write(dir.join(name), xml).unwrap();
    }

    /// The drivers marked as *us*. `is_player` is deliberately not consulted —
    /// online it is 1 for the whole grid, by design.
    fn is_player_names(db: &Connection) -> Vec<String> {
        let mut stmt = db
            .prepare("SELECT name FROM drivers WHERE is_self = 1 ORDER BY name")
            .unwrap();
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        names
    }

    /// The whole point of keeping `is_player` and `is_self` apart: an online
    /// result is *correct data*. Every driver, position and lap it lists must
    /// survive the import untouched, and `isPlayer` must still say what the
    /// game said — that all three of them were humans, not AI.
    #[test]
    fn an_online_result_is_preserved_exactly_as_the_game_wrote_it() {
        let dir = fixture_dir("mp_preserved");
        write_xml(&dir, "online.xml", MP_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();
        // Import again after the player becomes known, to prove the resolver
        // never edits the results on its way through.
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        import_new_sessions(&mut db, &dir).unwrap();

        let standings: Vec<(String, i64, i64, i64)> = {
            let mut stmt = db
                .prepare(
                    "SELECT d.name, d.position, d.is_player,
                            (SELECT COUNT(*) FROM laps l WHERE l.driver_id = d.id)
                     FROM drivers d
                     JOIN sessions s ON s.id = d.session_id
                     WHERE s.setting = 'Multiplayer'
                     ORDER BY d.position",
                )
                .unwrap();
            let v = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            v
        };

        assert_eq!(
            standings,
            vec![
                ("Yerin Kim".to_string(), 1, 1, 2),
                ("Mirco Gyr".to_string(), 2, 1, 3),
                ("Bas Beets".to_string(), 3, 1, 1),
            ],
            "positions, lap counts and the human flag all stand as imported"
        );

        // Only the derived column singles us out.
        assert_eq!(is_player_names(&db), vec!["Mirco Gyr", "Mirco Gyr"]);
    }

    #[test]
    fn an_unknown_player_leaves_no_one_flagged_in_a_multiplayer_result() {
        let dir = fixture_dir("mp_unknown");
        write_xml(&dir, "race.xml", MP_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        assert!(
            is_player_names(&db).is_empty(),
            "with no known identity, counting 3 strangers as the player is worse \
             than counting none"
        );
    }

    #[test]
    fn the_offline_result_identifies_the_player_in_the_online_one() {
        let dir = fixture_dir("mp_known");
        write_xml(&dir, "online.xml", MP_XML);
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        // Both sessions resolve to the same single human, regardless of the
        // order the folder scan happened to return the two files in.
        assert_eq!(is_player_names(&db), vec!["Mirco Gyr", "Mirco Gyr"]);
    }

    #[test]
    fn learning_the_name_later_repairs_an_already_imported_online_race() {
        let dir = fixture_dir("mp_selfheal");
        write_xml(&dir, "online.xml", MP_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();
        assert!(is_player_names(&db).is_empty());

        // A later offline race teaches us the name; the online session is
        // recomputed from the setting, not from its own broken flags.
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        import_new_sessions(&mut db, &dir).unwrap();

        assert_eq!(is_player_names(&db), vec!["Mirco Gyr", "Mirco Gyr"]);
    }

    #[test]
    fn an_online_result_never_teaches_us_a_name() {
        let dir = fixture_dir("mp_no_learn");
        write_xml(&dir, "online.xml", MP_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        let known: i64 = db
            .query_row("SELECT COUNT(*) FROM player_identity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(known, 0, "20 humans all flagged isPlayer is not evidence");
    }

    // -----------------------------------------------------------------------
    // Identity by attendance, for a database that has only ever seen MP
    // -----------------------------------------------------------------------

    /// An online race with `regulars` present plus one driver unique to it, so
    /// attendance across several of these singles out whoever is in all of them.
    fn mp_race_xml(unique_driver: &str, regulars: &[&str]) -> String {
        let mut drivers = String::new();
        for (i, name) in regulars.iter().chain(std::iter::once(&unique_driver)).enumerate() {
            drivers.push_str(&format!(
                r#"<Driver><Name>{name}</Name><isPlayer>1</isPlayer>
                   <Position>{p}</Position><Laps>1</Laps>
                   <Lap num="1" p="{p}">9{p}.0000</Lap></Driver>"#,
                p = i + 1
            ));
        }
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<rFactorXML><RaceResults><Setting>Multiplayer</Setting><TrackVenue>Monza</TrackVenue>
<Race>{drivers}</Race></RaceResults></rFactorXML>"#
        )
    }

    #[test]
    fn a_history_of_only_online_races_still_reveals_the_player() {
        let dir = fixture_dir("attendance");
        for (i, stranger) in ["Ann", "Bob", "Cid"].iter().enumerate() {
            write_xml(&dir, &format!("r{i}.xml"), &mp_race_xml(stranger, &["Mirco Gyr"]));
        }
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        let identity: Vec<(String, String)> = {
            let mut stmt = db.prepare("SELECT name, source FROM player_identity").unwrap();
            let v = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            v
        };
        assert_eq!(identity, vec![("Mirco Gyr".to_string(), "derived".to_string())]);
        assert_eq!(is_player_names(&db), vec!["Mirco Gyr"; 3]);
    }

    #[test]
    fn two_races_are_not_enough_to_call_it() {
        let dir = fixture_dir("attendance_thin");
        for (i, stranger) in ["Ann", "Bob"].iter().enumerate() {
            write_xml(&dir, &format!("r{i}.xml"), &mp_race_xml(stranger, &["Mirco Gyr"]));
        }
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        let known: i64 = db
            .query_row("SELECT COUNT(*) FROM player_identity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(known, 0, "a shared opponent across two races proves nothing");
    }

    #[test]
    fn a_second_ever_present_driver_makes_it_abstain() {
        let dir = fixture_dir("attendance_tie");
        for (i, stranger) in ["Ann", "Bob", "Cid"].iter().enumerate() {
            write_xml(
                &dir,
                &format!("r{i}.xml"),
                &mp_race_xml(stranger, &["Mirco Gyr", "League Regular"]),
            );
        }
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        let known: i64 = db
            .query_row("SELECT COUNT(*) FROM player_identity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(known, 0, "a tie must not be broken by guessing");
    }

    #[test]
    fn real_evidence_replaces_a_guess() {
        let dir = fixture_dir("attendance_superseded");
        // Three online races whose only constant is someone else entirely.
        for (i, stranger) in ["Ann", "Bob", "Cid"].iter().enumerate() {
            write_xml(&dir, &format!("r{i}.xml"), &mp_race_xml(stranger, &["League Regular"]));
        }
        let mut db = init_database(Path::new(":memory:")).unwrap();
        import_new_sessions(&mut db, &dir).unwrap();
        assert_eq!(is_player_names(&db), vec!["League Regular"; 3], "the guess stands alone");

        // An offline result names us for real.
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        import_new_sessions(&mut db, &dir).unwrap();

        let identity: Vec<String> = {
            let mut stmt = db.prepare("SELECT name FROM player_identity ORDER BY name").unwrap();
            let v = stmt.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect();
            v
        };
        assert_eq!(identity, vec!["Mirco Gyr"], "the guess is dropped, not kept alongside");
        // And the online sessions lose the wrongly flagged regular.
        assert_eq!(is_player_names(&db), vec!["Mirco Gyr"]);
    }

    // -----------------------------------------------------------------------
    // Live-capture backfill
    // -----------------------------------------------------------------------

    fn insert_live(db: &Connection, lap_num: i32, lap_time: f64, fuel: f64, wear: f64) {
        use crate::post_race::live_laps::{insert_live_lap, LiveLap};
        insert_live_lap(
            db,
            &LiveLap {
                session_key: "10/Monza/Race".into(),
                recorded_at: 1785334388,
                track_name: "Monza".into(),
                session_type: "Race".into(),
                player_name: "Mirco Gyr".into(),
                car_class: Some("LMP3".into()),
                lap_num,
                lap_time: Some(lap_time),
                fuel_level: Some(fuel),
                fuel_used: Some(0.03),
                ve_level: None,
                ve_used: None,
                tw_fl: Some(wear),
                tw_fr: Some(wear),
                tw_rl: Some(wear),
                tw_rr: Some(wear),
            },
        )
        .unwrap();
    }

    #[test]
    fn live_capture_fills_the_online_laps_the_xml_left_empty() {
        let dir = fixture_dir("backfill");
        write_xml(&dir, "online.xml", MP_XML);
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        // Captured while driving that same online race. Lap 3 is the one the
        // result invalidated to "--.----": the sim still knew its time, the
        // XML does not, so it can only be reached through the anchor.
        insert_live(&db, 1, 95.5, 0.77, 0.98);
        insert_live(&db, 2, 94.0, 0.74, 0.96);
        insert_live(&db, 3, 94.5, 0.71, 0.94);

        import_new_sessions(&mut db, &dir).unwrap();

        let mut stmt = db
            .prepare(
                "SELECT l.lap_num, l.fuel_level, l.tw_fl FROM laps l
                 JOIN drivers d ON d.id = l.driver_id
                 JOIN sessions s ON s.id = l.session_id
                 WHERE d.is_self = 1 AND s.setting = 'Multiplayer'
                 ORDER BY l.lap_num",
            )
            .unwrap();
        let rows: Vec<(i64, Option<f64>, Option<f64>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert_eq!(
            rows,
            vec![
                (1, Some(0.77), Some(0.98)),
                (2, Some(0.74), Some(0.96)),
                (3, Some(0.71), Some(0.94)),
            ]
        );
    }

    /// The scenario a real history produces: we have driven this track before,
    /// and one old lap of ours happens to fall within the tolerance of one of
    /// today's. That coincidence must not cost us the whole session — the old
    /// session contradicts itself on every other lap, which is what tells the
    /// two apart.
    #[test]
    fn a_coincidence_in_our_own_history_does_not_block_the_match() {
        const OLD_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rFactorXML>
  <RaceResults>
    <Setting>Race Weekend</Setting>
    <TrackVenue>Monza</TrackVenue>
    <Practice1>
      <Driver>
        <Name>Mirco Gyr</Name>
        <isPlayer>1</isPlayer>
        <Position>1</Position>
        <Laps>2</Laps>
        <Lap num="1" p="1" fuel="0.910" fuelUsed="0.030">95.5200</Lap>
        <Lap num="2" p="1" fuel="0.880" fuelUsed="0.030">99.0000</Lap>
      </Driver>
    </Practice1>
  </RaceResults>
</rFactorXML>"#;

        let dir = fixture_dir("backfill_history_collision");
        write_xml(&dir, "online.xml", MP_XML);
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        write_xml(&dir, "old_practice.xml", OLD_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        insert_live(&db, 1, 95.5, 0.77, 0.98);
        insert_live(&db, 2, 94.0, 0.74, 0.96);
        insert_live(&db, 3, 94.5, 0.71, 0.94);

        import_new_sessions(&mut db, &dir).unwrap();

        let filled: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM laps l
                 JOIN sessions s ON s.id = l.session_id
                 JOIN drivers d ON d.id = l.driver_id
                 WHERE s.setting = 'Multiplayer' AND d.is_self = 1
                   AND l.fuel_level IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filled, 3, "one stray old lap time is not a rival session");

        // And the old session keeps the numbers the game exported for it.
        let old_fuel: f64 = db
            .query_row(
                "SELECT l.fuel_level FROM laps l
                 JOIN sessions s ON s.id = l.session_id
                 WHERE s.session_type = 'Practice1' AND l.lap_num = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_fuel, 0.910);
    }

    fn candidate(driver_id: i64, key: &str, hits: i64, misses: i64) -> AnchorCandidate {
        AnchorCandidate { driver_id, session_key: key.into(), hits, misses }
    }

    #[test]
    fn the_anchor_follows_the_weight_of_the_evidence() {
        // A contradicted candidate loses to a clean one, however many laps it
        // happened to agree on.
        let (anchors, rejected) = choose_anchors(vec![
            candidate(1, "s1", 3, 0),
            candidate(2, "s1", 4, 1),
        ]);
        assert_eq!(anchors, vec![("s1".to_string(), 1)]);
        assert!(rejected.is_empty());

        // Two clean candidates that fit equally well: no pick, and it says so.
        let (anchors, rejected) = choose_anchors(vec![
            candidate(1, "s2", 2, 0),
            candidate(2, "s2", 2, 0),
        ]);
        assert!(anchors.is_empty());
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].0, "s2");

        // Nothing agrees at all.
        let (anchors, rejected) = choose_anchors(vec![candidate(1, "s3", 0, 5)]);
        assert!(anchors.is_empty());
        assert_eq!(rejected.len(), 1);

        // One result, two captures claiming it — a restart. The fuller one wins.
        let (anchors, rejected) = choose_anchors(vec![
            candidate(1, "restarted", 2, 0),
            candidate(1, "finished", 9, 0),
        ]);
        assert_eq!(anchors, vec![("finished".to_string(), 1)]);
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].0, "restarted");
    }

    #[test]
    fn a_live_lap_is_not_pinned_on_another_drivers_lap() {
        let dir = fixture_dir("backfill_wrong_driver");
        write_xml(&dir, "online.xml", MP_XML);
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        insert_live(&db, 1, 95.5, 0.77, 0.98);
        import_new_sessions(&mut db, &dir).unwrap();

        let filled_for_others: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM laps l
                 JOIN drivers d ON d.id = l.driver_id
                 WHERE d.is_self = 0 AND l.fuel_level IS NOT NULL
                   AND d.name != 'Robin Frijns'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filled_for_others, 0);
    }

    #[test]
    fn a_lap_time_mismatch_blocks_the_match() {
        let dir = fixture_dir("backfill_mismatch");
        write_xml(&dir, "online.xml", MP_XML);
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        // Right lap number, wrong lap — a different session's lap 1. With no
        // agreeing lap time there is no anchor, so lap 3 stays empty too even
        // though its own lap number would have matched.
        insert_live(&db, 1, 88.0, 0.77, 0.98);
        insert_live(&db, 3, 94.5, 0.71, 0.94);
        import_new_sessions(&mut db, &dir).unwrap();

        let filled: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM laps l
                 JOIN sessions s ON s.id = l.session_id
                 WHERE s.setting = 'Multiplayer' AND l.fuel_level IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filled, 0);
    }

    #[test]
    fn the_games_own_offline_numbers_are_never_overwritten() {
        let dir = fixture_dir("offline_wins");
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        // A live capture of the same lap that disagrees with the export.
        use crate::post_race::live_laps::{insert_live_lap, LiveLap};
        insert_live_lap(
            &db,
            &LiveLap {
                session_key: "10/Sebring/Race".into(),
                recorded_at: 1785334388,
                player_name: "Mirco Gyr".into(),
                lap_num: 1,
                lap_time: Some(109.0),
                fuel_level: Some(0.111),
                fuel_used: Some(0.222),
                tw_fl: Some(0.333),
                ..Default::default()
            },
        )
        .unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        let (fuel, used, tw): (f64, f64, f64) = db
            .query_row(
                "SELECT l.fuel_level, l.fuel_used, l.tw_fl FROM laps l
                 JOIN drivers d ON d.id = l.driver_id
                 WHERE d.is_self = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((fuel, used, tw), (0.880, 0.040, 0.96));
    }

    #[test]
    fn an_offline_session_marks_the_one_human_as_us() {
        let dir = fixture_dir("offline_untouched");
        write_xml(&dir, "offline.xml", OFFLINE_XML);
        let mut db = init_database(Path::new(":memory:")).unwrap();

        import_new_sessions(&mut db, &dir).unwrap();

        assert_eq!(is_player_names(&db), vec!["Mirco Gyr"]);
    }
}
