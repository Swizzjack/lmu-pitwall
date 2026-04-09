//! WebSocket command dispatcher for fuel calculator commands.
//!
//! Must be called from `tokio::task::spawn_blocking` — rusqlite is blocking.

use crate::post_race::database::get_db;
use crate::protocol::messages::{ClientCommand, ServerMessage};

use super::queries::{compute, get_options, ComputeParams};

/// Dispatch a fuel-calculator [`ClientCommand`] to the appropriate query.
pub fn handle_command(cmd: ClientCommand) -> ServerMessage {
    match cmd {
        ClientCommand::FuelCalcInit => fuel_calc_init(),
        ClientCommand::FuelCalcCompute {
            track_venue,
            car_name,
            race_laps,
            race_minutes,
            include_all_versions,
        } => fuel_calc_compute(ComputeParams {
            track_venue,
            car_name,
            race_laps,
            race_minutes,
            include_all_versions,
        }),
        _ => ServerMessage::FuelCalcError {
            message: "Unknown fuel calc command".to_string(),
        },
    }
}

fn fuel_calc_init() -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => {
            return ServerMessage::FuelCalcError {
                message: format!("DB unavailable: {e}"),
            }
        }
    };
    let conn = db.lock();
    match get_options(&conn) {
        Ok(options) => ServerMessage::FuelCalcOptions { options },
        Err(e) => ServerMessage::FuelCalcError {
            message: format!("Options query failed: {e}"),
        },
    }
}

fn fuel_calc_compute(params: ComputeParams) -> ServerMessage {
    let db = match get_db() {
        Ok(db) => db,
        Err(e) => {
            return ServerMessage::FuelCalcError {
                message: format!("DB unavailable: {e}"),
            }
        }
    };
    let conn = db.lock();
    match compute(&conn, params) {
        Ok(result) => ServerMessage::FuelCalcResult { result },
        Err(e) => ServerMessage::FuelCalcError {
            message: e.to_string(),
        },
    }
}
