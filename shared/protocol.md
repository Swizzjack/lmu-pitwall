# LMU Dashboard — WebSocket Protocol

## Transport

- **Protocol:** WebSocket (`ws://HOST:9000`)
- **Format:** MessagePack (binary, compact)
- **Debug mode:** JSON via query param `?format=json`

## Message Types

All messages are tagged with a `type` field.

### `TelemetryUpdate` (~30Hz)

High-frequency per-frame telemetry data.

| Field | Type | Description |
|-------|------|-------------|
| `speed_ms` | f64 | Speed in m/s |
| `rpm` | f64 | Engine RPM |
| `max_rpm` | f64 | Rev limiter RPM |
| `gear` | i32 | -1=Reverse, 0=Neutral, 1-8 |
| `throttle` | f64 | 0.0–1.0 |
| `brake` | f64 | 0.0–1.0 |
| `clutch` | f64 | 0.0–1.0 |
| `steering` | f64 | -1.0 to +1.0 |
| `fuel` | f64 | Liters remaining |
| `fuel_capacity` | f64 | Tank capacity in liters |
| `water_temp` | f64 | °C |
| `oil_temp` | f64 | °C |
| `tires` | TireData[4] | FL, FR, RL, RR |
| `delta_best` | f64 | Delta to best lap (seconds) |

### TireData

| Field | Type | Description |
|-------|------|-------------|
| `temp_inner` | f64 | Inner temperature °C |
| `temp_mid` | f64 | Middle temperature °C |
| `temp_outer` | f64 | Outer temperature °C |
| `pressure` | f64 | kPa |
| `wear` | f64 | 0.0–1.0 (1.0 = new) |
| `brake_temp` | f64 | °C |

### `ScoringUpdate` (~5Hz)

Session and standings data.

### `SessionInfo` (~1Hz)

Track info, weather, session type/duration.

### `ConnectionStatus` (event-based)

Sent when LMU connects or disconnects, and whenever `telemetry_valid` changes.

| Field | Type | Notes |
|---|---|---|
| `game_connected` | bool | |
| `plugin_version` | string | LMU's build number as `1.4.0.0`; `unknown` if unreadable. Named for the plugin era, when it carried a third-party DLL's version |
| `telemetry_valid` | bool | `false` = shared-memory layout drift detected |
| `telemetry_warning` | string \| null | reason, only set when `telemetry_valid` is `false` |

`telemetry_valid` goes `false` when the per-wheel block fails a plausibility
check, which means a game update moved the wheel block inside
`rF2VehicleTelemetry`. Tire and brake readings are garbage in that state.

Consumers must treat the tire block in `Telemetry` as unusable while
`telemetry_valid` is `false` — the bridge keeps sending it rather than dropping
fields, so the flag is the only signal. In this repo: `TireMonitor` greys the
cells out, and the race engineer's tire rules stay silent.
