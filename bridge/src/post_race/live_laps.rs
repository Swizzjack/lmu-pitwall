//! Live per-lap capture of fuel, virtual energy and tire wear.
//!
//! # Why this exists
//!
//! LMU's result XML carries `fuel`/`fuelUsed`/`ve`/`veUsed`/`tw*` attributes on
//! every `<Lap>` — but **only offline**. A multiplayer result has none of them,
//! for any driver, including the local player (measured 2026-07-29: 225 online
//! laps, zero occurrences; 34 offline laps, all present). The server-side
//! `<ClientFuelVisible>` setting is the likely switch and is not ours to change.
//!
//! So for online racing the only source is the sim itself, which hands us all
//! of it at 100 Hz. This module samples the player's values at each S/F
//! crossing and stores one row per lap; [`super::importer::backfill_live_laps`]
//! later merges them into the `laps` rows the XML import created.
//!
//! Offline nothing changes: the XML already has the data, the backfill only
//! ever fills columns that are NULL, so the game's own numbers always win.

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::shared_memory::reader::{ScoringFrame, TelemetryFrame};
use crate::shared_memory::types::bytes_to_str;

/// One completed lap's consumables, in the same units the result XML uses.
#[derive(Debug, Clone, Default)]
pub struct LiveLap {
    pub session_key: String,
    /// Unix seconds at the moment the lap was completed.
    pub recorded_at: i64,
    pub track_name: String,
    pub session_type: String,
    pub player_name: String,
    pub car_class: Option<String>,
    pub lap_num: i32,
    pub lap_time: Option<f64>,
    /// Fraction of a full tank remaining at the line (0.0–1.0), like `fuel=`.
    pub fuel_level: Option<f64>,
    /// Fraction consumed during this lap, like `fuelUsed=`. None across a
    /// refuelling stop, where the difference is not a consumption figure.
    pub fuel_used: Option<f64>,
    /// Virtual energy remaining (0.0–1.0). None for classes without VE.
    pub ve_level: Option<f64>,
    pub ve_used: Option<f64>,
    /// Tread *remaining* per corner (1.0 = new), matching both `twfl=` and
    /// LMU's `mWear`.
    pub tw_fl: Option<f64>,
    pub tw_fr: Option<f64>,
    pub tw_rl: Option<f64>,
    pub tw_rr: Option<f64>,
}

/// Values carried from one S/F crossing to the next to form per-lap deltas.
struct Mark {
    lap_num: i32,
    fuel_level: Option<f64>,
    ve_level: Option<f64>,
}

pub struct LiveLapRecorder {
    session_key: String,
    /// Wall clock when the current session was first seen. Part of the session
    /// key, because session number + track + type repeat across race days and
    /// would otherwise let last week's Monza race overwrite this week's.
    session_started_at: i64,
    /// mTotalLaps on the previous tick; -1 = player not seen yet this session.
    last_laps: i32,
    prev: Option<Mark>,
}

impl LiveLapRecorder {
    pub fn new() -> Self {
        Self {
            session_key: String::new(),
            session_started_at: 0,
            last_laps: -1,
            prev: None,
        }
    }

    /// Feed one scoring + telemetry frame.
    ///
    /// Returns a row to persist when the player crossed the S/F line on this
    /// tick, `None` otherwise — which is almost every call, so the cost of
    /// running this at the scoring rate is a couple of field reads.
    pub fn process(
        &mut self,
        sc: &ScoringFrame,
        tel: Option<&TelemetryFrame>,
        session_type: &str,
    ) -> Option<LiveLap> {
        let info = &sc.mScoringInfo;
        let track = bytes_to_str(&info.mTrackName).to_string();

        // Session transitions reset the deltas — carrying a fuel level across a
        // session boundary would invent a consumption figure out of a refuel.
        // Restarting the *same* session keeps the key, so the re-driven laps
        // replace the abandoned ones instead of accumulating.
        let base_key = format!("{}/{}/{}", info.mSession, track, session_type);
        if !self.session_key.starts_with(&format!("{base_key}/")) {
            self.session_started_at = now_unix();
            self.session_key = format!("{base_key}/{}", self.session_started_at);
            self.last_laps = -1;
            self.prev = None;
        }
        let session_key = self.session_key.clone();

        let player_sc = sc.player()?;
        let total_laps = player_sc.mTotalLaps as i32;

        // Guard against the sentinel / rollback cases the probe runs turned up.
        if !(0..MAX_PLAUSIBLE_LAPS).contains(&total_laps) {
            return None;
        }

        let last = self.last_laps;
        self.last_laps = total_laps;

        // Sample the consumables for this instant.
        let player_id = player_sc.mID;
        let tel_veh = tel.and_then(|t| {
            t.player()
                .or_else(|| t.mVehicles.iter().find(|v| v.mID == player_id))
        });

        let fuel_level = tel_veh.and_then(|v| {
            let (fuel, capacity) = (v.mFuel, v.mFuelCapacity);
            if capacity > 0.0 && fuel >= 0.0 {
                let frac = fuel / capacity;
                (frac <= 1.5).then_some(frac.min(1.0))
            } else {
                None
            }
        });

        // Virtual energy is Hypercar-only — flat zero in an LMP2/LMP3, where
        // recording it as "0% remaining" would be a lie rather than a gap.
        let ve_level = tel_veh
            .map(|v| v.mVirtualEnergy as f64)
            .filter(|ve| *ve > 0.0 && *ve <= 1.0);

        // First sight of the player: seed the deltas without emitting a lap.
        // Doing this before the crossing check is what makes lap 1's fuelUsed
        // available at all.
        if last < 0 {
            self.prev = Some(Mark {
                lap_num: total_laps,
                fuel_level,
                ve_level,
            });
            return None;
        }

        // mID reuse or a session restart inside the same key — drop the deltas.
        if total_laps < last {
            self.prev = Some(Mark {
                lap_num: total_laps,
                fuel_level,
                ve_level,
            });
            return None;
        }

        // Lap 0 → 1 is the first crossing of the race; anything below that is
        // the out-lap / formation lap and has no meaningful lap time.
        if total_laps <= last || total_laps < 1 {
            return None;
        }

        let prev = self.prev.take();
        self.prev = Some(Mark {
            lap_num: total_laps,
            fuel_level,
            ve_level,
        });

        // A consumption figure is only valid across two consecutive crossings,
        // and only when it points downhill — a refuelling stop makes the
        // difference meaningless, so we record the level and drop the delta.
        let delta = |prev_val: Option<f64>, now: Option<f64>| -> Option<f64> {
            let (p, n) = (prev_val?, now?);
            let used = p - n;
            (used >= 0.0).then_some(used)
        };
        let (fuel_used, ve_used) = match &prev {
            Some(m) if m.lap_num == total_laps - 1 => (
                delta(m.fuel_level, fuel_level),
                delta(m.ve_level, ve_level),
            ),
            _ => (None, None),
        };

        let lap_time = Some(player_sc.mLastLapTime).filter(|t| *t > 0.0);
        let player_name = bytes_to_str(&player_sc.mDriverName).to_string();
        if player_name.is_empty() {
            return None;
        }
        let car_class = Some(bytes_to_str(&player_sc.mVehicleClass).to_string())
            .filter(|c| !c.is_empty());

        let tel_wheels = tel_veh.map(|v| v.mWheels);
        let wear = |i: usize| -> Option<f64> {
            tel_wheels
                .as_ref()
                .map(|w| w[i].mWear)
                .filter(|x| (0.0..=1.0).contains(x))
        };

        Some(LiveLap {
            session_key,
            recorded_at: now_unix(),
            track_name: track,
            session_type: session_type.to_string(),
            player_name,
            car_class,
            lap_num: total_laps,
            lap_time,
            fuel_level,
            fuel_used,
            ve_level,
            ve_used,
            tw_fl: wear(0),
            tw_fr: wear(1),
            tw_rl: wear(2),
            tw_rr: wear(3),
        })
    }

    /// Clear all state (session change or game disconnect).
    pub fn reset(&mut self) {
        self.session_key.clear();
        self.session_started_at = 0;
        self.last_laps = -1;
        self.prev = None;
    }
}

impl Default for LiveLapRecorder {
    fn default() -> Self {
        Self::new()
    }
}

/// `mMaxLaps` uses `i32::MAX` for timed races; a lap counter that large means
/// we are reading a sentinel, not a lap.
const MAX_PLAUSIBLE_LAPS: i32 = 9_999;

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Insert one captured lap and note the name it was driven under.
///
/// Re-driving the same lap number in the same session (a restart that keeps the
/// session key) replaces the earlier row rather than failing the insert.
pub fn insert_live_lap(conn: &Connection, lap: &LiveLap) -> Result<()> {
    conn.execute(
        "INSERT INTO live_laps (
            session_key, recorded_at, track_name, session_type,
            player_name, car_class, lap_num, lap_time,
            fuel_level, fuel_used, ve_level, ve_used,
            tw_fl, tw_fr, tw_rl, tw_rr
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
         ON CONFLICT(session_key, lap_num) DO UPDATE SET
            recorded_at = excluded.recorded_at,
            lap_time    = excluded.lap_time,
            fuel_level  = excluded.fuel_level,
            fuel_used   = excluded.fuel_used,
            ve_level    = excluded.ve_level,
            ve_used     = excluded.ve_used,
            tw_fl       = excluded.tw_fl,
            tw_fr       = excluded.tw_fr,
            tw_rl       = excluded.tw_rl,
            tw_rr       = excluded.tw_rr",
        rusqlite::params![
            lap.session_key,
            lap.recorded_at,
            lap.track_name,
            lap.session_type,
            lap.player_name,
            lap.car_class,
            lap.lap_num,
            lap.lap_time,
            lap.fuel_level,
            lap.fuel_used,
            lap.ve_level,
            lap.ve_used,
            lap.tw_fl,
            lap.tw_fr,
            lap.tw_rl,
            lap.tw_rr,
        ],
    )
    .context("INSERT live_lap")?;

    record_player_identity(conn, &lap.player_name, "live", lap.recorded_at)?;
    Ok(())
}

/// Remember a name as the local player's.
///
/// `source` is `"live"` for names read straight out of shared memory and
/// `"xml"` for names derived from an offline result. A live sighting is the
/// stronger evidence and upgrades an existing `"xml"` row.
pub fn record_player_identity(
    conn: &Connection,
    name: &str,
    source: &str,
    seen_at: i64,
) -> Result<()> {
    if name.trim().is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO player_identity (name, source, seen_count, last_seen)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(name) DO UPDATE SET
            seen_count = seen_count + 1,
            last_seen  = MAX(COALESCE(last_seen, 0), excluded.last_seen),
            source     = CASE WHEN excluded.source = 'live' THEN 'live' ELSE source END",
        rusqlite::params![name, source, seen_at],
    )
    .context("INSERT player_identity")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::post_race::database::init_database;
    use crate::shared_memory::types::{rF2ScoringInfo, rF2VehicleScoring, rF2VehicleTelemetry};
    use std::path::Path;

    fn scoring(laps: i16, last_lap_time: f64) -> ScoringFrame {
        let mut info: rF2ScoringInfo = unsafe { std::mem::zeroed() };
        info.mSession = 10;
        info.mTrackName[..5].copy_from_slice(b"Monza");

        let mut v: rF2VehicleScoring = unsafe { std::mem::zeroed() };
        v.mID = 7;
        v.mIsPlayer = 1;
        v.mTotalLaps = laps;
        v.mLastLapTime = last_lap_time;
        v.mDriverName[..9].copy_from_slice(b"Mirco Gyr");
        v.mVehicleClass[..4].copy_from_slice(b"LMP3");

        ScoringFrame {
            mScoringInfo: info,
            mVehicles: vec![v],
        }
    }

    fn telemetry(fuel: f64, ve: f64, wear: f64) -> TelemetryFrame {
        let mut v: rF2VehicleTelemetry = unsafe { std::mem::zeroed() };
        v.mID = 7;
        v.mFuel = fuel;
        v.mFuelCapacity = 100.0;
        v.mVirtualEnergy = ve as f32;
        for w in v.mWheels.iter_mut() {
            w.mWear = wear;
        }
        TelemetryFrame {
            mVehicles: vec![v],
            player_idx: Some(0),
        }
    }

    #[test]
    fn emits_one_row_per_crossing_with_the_delta_since_the_last_one() {
        let mut rec = LiveLapRecorder::new();

        // First sight seeds the deltas without emitting.
        assert!(rec
            .process(&scoring(0, -1.0), Some(&telemetry(80.0, 1.0, 1.0)), "Race")
            .is_none());

        let lap1 = rec
            .process(&scoring(1, 95.5), Some(&telemetry(77.0, 0.96, 0.98)), "Race")
            .expect("crossing emits a lap");
        assert_eq!(lap1.lap_num, 1);
        assert_eq!(lap1.lap_time, Some(95.5));
        assert_eq!(lap1.fuel_level, Some(0.77));
        assert!((lap1.fuel_used.unwrap() - 0.03).abs() < 1e-9);
        // mVirtualEnergy is f32 in the mapping, so the delta carries f32 error.
        assert!((lap1.ve_used.unwrap() - 0.04).abs() < 1e-6);
        assert_eq!(lap1.tw_fl, Some(0.98));
        assert_eq!(lap1.player_name, "Mirco Gyr");
        assert_eq!(lap1.car_class.as_deref(), Some("LMP3"));

        // A tick without a crossing emits nothing.
        assert!(rec
            .process(&scoring(1, 95.5), Some(&telemetry(76.0, 0.95, 0.97)), "Race")
            .is_none());

        let lap2 = rec
            .process(&scoring(2, 94.0), Some(&telemetry(74.0, 0.93, 0.96)), "Race")
            .expect("second crossing");
        assert_eq!(lap2.lap_num, 2);
        assert!((lap2.fuel_used.unwrap() - 0.03).abs() < 1e-9);
    }

    #[test]
    fn refuelling_keeps_the_level_but_drops_the_consumption() {
        let mut rec = LiveLapRecorder::new();
        rec.process(&scoring(0, -1.0), Some(&telemetry(20.0, 1.0, 1.0)), "Race");
        rec.process(&scoring(1, 95.5), Some(&telemetry(17.0, 0.96, 0.98)), "Race");

        // Pit stop during lap 2: fuel goes up, wear resets.
        let lap2 = rec
            .process(&scoring(2, 130.0), Some(&telemetry(90.0, 1.0, 1.0)), "Race")
            .expect("pit lap still recorded");
        assert_eq!(lap2.fuel_level, Some(0.90), "the level is still true");
        assert_eq!(lap2.fuel_used, None, "a refuel is not a consumption figure");
        assert_eq!(lap2.ve_used, None);
        assert_eq!(lap2.tw_fl, Some(1.0), "fresh tires recorded as fresh");
    }

    #[test]
    fn a_session_change_does_not_carry_a_delta_across() {
        let mut rec = LiveLapRecorder::new();
        rec.process(&scoring(0, -1.0), Some(&telemetry(80.0, 1.0, 1.0)), "Practice1");
        rec.process(&scoring(1, 95.5), Some(&telemetry(77.0, 0.96, 0.98)), "Practice1");

        // Same track, new session type → first crossing has no predecessor.
        rec.process(&scoring(0, -1.0), Some(&telemetry(60.0, 1.0, 1.0)), "Race");
        let lap = rec
            .process(&scoring(1, 94.0), Some(&telemetry(57.0, 0.97, 0.99)), "Race")
            .unwrap();
        assert!(lap.session_key.contains("Race"));
        assert!((lap.fuel_used.unwrap() - 0.03).abs() < 1e-9);
    }

    #[test]
    fn virtual_energy_stays_absent_for_classes_without_it() {
        let mut rec = LiveLapRecorder::new();
        rec.process(&scoring(0, -1.0), Some(&telemetry(80.0, 0.0, 1.0)), "Race");
        let lap = rec
            .process(&scoring(1, 95.5), Some(&telemetry(77.0, 0.0, 0.98)), "Race")
            .unwrap();
        assert_eq!(lap.ve_level, None);
        assert_eq!(lap.ve_used, None);
    }

    #[test]
    fn insert_is_idempotent_per_session_and_lap() {
        let conn = init_database(Path::new(":memory:")).unwrap();
        let mut lap = LiveLap {
            session_key: "10/Monza/Race".into(),
            recorded_at: 1785334388,
            player_name: "Mirco Gyr".into(),
            lap_num: 1,
            lap_time: Some(95.5),
            fuel_level: Some(0.77),
            ..Default::default()
        };
        insert_live_lap(&conn, &lap).unwrap();
        lap.fuel_level = Some(0.75);
        insert_live_lap(&conn, &lap).unwrap();

        let (count, fuel): (i64, f64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(fuel_level) FROM live_laps",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1, "the re-drive replaces rather than duplicates");
        assert_eq!(fuel, 0.75);

        let (source, seen): (String, i64) = conn
            .query_row(
                "SELECT source, seen_count FROM player_identity WHERE name = 'Mirco Gyr'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(source, "live");
        assert_eq!(seen, 2);
    }
}
