# Race Engineer — Phase 1 (Foundation)

Bridge-Modul für TTS-basierte Race-Engineer-Ansagen via Piper.

## WebSocket-Protokoll

Alle Nachrichten sind JSON. **Client→Bridge** nutzt `"command"` als Tag-Feld
(konsistent mit anderen Bridge-Commands). **Bridge→Client** nutzt `"type"` (Standard).

### Client → Bridge

```json
{ "command": "engineer_get_status" }

{ "command": "engineer_install_piper" }

{ "command": "engineer_install_voice", "voice_id": "cori-gb-high" }

{ "command": "engineer_uninstall_voice", "voice_id": "danny-us-low" }

{
  "command": "engineer_synthesize",
  "voice_id": "cori-gb-high",
  "text": "Radio check, can you hear me?",
  "request_id": "any-unique-string"
}
```

### Bridge → Client (broadcast an alle Clients)

```json
{
  "type": "EngineerStatus",
  "piper_installed": true,
  "piper_version": "2023.11.14-2",
  "voices": [
    { "voice_id": "cori-gb-high", "installed": true },
    { "voice_id": "danny-us-low", "installed": false }
  ]
}

{
  "type": "EngineerInstallProgress",
  "target": "piper",
  "target_id": null,
  "bytes_downloaded": 12345678,
  "bytes_total": 85000000,
  "stage": "downloading"
}

{
  "type": "EngineerInstallComplete",
  "target": "voice",
  "target_id": "cori-gb-high",
  "success": true,
  "error": null
}

{
  "type": "EngineerAudio",
  "request_id": "any-unique-string",
  "priority": "info",
  "wav_base64": "UklGRiQ...",
  "sample_rate": 22050,
  "duration_ms": 1834,
  "text": "Radio check, can you hear me?"
}
```

## Manueller Test (Browser DevConsole)

```javascript
const ws = new WebSocket("ws://localhost:7437?format=json");

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type?.startsWith("Engineer")) console.log(msg);
};

// Status abfragen
ws.send(JSON.stringify({ command: "engineer_get_status" }));

// Piper installieren
ws.send(JSON.stringify({ command: "engineer_install_piper" }));

// Voice installieren
ws.send(JSON.stringify({ command: "engineer_install_voice", voice_id: "danny-us-low" }));

// Radio Check (Voice muss installiert sein + Piper)
ws.send(JSON.stringify({
  command: "engineer_synthesize",
  voice_id: "danny-us-low",
  text: "Box this lap, box box box.",
  request_id: "test-001"
}));
```

## Voices

| ID | Name | Sprache | Größe |
|----|------|---------|-------|
| `cori-gb-high` | Cori | en-GB | ~110 MB |
| `danny-us-low` | Danny | en-US | ~25 MB |
| `northern-male-gb-medium` | Northern English | en-GB | ~60 MB |
| `joe-us-medium` | Joe | en-US | ~60 MB |

## Frontend Sample-MP3s

**Wichtig vor dem Frontend-Release**: Die vier Preview-MP3s müssen unter
`dashboard/public/samples/race-engineer/` liegen:

```
cori-gb-high.mp3
danny-us-low.mp3
northern-male-gb-medium.mp3
joe-us-medium.mp3
```

Quelle: https://rhasspy.github.io/piper-samples/ — pro Voice den `speaker_0.mp3`-Link
manuell herunterladen. Die Datei für `northern-male-gb-medium` ist bereits als
`northern-male-gb-high.mp3` im Repo vorhanden — ersetzen falls nötig.

## Upgrading Piper

The Piper version is pinned in `bridge/src/race_engineer/config.rs`:

```rust
pub const PIPER_VERSION: &str = "2023.11.14-2";
pub const PIPER_WINDOWS_ZIP_URL: &str = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
```

To upgrade to a new Piper release:

1. Check https://github.com/rhasspy/piper/releases for the new release tag.
2. Verify the asset `piper_windows_amd64.zip` exists for that tag.
3. Open the download URL in a browser to confirm it loads (no 404):
   `https://github.com/rhasspy/piper/releases/download/<TAG>/piper_windows_amd64.zip`
4. Update both constants in `config.rs` to the new tag. Keep them in sync — the version string is for logging/status only, the URL is what gets downloaded.
5. Build and run a fresh install (delete `%APPDATA%\LMUPitwall\piper\` first) to verify the new binary works.
6. Bump the LMU Pitwall version and ship a release.

> Users will only get the new Piper version when they update LMU Pitwall. There is no auto-upgrade.

## Pfade (Windows)

| Ressource | Pfad |
|-----------|------|
| Piper-Executable | `%APPDATA%\LMUPitwall\piper\piper.exe` |
| Voice-Modelle | `%APPDATA%\LMUPitwall\voices\<id>.onnx` |
| Voice-Configs | `%APPDATA%\LMUPitwall\voices\<id>.onnx.json` |
