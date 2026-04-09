use std::path::Path;
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};
use rusqlite::Connection;

use super::importer::{default_results_folder, import_new_sessions};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA: &str = "
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_hash       TEXT    UNIQUE NOT NULL,
    file_path       TEXT    NOT NULL,
    track_venue     TEXT,
    track_course    TEXT,
    track_event     TEXT,
    track_length    REAL,
    game_version    TEXT,
    session_type    TEXT,
    date_time       TEXT,
    race_time       INTEGER,
    race_laps       INTEGER,
    fuel_mult       REAL,
    tire_mult       REAL,
    imported_at     TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    car_type        TEXT,
    car_class       TEXT,
    car_number      INTEGER,
    team_name       TEXT,
    is_player       BOOLEAN NOT NULL DEFAULT 0,
    position        INTEGER,
    class_position  INTEGER,
    best_lap_time   REAL,
    total_laps      INTEGER,
    pitstops        INTEGER,
    finish_status   TEXT,
    finish_time     REAL
);

CREATE TABLE IF NOT EXISTS laps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id       INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    lap_num         INTEGER NOT NULL,
    position        INTEGER,
    lap_time        REAL,
    s1              REAL,
    s2              REAL,
    s3              REAL,
    top_speed       REAL,
    fuel_level      REAL,
    fuel_used       REAL,
    tw_fl           REAL,
    tw_fr           REAL,
    tw_rl           REAL,
    tw_rr           REAL,
    compound_fl     TEXT,
    compound_fr     TEXT,
    compound_rl     TEXT,
    compound_rr     TEXT,
    is_pit          BOOLEAN NOT NULL DEFAULT 0,
    stint_number    INTEGER,
    elapsed_time    REAL,
    ve_level        REAL,
    ve_used         REAL
);

CREATE INDEX IF NOT EXISTS idx_laps_driver_id    ON laps(driver_id);
CREATE INDEX IF NOT EXISTS idx_laps_session_id   ON laps(session_id);
CREATE INDEX IF NOT EXISTS idx_drivers_session_id ON drivers(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_file_hash ON sessions(file_hash);

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type      TEXT    NOT NULL,
    elapsed_time    REAL    NOT NULL,
    driver_name     TEXT,
    driver_id_xml   INTEGER,
    target_name     TEXT,
    severity        REAL,
    penalty_type    TEXT,
    reason          TEXT,
    served          BOOLEAN,
    warning_points  REAL,
    current_points  REAL,
    resolution      TEXT,
    message         TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session_id   ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_driver_name  ON events(driver_name);
";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Thread-safe wrapper around a `rusqlite::Connection`.
///
/// Call `.lock()` to get a `MutexGuard<Connection>` for executing queries.
pub struct PostRaceDb {
    conn: Mutex<Connection>,
}

impl PostRaceDb {
    /// Open (or create) the database at `db_path` and apply the schema.
    pub fn open(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)
            .with_context(|| format!("Failed to open database at {}", db_path.display()))?;
        conn.execute_batch(SCHEMA)
            .context("Failed to apply database schema")?;
        // Migrations: add columns to existing databases (silently ignored if already present).
        conn.execute("ALTER TABLE laps ADD COLUMN elapsed_time REAL", []).ok();
        conn.execute("ALTER TABLE laps ADD COLUMN ve_level REAL", []).ok();
        conn.execute("ALTER TABLE laps ADD COLUMN ve_used REAL", []).ok();
        conn.execute("ALTER TABLE drivers ADD COLUMN finish_time REAL", []).ok();
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Acquire a lock on the underlying connection.
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("PostRaceDb mutex poisoned")
    }

    /// On first call: runs the delta import against the LMU results folder.
    /// On subsequent calls: runs only the delta import (new files since last call).
    ///
    /// Returns a summary of what was imported. Logs errors per file rather than
    /// failing the whole call — a missing results folder is silently ignored.
    pub fn ensure_initialized(&self, custom_path: Option<&std::path::Path>) -> Result<super::importer::ImportResult> {
        let mut conn = self.lock();
        let folder = custom_path
            .map(|p| p.to_path_buf())
            .or_else(default_results_folder)
            .unwrap_or_default();
        let result = import_new_sessions(&mut *conn, &folder)?;
        if result.new_imported > 0 || !result.errors.is_empty() {
            tracing::info!(
                new = result.new_imported,
                skipped = result.skipped,
                errors = result.errors.len(),
                "post-race import complete"
            );
            for err in &result.errors {
                tracing::warn!("import error: {}", err);
            }
        }
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Lazy singleton — initialised on first access
// ---------------------------------------------------------------------------

static DB: OnceLock<PostRaceDb> = OnceLock::new();

/// Returns the path next to the running executable where the DB is stored.
fn default_db_path() -> Result<std::path::PathBuf> {
    let exe = std::env::current_exe().context("Cannot determine executable path")?;
    let dir = exe.parent().context("Executable has no parent directory")?;
    Ok(dir.join("pitwall_results.db"))
}

/// Returns a reference to the global `PostRaceDb`, initialising it on first call.
///
/// The database file is placed next to the running `.exe` as `pitwall_results.db`.
pub fn get_db() -> Result<&'static PostRaceDb> {
    if let Some(db) = DB.get() {
        return Ok(db);
    }
    let path = default_db_path()?;
    let db = PostRaceDb::open(&path)?;
    // If another thread raced us, discard our instance and return theirs.
    Ok(DB.get_or_init(|| db))
}

// ---------------------------------------------------------------------------
// Standalone helper (used in tests / before singleton is set up)
// ---------------------------------------------------------------------------

/// Open an in-memory or file-based database without touching the global singleton.
pub fn init_database(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("Failed to open database at {}", db_path.display()))?;
    conn.execute_batch(SCHEMA)
        .context("Failed to apply database schema")?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_applies_to_in_memory_db() {
        let conn = init_database(Path::new(":memory:")).unwrap();
        // Verify tables exist by querying sqlite_master
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('sessions','drivers','laps','events')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 4, "all four tables should be created");
    }
}
