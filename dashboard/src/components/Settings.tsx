import { useRef, useState, useEffect } from 'react'
import { useSettingsStore, SETTINGS_DEFAULTS } from '../stores/settingsStore'
import { useElectronicsConfigStore } from '../stores/electronicsConfigStore'
import type { FpsLimit, SpeedUnit, TempUnit, PressureUnit, FuelUnit } from '../stores/settingsStore'
import { colors, fonts } from '../styles/theme'
import BindingDialog from './BindingDialog'

interface Props {
  open: boolean
  onClose: () => void
}

// Human-readable labels for each binding ID
const BINDING_LABELS: Record<string, string> = {
  tc_increase:              'TC +',
  tc_decrease:              'TC −',
  tc_cut_increase:          'TC Cut +',
  tc_cut_decrease:          'TC Cut −',
  tc_slip_increase:         'TC Slip +',
  tc_slip_decrease:         'TC Slip −',
  abs_increase:             'ABS +',
  abs_decrease:             'ABS −',
  engine_map_increase:      'Map +',
  engine_map_decrease:      'Map −',
  farb_increase:            'FARB +',
  farb_decrease:            'FARB −',
  rarb_increase:            'RARB +',
  rarb_decrease:            'RARB −',
  brake_bias_increase:      'Brake Bias +',
  brake_bias_decrease:      'Brake Bias −',
  regen_increase:           'Regen +',
  regen_decrease:           'Regen −',
  brake_migration_increase: 'BMIG +',
  brake_migration_decrease: 'BMIG −',
}

const BINDING_IDS = Object.keys(BINDING_LABELS)

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

function formatBinding(b: { type: string; key?: string; device_index?: number; button?: number } | null | undefined): string {
  if (!b) return '— not assigned —'
  if (b.type === 'keyboard') return `Keyboard ${b.key ?? '?'}`
  if (b.type === 'joystick') return `Joystick ${b.device_index ?? 0} Btn ${(b.button ?? 0) + 1}`
  return '?'
}

export default function Settings({ open, onClose }: Props) {
  const s = useSettingsStore()
  const cfg = useElectronicsConfigStore()
  const importRef = useRef<HTMLInputElement>(null)

  // Which binding_id has the dialog open
  const [dialogBindingId, setDialogBindingId] = useState<string | null>(null)

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

  // ---- Duplicate-binding detection ----
  function findConflict(bindingId: string): string | null {
    const b = cfg.bindings[bindingId]
    if (!b) return null
    for (const [otherId, otherB] of Object.entries(cfg.bindings)) {
      if (otherId === bindingId || !otherB) continue
      if (otherB.type === 'keyboard' && b.type === 'keyboard' && otherB.key === (b as {type:'keyboard';key:string}).key) {
        return BINDING_LABELS[otherId] ?? otherId
      }
      if (otherB.type === 'joystick' && b.type === 'joystick') {
        const bj = b as {type:'joystick';device_index:number;button:number}
        const oj = otherB as {type:'joystick';device_index:number;button:number}
        if (oj.device_index === bj.device_index && oj.button === bj.button) {
          return BINDING_LABELS[otherId] ?? otherId
        }
      }
    }
    return null
  }

  function handleBindClick(bindingId: string) {
    setDialogBindingId(bindingId)
    cfg.startCapture(bindingId)
  }

  function handleDialogClose() {
    setDialogBindingId(null)
  }

  function handleSave() {
    cfg.saveConfig()
    onClose()
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
          </Section>

          {/* Electronics Setup */}
          <Section title="Button Bindings">

            {/* Button bindings */}
            <div style={{
              background: '#141414',
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              overflow: 'hidden',
            }}>
              {BINDING_IDS.map((id, i) => {
                const binding = cfg.bindings[id] ?? null
                const conflict = findConflict(id)
                const isCapturing = cfg.capturing === id
                return (
                  <div
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 8px',
                      borderBottom: i < BINDING_IDS.length - 1 ? `1px solid ${colors.border}` : 'none',
                      background: isCapturing ? `${colors.primary}11` : 'transparent',
                    }}
                  >
                    {/* Label */}
                    <span style={{
                      fontFamily: fonts.body,
                      fontSize: 16,
                      color: colors.textMuted,
                      width: 110,
                      flexShrink: 0,
                    }}>
                      {BINDING_LABELS[id]}
                    </span>

                    {/* Binding display */}
                    <span style={{
                      fontFamily: fonts.mono,
                      fontSize: 15,
                      color: conflict ? '#f97316' : (binding ? colors.text : colors.textMuted),
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                      title={conflict ? `Also assigned to: ${conflict}` : undefined}
                    >
                      {formatBinding(binding)}
                      {conflict && ' ⚠'}
                    </span>

                    {/* Clear button */}
                    <button
                      onClick={() => cfg.clearBinding(id)}
                      disabled={!binding}
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 16,
                        padding: '2px 7px',
                        background: 'transparent',
                        border: `1px solid ${binding ? '#ef4444' : colors.border}`,
                        color: binding ? '#ef4444' : colors.border,
                        borderRadius: 3,
                        cursor: binding ? 'pointer' : 'default',
                        flexShrink: 0,
                      }}
                      title="Clear binding"
                    >
                      ×
                    </button>

                    {/* Bind button */}
                    <button
                      onClick={() => handleBindClick(id)}
                      disabled={cfg.capturing !== null && !isCapturing}
                      style={{
                        fontFamily: fonts.body,
                        fontSize: 15,
                        padding: '3px 10px',
                        background: isCapturing ? `${colors.primary}22` : 'transparent',
                        border: `1px solid ${isCapturing ? colors.primary : colors.primary + '88'}`,
                        color: isCapturing ? colors.primary : colors.primary + 'aa',
                        borderRadius: 3,
                        cursor: cfg.capturing !== null && !isCapturing ? 'not-allowed' : 'pointer',
                        flexShrink: 0,
                        fontWeight: 600,
                      }}
                    >
                      {isCapturing ? '...' : 'Bind'}
                    </button>
                  </div>
                )
              })}
            </div>

            <p style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, margin: '4px 0 0' }}>
              Bindings are active immediately. Save writes the config to disk.
            </p>

            {/* Save status */}
            {cfg.saveStatus !== 'idle' && (
              <div style={{
                fontFamily: fonts.body,
                fontSize: 16,
                color: cfg.saveStatus === 'saved' ? colors.success : colors.danger,
                textAlign: 'center',
              }}>
                {cfg.saveStatus === 'saved' ? 'Saved ✓' : 'Error saving ✗'}
              </div>
            )}

            {/* Save / Cancel */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={handleCancel} style={cancelBtnStyle}>
                Cancel
              </button>
              <button onClick={handleSave} style={saveBtnStyle}>
                Save
              </button>
            </div>
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

      {/* Binding capture dialog */}
      {dialogBindingId !== null && (
        <BindingDialog
          label={BINDING_LABELS[dialogBindingId] ?? dialogBindingId}
          onClose={handleDialogClose}
        />
      )}
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

const saveBtnStyle: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: 18,
  fontWeight: 700,
  padding: '8px 20px',
  background: colors.primary,
  border: 'none',
  color: '#0f0f0f',
  borderRadius: 4,
  cursor: 'pointer',
}

const cancelBtnStyle: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: 18,
  padding: '8px 20px',
  background: colors.bgWidget,
  border: `1px solid ${colors.border}`,
  color: colors.textMuted,
  borderRadius: 4,
  cursor: 'pointer',
}

// Keep compiler happy
void SETTINGS_DEFAULTS
