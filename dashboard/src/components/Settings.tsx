import { useRef, useState, useEffect } from 'react'
import { useSettingsStore, SETTINGS_DEFAULTS } from '../stores/settingsStore'
import type { FpsLimit, InputChartFps, SpeedUnit, TempUnit, PressureUnit, FuelUnit, ClockFormat } from '../stores/settingsStore'
import { colors, fonts } from '../styles/theme'

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

          {/* Connection */}
          <Section title="Connection">
            <Row label="Bridge Host">
              <input
                type="text"
                value={s.wsHost}
                placeholder={`auto (${window.location.hostname})`}
                onChange={(e) => s.update({ wsHost: e.target.value })}
                style={inputStyle}
              />
            </Row>
            <Row label="Bridge Port">
              <input
                type="number"
                value={s.wsPort}
                min={1}
                max={65535}
                onChange={(e) => s.update({ wsPort: Number(e.target.value) })}
                style={{ ...inputStyle, width: 80 }}
              />
            </Row>
            <p style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, margin: 0 }}>
              Changes take effect on next reconnect or page refresh.
            </p>
          </Section>

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

          {/* Standings Widget */}
          <Section title="Standings Widget">
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
