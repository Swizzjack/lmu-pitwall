use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "lmu-bridge", about = "Le Mans Ultimate Data Bridge")]
pub struct Config {
    /// WebSocket server port
    #[arg(long, default_value_t = 9000)]
    pub ws_port: u16,

    /// Telemetry broadcast rate in FPS
    #[arg(long, default_value_t = 30)]
    pub telemetry_fps: u32,

    /// Scoring broadcast rate in FPS
    #[arg(long, default_value_t = 20)]
    pub scoring_fps: u32,

    /// Enable LMU REST API polling (Phase 2)
    #[arg(long, default_value_t = false)]
    pub enable_rest_api: bool,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    pub log_level: String,

    /// Do not open the browser automatically on startup
    #[arg(long, default_value_t = false)]
    pub no_browser: bool,
}
