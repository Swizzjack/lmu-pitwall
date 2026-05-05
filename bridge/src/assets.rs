use rust_embed::RustEmbed;

/// Embeds the compiled React dashboard (dashboard/dist/) into the binary.
/// Run `npm run build` inside the dashboard directory before building the bridge.
#[derive(RustEmbed)]
#[folder = "../dashboard/dist/"]
pub struct Asset;
