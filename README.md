# LMU Pitwall

A real-time sim racing dashboard for [Le Mans Ultimate](https://www.lemansultimate.com/), designed to run on a second (or third, or fourth) monitor.

Built with Rust and React. Runs as a single `.exe` — no installation required, no dependencies, no separate server.

![LMU Pitwall Dashboard](docs/screenshots/screenshot-full.png)

## Features

- **Fuel Manager** — Fuel remaining, consumption per lap (median rolling average), laps remaining, and fuel needed to finish. Excludes first lap of each stint for accurate data.
- **Standings** — Live positions with car number, brand, gap to leader, and sector times.
- **Electronics** — TC, ABS, Engine Map, ARB, Regen, and Brake Migration. Reads initial values from the LMU garage API, then tracks button presses on your steering wheel to keep values in sync — works in online sessions.
- **Tires** — Temperatures, pressures, wear percentage, and brake disc temps.
- **Track Map** — SVG-based live track map with vehicle positions, updated in real-time.
- **Post Race Results** — Load any LMU session XML log file and view detailed race results: final classification, lap times, sector times, gaps, and pitstops for all drivers.
- **Drag & Drop Layout** — Arrange and resize widgets however you like. Layout is saved automatically.

## How It Works

LMU Pitwall reads telemetry data from the rF2 Shared Memory buffer that Le Mans Ultimate exposes, combined with LMU's built-in REST API (port 6397) for garage and session data. A Rust backend processes the data and serves a React dashboard via an embedded web server — all in one `.exe`.

The Electronics widget uses a button-counting approach (similar to the community's [LMU Electronic Bridge](https://community.lemansultimate.com/index.php?threads/electronic-bridge-online-and-offline-tcs-abs-regen-arb-motor-map-brake-migration.15765/)) to track TC/ABS/ARB changes during online sessions, where direct memory access is blocked by EasyAntiCheat.

## Download

Grab the latest release from the [Releases page](https://github.com/Swizzjack/lmu-pitwall/releases).

**Option A: Installer** — Download `LMU-Pitwall-Setup-x.x.x.exe` and run it.

**Option B: Portable** — Download `lmu-pitwall.exe` and `config.json`, place them in the same folder, and run the `.exe`.

## Usage

1. Start Le Mans Ultimate
2. Run LMU Pitwall
3. Open a session (Practice, Qualifying, or Race)
4. The dashboard auto-connects and starts showing live data

The dashboard runs at `http://localhost:9000` by default. You can also open it on any device in your local network by navigating to `http://<your-pc-ip>:9000` in a browser (make sure Windows Firewall allows port 9000).

## Electronics Setup

To use the Electronics widget, you need to configure which buttons on your steering wheel correspond to TC+/TC-/ABS+/ABS- etc.

1. Open the Electronics widget settings (gear icon)
2. Click "Assign" next to each function
3. Press the corresponding button on your wheel
4. The binding is saved to `config.json`

The widget reads initial values from LMU's garage API when you enter the car, and tracks changes from there.

## Post Race Results

After a session, you can load the XML log file that LMU automatically saves to review detailed results:

1. Open the Post Race Results view
2. Select an XML session file (found in LMU's `UserData\Log\Results\` folder)
3. Browse the full classification with lap times, sectors, gaps, and pitstop data

## Building from Source

Requires: Rust (with cargo-zigbuild), Node.js, Zig 0.13+
```bash
# In WSL2 — every cargo command needs:
export PATH="$HOME/.local/bin:$PATH" && source ~/.cargo/env

# Install dependencies
cd dashboard && npm install && cd ..

# Build release
make build-release
```

The output is a single `.exe` in `bridge/target/x86_64-pc-windows-gnu/release/`.

## Tech Stack

- **Backend:** Rust — rF2 Shared Memory reader, WebSocket server (port 9000), REST API client, HID input monitoring
- **Frontend:** React + TypeScript — widget-based layout with drag & drop
- **Build:** cargo-zigbuild for Windows cross-compilation from WSL2, rust-embed for single-binary distribution
- **Design:** Dark theme (#0f0f0f background, #facc15 primary, #f97316 accent), Teko / Roboto Condensed / JetBrains Mono fonts

## Credits

Built by [Swizzjack](https://github.com/Swizzjack) with the help of [Claude](https://claude.ai) (Anthropic) for architecture, code generation, and development workflow.

Inspired by the LMU community, particularly the [LMU Electronic Bridge](https://community.lemansultimate.com/index.php?threads/electronic-bridge-online-and-offline-tcs-abs-regen-arb-motor-map-brake-migration.15765/) by nikolaiNr7 for the button-counting approach.

## License

[MIT](LICENSE)
