import { useRef, useState, useEffect } from 'react'
import { useSettingsStore, SETTINGS_DEFAULTS } from '../stores/settingsStore'
import type { FpsLimit, InputChartFps, SpeedUnit, TempUnit, PressureUnit, FuelUnit, ClockFormat, DamageDetail, WeatherDetail, TrackMapDetail, BattleMode, BattleValueMode, StandingsClassFilter, StandingsGapMode } from '../stores/settingsStore'
import { colors, fonts } from '../styles/theme'
import { bridgeHttpBase } from '../utils/bridge'

interface Props {
  open: boolean
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Track Maps helpers
// ---------------------------------------------------------------------------

const TRACK_STORAGE_PREFIX = 'lmu-trackmap-'

interface SavedTrackInfo {
  storageKey: string
  trackName:  string
  pointCount: number
  complete:   boolean
}

function getSavedTracks(): SavedTrackInfo[] {
  const tracks: SavedTrackInfo[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(TRACK_STORAGE_PREFIX)) continue
    try {
      const data = JSON.parse(localStorage.getItem(key) ?? '')
      tracks.push({
        storageKey: key,
        trackName:  data.trackName ?? key.replace(TRACK_STORAGE_PREFIX, ''),
        pointCount: data.points?.length ?? 0,
        complete:   data.complete ?? false,
      })
    } catch {
      tracks.push({
        storageKey: key,
        trackName:  key.replace(TRACK_STORAGE_PREFIX, ''),
        pointCount: 0,
        complete:   false,
      })
    }
  }
  return tracks.sort((a, b) => a.trackName.localeCompare(b.trackName))
}

export default function Settings({ open, onClose }: Props) {
  const s = useSettingsStore()
  const importRef = useRef<HTMLInputElement>(null)

  // Track Maps
  const [savedTracks, setSavedTracks] = useState<SavedTrackInfo[]>([])

  useEffect(() => {
    if (open) setSavedTracks(getSavedTracks())
  }, [open])

  // Connection port and internal server port are independent.
  const [portInput, setPortInput] = useState<string>(() => s.wsPort > 0 ? String(s.wsPort) : '')
  const [serverPortInput, setServerPortInput] = useState('')
  const [followServerPort, setFollowServerPort] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [portBusy, setPortBusy] = useState(false)
  const [portStatus, setPortStatus] = useState<string | null>(null)

  useEffect(() => {
    // Sync portInput if external wsPort changes (e.g. importSettings)
    setPortInput(s.wsPort > 0 ? String(s.wsPort) : '')
  }, [s.wsPort])

  function applyConnectionPort() {
    const port = portInput === '' ? 0 : Number(portInput)
    if (portInput !== '' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setConnectionError('Connection port must be between 1 and 65535, or empty for auto.')
      return
    }
    s.update({ wsPort: port })
    // Reconnect every consumer to the saved target.
    window.location.reload()
  }

  async function saveAndRestart() {
    const targetPort = Number(serverPortInput)
    if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
      setPortStatus('Enter an internal server port between 1024 and 65535.')
      return
    }
    // Only redirect when the user explicitly chooses direct access to this origin.
    const redirectUrl = followServerPort && bridgeHttpBase() === window.location.origin
      ? new URL(window.location.href)
      : null
    setPortBusy(true)
    setPortStatus(null)
    try {
      const res = await fetch(`${bridgeHttpBase()}/api/set-port`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: targetPort }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (redirectUrl) {
        redirectUrl.port = String(targetPort)
        s.update({ wsPort: 0 })
        setTimeout(() => { window.location.href = redirectUrl.toString() }, 1500)
        setPortStatus('Restart requested. Opening the new direct address…')
        return
      }
      setPortStatus(`Restart requested on internal port ${targetPort}. With a reverse proxy, update its upstream port and reload this page. For direct access, open the bridge at its new port.`)
    } catch (e) {
      setPortStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
      setPortBusy(false)
    }
  }

  if (!open) return null

  function handleDeleteTrack(storageKey: string) {
    localStorage.removeItem(storageKey)
    setSavedTracks(getSavedTracks())
  }

  function handleCancel() {
    onClose()
  }

  // ---- General settings helpers ----
  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const ok = s.importSettings(text)
      if (!ok) alert('Invalid settings file.')
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function handleExport() {
    const json = s.exportSettings()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'lmu-settings.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleCancel}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 100,
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 480,
        background: '#1a1a1a',
        borderLeft: `1px solid ${colors.border}`,
        zIndex: 101,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}>
          <span style={{ fontFamily: fonts.heading, fontSize: 30, fontWeight: 700, color: colors.primary, letterSpacing: 2 }}>
            SETTINGS
          </span>
          <button onClick={handleCancel} style={btnStyle}>✕</button>
        </div>

        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Units */}
          <Section title="Units">
            <Row label="Speed">
              <SegmentControl
                value={s.speedUnit}
                options={[{ value: 'kmh', label: 'km/h' }, { value: 'mph', label: 'mph' }] as { value: SpeedUnit; label: string }[]}
                onChange={(v) => s.update({ speedUnit: v as SpeedUnit })}
              />
            </Row>
            <Row label="Temperature">
              <SegmentControl
                value={s.tempUnit}
                options={[{ value: 'celsius', label: '°C' }, { value: 'fahrenheit', label: '°F' }] as { value: TempUnit; label: string }[]}
                onChange={(v) => s.update({ tempUnit: v as TempUnit })}
              />
            </Row>
            <Row label="Pressure">
              <SegmentControl
                value={s.pressureUnit}
                options={[{ value: 'bar', label: 'bar' }, { value: 'psi', label: 'psi' }] as { value: PressureUnit; label: string }[]}
                onChange={(v) => s.update({ pressureUnit: v as PressureUnit })}
              />
            </Row>
            <Row label="Fuel">
              <SegmentControl
                value={s.fuelUnit}
                options={[{ value: 'liters', label: 'L' }, { value: 'gallons', label: 'gal' }] as { value: FuelUnit; label: string }[]}
                onChange={(v) => s.update({ fuelUnit: v as FuelUnit })}
              />
            </Row>
            <Row label="Lap Reserve">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="number"
                  value={s.lapReserve}
                  min={0}
                  max={5}
                  step={0.25}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!isNaN(v) && v >= 0 && v <= 5) s.update({ lapReserve: v })
                  }}
                  style={{ ...inputStyle, width: 70 }}
                />
                <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted }}>laps</span>
              </div>
            </Row>
          </Section>

          <Section title="Connection">
            <label htmlFor="bridge-host" style={connectionLabelStyle}>Bridge Host</label>
            <input
              id="bridge-host" type="text" value={s.wsHost} disabled={portBusy}
              placeholder="auto" onChange={(e) => s.update({ wsHost: e.target.value })}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
            />
            <p style={{ ...connectionHelpStyle, overflowWrap: 'anywhere' }}>
              Auto host: {window.location.hostname}
            </p>
            <label htmlFor="connection-port" style={connectionLabelStyle}>Connection Port</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input
                id="connection-port" type="number" value={portInput} min={1} max={65535} placeholder="auto"
                onChange={(e) => { setPortInput(e.target.value); setConnectionError(null) }}
                style={{ ...inputStyle, width: 110, flexShrink: 0, boxSizing: 'border-box' }} disabled={portBusy}
              />
              <button onClick={applyConnectionPort} disabled={portBusy} style={connectionButtonStyle}>
                Apply
              </button>
            </div>
            {connectionError && <p role="alert" style={{ ...connectionHelpStyle, color: '#f87171' }}>{connectionError}</p>}
            <p style={connectionHelpStyle}>
              Empty means automatic. Apply reloads the dashboard; the bridge keeps running.
              Behind a reverse proxy, use Auto or its public port.
            </p>
          </Section>

          <details style={{ marginBottom: 24 }}>
            <summary style={{ ...connectionLabelStyle, cursor: 'pointer', padding: '8px 0' }}>
              Advanced: Bridge Server
            </summary>
            <div style={{ display: 'grid', gap: 10, paddingTop: 12 }}>
              <label htmlFor="server-port" style={connectionLabelStyle}>New Internal Port</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <input
                  id="server-port" type="number" value={serverPortInput} min={1024} max={65535} placeholder="9000"
                  onChange={(e) => { setServerPortInput(e.target.value); setPortStatus(null) }}
                  style={{ ...inputStyle, width: 110, flexShrink: 0, boxSizing: 'border-box' }} disabled={portBusy}
                />
                <button onClick={saveAndRestart} disabled={portBusy || serverPortInput === ''} style={connectionButtonStyle}>
                  {portBusy ? 'Restart requested' : 'Save & Restart'}
                </button>
              </div>
              <label style={{ ...connectionLabelStyle, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input
                  type="checkbox" style={{ marginTop: 5, flexShrink: 0 }}
                  checked={followServerPort && bridgeHttpBase() === window.location.origin}
                  disabled={portBusy || bridgeHttpBase() !== window.location.origin}
                  onChange={(e) => setFollowServerPort(e.target.checked)}
                />
                Open new port after restart
              </label>
              <p style={connectionHelpStyle}>
                Direct access only. Leave unchecked behind a reverse proxy.
              </p>
              <p style={connectionHelpStyle}>
                Changing the server port disconnects all clients. Update the proxy's upstream port afterward.
                The public address stays unchanged unless the option above is selected.
              </p>
              {portStatus && <p role="status" style={connectionHelpStyle}>{portStatus}</p>}
            </div>
          </details>
          {/* Theme */}
          <Section title="Theme">
            <Row label="Primary color">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={s.primaryColor}
                  onChange={(e) => s.update({ primaryColor: e.target.value })}
                  style={{ width: 36, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                />
                <span style={{ fontFamily: fonts.mono, fontSize: 16, color: colors.textMuted }}>{s.primaryColor}</span>
              </div>
            </Row>
            <Row label="Accent color">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="color"
                  value={s.accentColor}
                  onChange={(e) => s.update({ accentColor: e.target.value })}
                  style={{ width: 36, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                />
                <span style={{ fontFamily: fonts.mono, fontSize: 16, color: colors.textMuted }}>{s.accentColor}</span>
              </div>
            </Row>
          </Section>

          {/* Performance */}
          <Section title="Performance">
            <Row label="FPS Limit">
              <SegmentControl
                value={String(s.fpsLimit)}
                options={[
                  { value: '0', label: 'Unlocked' },
                  { value: '60', label: '60' },
                  { value: '30', label: '30' },
                ]}
                onChange={(v) => s.update({ fpsLimit: Number(v) as FpsLimit })}
              />
            </Row>
            <Row label="Input Chart FPS">
              <SegmentControl
                value={String(s.inputChartFps)}
                options={[
                  { value: '60', label: '60' },
                  { value: '30', label: '30' },
                  { value: '15', label: '15' },
                ]}
                onChange={(v) => s.update({ inputChartFps: Number(v) as InputChartFps })}
              />
            </Row>
          </Section>

          {/* Time Widget */}
          <Section title="Time Widget">
            <Row label="Computer Time">
              <SegmentControl
                value={s.timeWidgetShowComputerTime ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ timeWidgetShowComputerTime: v === 'on' })}
              />
            </Row>
            <Row label="Clock Format">
              <SegmentControl
                value={s.timeWidgetClockFormat}
                options={[{ value: '24h', label: '24h' }, { value: '12h', label: '12h' }] as { value: ClockFormat; label: string }[]}
                onChange={(v) => s.update({ timeWidgetClockFormat: v as ClockFormat })}
              />
            </Row>
            <Row label="Session Elapsed">
              <SegmentControl
                value={s.timeWidgetShowSessionElapsed ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ timeWidgetShowSessionElapsed: v === 'on' })}
              />
            </Row>
            <Row label="Time Remaining">
              <SegmentControl
                value={s.timeWidgetShowTimeRemaining ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ timeWidgetShowTimeRemaining: v === 'on' })}
              />
            </Row>
            <Row label="Current Lap Time">
              <SegmentControl
                value={s.timeWidgetShowCurrentLap ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ timeWidgetShowCurrentLap: v === 'on' })}
              />
            </Row>
          </Section>

          {/* Weather Widget */}
          <Section title="Weather Widget">
            <Row label="Detail Level">
              <SegmentControl
                value={s.weatherDetail}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'full', label: 'Full' },
                ] as { value: WeatherDetail; label: string }[]}
                onChange={(v) => s.update({ weatherDetail: v as WeatherDetail })}
              />
            </Row>
          </Section>

          {/* Damage Widget */}
          <Section title="Damage Widget">
            <Row label="Detail Level">
              <SegmentControl
                value={s.damageDetail}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'full', label: 'Full' },
                ] as { value: DamageDetail; label: string }[]}
                onChange={(v) => s.update({ damageDetail: v as DamageDetail })}
              />
            </Row>
          </Section>

          {/* Track Map Widget */}
          <Section title="Track Map Widget">
            <Row label="Detail Level">
              <SegmentControl
                value={s.trackMapDetail}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'full', label: 'Full' },
                ] as { value: TrackMapDetail; label: string }[]}
                onChange={(v) => s.update({ trackMapDetail: v as TrackMapDetail })}
              />
            </Row>
          </Section>

          {/* Standings Widget */}
          <Section title="Standings Widget">
            <Row label="Classes Shown">
              <SegmentControl
                value={s.standingsClassFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'own', label: 'My Class' },
                ] as { value: StandingsClassFilter; label: string }[]}
                onChange={(v) => s.update({ standingsClassFilter: v as StandingsClassFilter })}
              />
            </Row>
            <Row label="Gap To">
              <SegmentControl
                value={s.standingsGapMode}
                options={[
                  { value: 'overall', label: 'Leader' },
                  { value: 'class', label: 'Class Leader' },
                ] as { value: StandingsGapMode; label: string }[]}
                onChange={(v) => s.update({ standingsGapMode: v as StandingsGapMode })}
              />
            </Row>
            <Row label="Compound">
              <SegmentControl
                value={s.standingsShowCompound ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ standingsShowCompound: v === 'on' })}
              />
            </Row>
            <Row label="Car Type">
              <SegmentControl
                value={s.standingsShowCarType ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ standingsShowCarType: v === 'on' })}
              />
            </Row>
            <Row label="Virtual Energy">
              <SegmentControl
                value={s.standingsShowVE ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ standingsShowVE: v === 'on' })}
              />
            </Row>
            <Row label="Damage">
              <SegmentControl
                value={s.standingsShowDamage ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ standingsShowDamage: v === 'on' })}
              />
            </Row>
          </Section>

          {/* Proximity Widget (Battle / Relative) */}
          <Section title="Proximity Widget">
            <Row label="Mode">
              <SegmentControl
                value={s.battleMode}
                options={[
                  { value: 'battle', label: 'Battle' },
                  { value: 'relative', label: 'Relative' },
                ] as { value: BattleMode; label: string }[]}
                onChange={(v) => s.update({ battleMode: v as BattleMode })}
              />
            </Row>
            <Row label="Times">
              <SegmentControl
                value={s.battleValueMode}
                options={[
                  { value: 'absolute', label: 'Absolute' },
                  { value: 'delta', label: 'Δ Player' },
                ] as { value: BattleValueMode; label: string }[]}
                onChange={(v) => s.update({ battleValueMode: v as BattleValueMode })}
              />
            </Row>
            <Row label="Drivers ± Player">
              <SegmentControl
                value={String(s.battleCount)}
                options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]}
                onChange={(v) => s.update({ battleCount: Number(v) })}
              />
            </Row>
            <Row label="Position & No.">
              <SegmentControl
                value={s.battleShowPosName ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ battleShowPosName: v === 'on' })}
              />
            </Row>
            <Row label="Sector Times">
              <SegmentControl
                value={s.battleShowSectors ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ battleShowSectors: v === 'on' })}
              />
            </Row>
            <Row label="Best & Last Lap">
              <SegmentControl
                value={s.battleShowLaps ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ battleShowLaps: v === 'on' })}
              />
            </Row>
            <Row label="Gap">
              <SegmentControl
                value={s.battleShowGap ? 'on' : 'off'}
                options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
                onChange={(v) => s.update({ battleShowGap: v === 'on' })}
              />
            </Row>
          </Section>

          {/* Post Race Results */}
          <Section title="Post Race Results">
            <Row label="Results Folder">
              <input
                type="text"
                value={s.resultsPath}
                placeholder="Default (Steam install)"
                onChange={(e) => s.update({ resultsPath: e.target.value })}
                style={{ ...inputStyle, width: 280, fontSize: 13 }}
                title="Leave empty to use the default LMU Steam path"
              />
            </Row>
            <p style={{ fontFamily: fonts.body, fontSize: 14, color: colors.textMuted, margin: 0, lineHeight: 1.5 }}>
              Custom path to your LMU results folder.<br />
              Example: <span style={{ fontFamily: fonts.mono }}>D:\LMU\UserData\Log\Results</span>
            </p>
          </Section>

          {/* Track Maps */}
          <Section title="Track Maps">
            {savedTracks.length === 0 ? (
              <p style={{ fontFamily: fonts.body, fontSize: 16, color: colors.textMuted, margin: 0, lineHeight: 1.5 }}>
                No track outlines recorded yet.<br />
                Drive a lap on any track to create one automatically.
              </p>
            ) : (
              <div style={{
                background: '#141414',
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                overflow: 'hidden',
              }}>
                {savedTracks.map((t, i) => (
                  <TrackRow
                    key={t.storageKey}
                    track={t}
                    last={i === savedTracks.length - 1}
                    onDelete={() => handleDeleteTrack(t.storageKey)}
                  />
                ))}
              </div>
            )}
            <p style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, margin: '4px 0 0', lineHeight: 1.5 }}>
              Track outlines are recorded automatically while driving.<br />
              Delete one to re-record it on the next session.
            </p>
          </Section>

          {/* Export / Import */}
          <Section title="Backup">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <ActionBtn onClick={handleExport}>Export JSON</ActionBtn>
              <ActionBtn onClick={() => importRef.current?.click()}>Import JSON</ActionBtn>
              <input
                ref={importRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportFile}
                style={{ display: 'none' }}
              />
            </div>
          </Section>

          {/* Reset */}
          <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16 }}>
            <ActionBtn
              onClick={() => { if (confirm('Reset all settings to defaults?')) s.reset() }}
              danger
            >
              Reset to Defaults
            </ActionBtn>
          </div>
        </div>
      </div>

    </>
  )
}

// ---------- helpers ----------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        letterSpacing: 2,
        color: colors.textMuted,
        textTransform: 'uppercase',
        marginBottom: 8,
        borderBottom: `1px solid ${colors.border}`,
        paddingBottom: 4,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontFamily: fonts.body, fontSize: 18, color: colors.text, flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  )
}

function SegmentControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${colors.border}`, borderRadius: 4, overflow: 'hidden' }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            fontFamily: fonts.body,
            fontSize: 16,
            padding: '4px 12px',
            background: value === opt.value ? `${colors.primary}22` : colors.bgWidget,
            color: value === opt.value ? colors.primary : colors.textMuted,
            border: 'none',
            borderLeft: `1px solid ${colors.border}`,
            cursor: 'pointer',
            fontWeight: value === opt.value ? 600 : 400,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function TrackRow({ track, last, onDelete }: { track: SavedTrackInfo; last: boolean; onDelete: () => void }) {
  const [hoverDelete, setHoverDelete] = useState(false)
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '5px 8px',
      borderBottom: last ? 'none' : `1px solid ${colors.border}`,
    }}>
      {/* Track name */}
      <span style={{
        fontFamily: fonts.body,
        fontSize: 16,
        color: colors.text,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {track.trackName}
      </span>

      {/* Point count */}
      <span style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted, flexShrink: 0 }}>
        {track.pointCount.toLocaleString()} pts
      </span>

      {/* Status icon */}
      <span style={{ fontSize: 18, flexShrink: 0, color: track.complete ? '#22c55e' : colors.textMuted }}
        title={track.complete ? 'Complete' : 'Incomplete'}>
        {track.complete ? '✓' : '…'}
      </span>

      {/* Delete button */}
      <button
        onClick={onDelete}
        onMouseEnter={() => setHoverDelete(true)}
        onMouseLeave={() => setHoverDelete(false)}
        title="Delete outline"
        style={{
          background: 'transparent',
          border: `1px solid ${hoverDelete ? '#ef4444' : colors.border}`,
          color: hoverDelete ? '#ef4444' : colors.textMuted,
          borderRadius: 3,
          cursor: 'pointer',
          padding: '2px 8px',
          fontSize: 20,
          lineHeight: 1,
          flexShrink: 0,
          transition: 'border-color 0.15s, color 0.15s',
        }}
      >
        🗑
      </button>
    </div>
  )
}

function ActionBtn({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: fonts.body,
        fontSize: 18,
        padding: '7px 16px',
        background: danger ? '#ef444422' : colors.bgWidget,
        border: `1px solid ${danger ? '#ef4444' : colors.border}`,
        color: danger ? '#ef4444' : colors.text,
        borderRadius: 4,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: colors.textMuted,
  fontSize: 24,
  cursor: 'pointer',
  lineHeight: 1,
  padding: '2px 8px',
}

const inputStyle: React.CSSProperties = {
  background: colors.bgWidget,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  fontFamily: fonts.mono,
  fontSize: 18,
  padding: '4px 8px',
  borderRadius: 3,
  width: 200,
}


// Keep compiler happy
void SETTINGS_DEFAULTS

const connectionLabelStyle: React.CSSProperties = {
  fontFamily: fonts.body, fontSize: 18, color: colors.text,
}
const connectionHelpStyle: React.CSSProperties = {
  fontFamily: fonts.body, fontSize: 15, lineHeight: 1.4, color: colors.textMuted, margin: '6px 0',
}
const connectionButtonStyle: React.CSSProperties = {
  fontFamily: fonts.body, fontSize: 16, padding: '6px 12px', borderRadius: 4,
  background: colors.bgWidget, border: `1px solid ${colors.border}`, color: colors.text,
  cursor: 'pointer', whiteSpace: 'nowrap',
}