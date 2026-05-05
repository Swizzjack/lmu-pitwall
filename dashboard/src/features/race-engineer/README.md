# Race Engineer — Frontend Module (Phase 3a)

## Overview

| Module | Purpose |
|---|---|
| `RaceEngineerPage.tsx` | Top-level page: routes between Wizard and Settings based on install state |
| `components/SetupWizard.tsx` | 3-step wizard (Piper → Voice → Radio Check) |
| `components/SettingsPanel.tsx` | Main settings view after setup is complete |
| `components/VoiceCard.tsx` | Reusable voice card with install/uninstall/radio-check |
| `audio/AudioEngineerService.ts` | Global singleton: WS connection, priority queue, radio FX, playback |
| `audio/priorityQueue.ts` | 3-tier queue (critical / high / info) with hard caps |
| `audio/radioEffect.ts` | Web Audio API filter chains for 4 radio effect modes |
| `audio/wavDecoder.ts` | Base64 WAV → AudioBuffer |
| `state/engineerSettings.ts` | Zustand store (persisted) for all user settings |
| `state/useEngineerStatus.ts` | Hook that fetches and tracks Piper/voice install status |
| `constants.ts` | Voice definitions, RADIO_CHECK_PHRASE |
| `types.ts` | TypeScript types for all WebSocket messages |

## WebSocket Protocol

**Frontend → Bridge** (`command` field):
```json
{ "command": "engineer_get_status" }
{ "command": "engineer_install_piper" }
{ "command": "engineer_install_voice", "voice_id": "cori-gb-high" }
{ "command": "engineer_uninstall_voice", "voice_id": "cori-gb-high" }
{ "command": "engineer_synthesize", "voice_id": "cori-gb-high", "text": "Box now.", "request_id": "uuid" }
```

**Bridge → Frontend** (`type` field):
```json
{ "type": "engineer_status", "piper_installed": true, "voices": [...] }
{ "type": "engineer_install_progress", "target": "piper", "bytes_downloaded": 1000000, "bytes_total": 25000000, "stage": "downloading" }
{ "type": "engineer_install_complete", "target": "voice", "target_id": "cori-gb-high", "success": true, "error": null }
{ "type": "engineer_audio", "request_id": "uuid", "priority": "info", "wav_base64": "...", "sample_rate": 22050, "duration_ms": 1834, "text": "Box now." }
```

## Manual Testing via Dev Console

```javascript
// Get the WS connection details from settings
const { wsHost, wsPort } = window.__zustand_settingsStore?.getState?.() ?? { wsHost: 'localhost', wsPort: 9000 }

const ws = new WebSocket(`ws://${wsHost}:${wsPort}`)
ws.onopen = () => {
  // Check status
  ws.send(JSON.stringify({ command: 'engineer_get_status' }))

  // Trigger a synthesis (voice must be installed)
  ws.send(JSON.stringify({
    command: 'engineer_synthesize',
    voice_id: 'danny-us-low',
    text: 'Box this lap, box this lap.',
    request_id: crypto.randomUUID()
  }))
}
ws.onmessage = (e) => console.log(JSON.parse(e.data))
```

Simulate an `engineer_audio` message from the console (bypasses bridge — tests queue/FX directly):
```javascript
// Import engineerService from the module (only works if exposed)
// Or trigger via the real bridge connection above.
```

## Priority Queue Test

Send multiple `engineer_synthesize` requests quickly from the console and observe queue ordering:
- `priority: "info"` messages play in FIFO order after current audio
- `priority: "critical"` interrupts current playback (50ms fade-out) and plays immediately

## Phase 2 (coming next)

The Rule Engine will automatically dispatch `engineer_audio` messages from the bridge based on telemetry events. The frontend is already wired to receive and play them.

`FrequencySelect` (low/medium/high) will control which rule categories are active in Phase 2.
