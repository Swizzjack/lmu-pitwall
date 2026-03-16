# LMU Dashboard

A high-performance, widget-based telemetry dashboard for Le Mans Ultimate (LMU).
Designed for a dedicated monitor (fullscreen PC) or any device via PWA (Android, tablet).

## Architecture

```
LMU (Windows) ──Shared Memory──► Rust Bridge (.exe) ──WebSocket:9000──► React Dashboard (Browser/PWA)
                  REST API (~5Hz) ──────────────────────────────────────►
```

- **Rust Bridge** (`bridge/`): Reads LMU shared memory at 50Hz, broadcasts telemetry via WebSocket at 30Hz
- **React Dashboard** (`dashboard/`): Widget grid with drag & drop, Canvas gauges, PWA support

## Quick Start

### Requirements

- WSL2 with Rust (installed via `rustup`)
- Node.js 18+
- For Windows cross-compilation: `gcc-mingw-w64-x86-64` OR Docker (for `cross`)

### Setup

```bash
# Install dependencies
make install-deps

# Development (React frontend only)
make dev
# → Open http://localhost:5173 in browser
```

### Build for Production

```bash
# Build Rust .exe for Windows (requires gcc-mingw-w64)
make build-bridge

# Alternative: Docker-based cross-compilation (no mingw needed)
make build-bridge-cross

# Build React frontend
make build-dashboard

# Build everything
make build-all
```

### Running

1. Copy `dist/lmu-bridge.exe` to your Windows PC
2. Start LMU (any session)
3. Run `lmu-bridge.exe` — it will wait for LMU to start
4. Open the dashboard in a browser: `http://WINDOWS-PC-IP:5173`
5. For Android: Install as PWA via browser menu

## Monorepo Structure

```
lmu-dashboard/
├── bridge/        # Rust WebSocket data bridge (→ lmu-bridge.exe)
├── dashboard/     # React/TypeScript frontend (PWA)
├── shared/        # Protocol documentation
├── .cross/        # Docker cross-compilation config
├── Makefile       # Build commands
└── README.md
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Data Bridge | Rust, tokio, tokio-tungstenite, MessagePack |
| Shared Memory | Windows Named MMF (windows-sys crate) |
| Frontend | React 18, TypeScript, Vite |
| State | Zustand |
| Layout | react-grid-layout |
| Styling | Tailwind CSS |
| PWA | vite-plugin-pwa |

## Branding

| Token | Value |
|-------|-------|
| Background | `#0f0f0f` |
| Primary | `#facc15` (yellow) |
| Accent | `#f97316` (orange) |
| Fonts | Teko, Roboto Condensed, JetBrains Mono |

## WebSocket Protocol

See [`shared/protocol.md`](shared/protocol.md) for the full message format.

## Cross-Compilation (WSL2 → Windows .exe)

```bash
# Option 1: Direct (requires sudo apt install gcc-mingw-w64-x86-64)
cargo build --target x86_64-pc-windows-gnu --release

# Option 2: Via Docker (no local mingw needed)
cargo install cross
cross build --target x86_64-pc-windows-gnu --release
```

## Task Plan

This project is built in 20 tasks across 5 phases:

- **Phase 1 (Tasks 1–5):** Foundation — Monorepo, Rust structs, shared memory reader, WebSocket server
- **Phase 2 (Tasks 6–10):** Dashboard — React setup, widget grid, Speed/RPM/Gear, Tires, Lap timing
- **Phase 3 (Tasks 11–14):** Widgets — Fuel, Inputs, Standings, Weather
- **Phase 4 (Tasks 15–18):** Polish — Layout presets, PWA, performance, error handling
- **Phase 5 (Tasks 19–20):** Advanced — REST API (Virtual Energy), Electronics (TC/ABS/ARB)
