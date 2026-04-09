import { useState, useRef, useCallback, useEffect } from 'react'
import { decode } from '@msgpack/msgpack'
import { colors, fonts } from '../styles/theme'
import { useSettingsStore } from '../stores/settingsStore'

// ── Types (matching bridge/src/fuel_calculator/types.rs) ─────────────────────

interface CarOption {
  car_class: string | null
  car_name: string | null
  session_count: number
  total_laps: number
}

interface TrackOption {
  track_venue: string
  track_course: string | null
  track_length: number | null
  cars: CarOption[]
}

interface FuelCalcOptionsPayload {
  tracks: TrackOption[]
  game_versions: string[]
  current_version: string | null
}

interface FuelCalcResult {
  track_venue: string
  car_class: string | null
  car_name: string
  sessions_used: number
  laps_used: number
  confidence: string
  version_filter: string
  fuel_mult: number
  avg_fuel_per_lap: number
  fuel_std_dev: number
  total_fuel_needed: number
  fuel_capacity: number | null
  fuel_stint_laps: number | null
  fuel_pit_stops: number | null
  has_ve: boolean
  avg_ve_per_lap: number | null
  ve_std_dev: number | null
  ve_stint_laps: number | null
  ve_pit_stops: number | null
  effective_stint_laps: number | null
  total_pit_stops: number | null
  limiting_factor: string | null
  recommended_start_fuel: number | null
  recommended_start_ve: number | null
}

type FuelCalcMsg =
  | { type: 'FuelCalcOptions'; options: FuelCalcOptionsPayload }
  | { type: 'FuelCalcResult'; result: FuelCalcResult }
  | { type: 'FuelCalcError'; message: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVersion(v: string): string {
  const n = parseFloat(v)
  return isNaN(n) ? v : n.toString()
}

function confidenceColor(c: string): string {
  if (c === 'high')   return colors.success
  if (c === 'medium') return '#eab308'
  return colors.danger
}

// Round to given decimal places and format as string.
function fmt(n: number | null | undefined, dp = 2, suffix = ''): string {
  if (n === null || n === undefined) return '–'
  return `${n.toFixed(dp)}${suffix}`
}

// ── Shared small components ───────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: fonts.body,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      color: colors.textMuted,
      textTransform: 'uppercase',
    }}>
      {children}
    </span>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: colors.bgCard,
      border: `1px solid ${colors.border}`,
      borderRadius: 6,
      padding: '14px 18px',
      ...style,
    }}>
      {children}
    </div>
  )
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: fonts.body,
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 1.5,
      color: colors.primary,
      textTransform: 'uppercase',
      marginBottom: 10,
      paddingBottom: 6,
      borderBottom: `1px solid ${colors.border}`,
    }}>
      {children}
    </div>
  )
}

function StatRow({
  label,
  value,
  badge,
}: {
  label: string
  value: string
  badge?: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '3px 0',
    }}>
      <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {badge}
        <span style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.text }}>{value}</span>
      </div>
    </div>
  )
}

function OverrideBadge() {
  return (
    <span style={{
      fontFamily: fonts.body,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.5,
      color: colors.accent,
      background: colors.accent + '22',
      border: `1px solid ${colors.accent}`,
      borderRadius: 3,
      padding: '0 4px',
    }}>
      OVERRIDE
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FuelCalculator({ onClose }: { onClose: () => void }) {
  const wsRef = useRef<WebSocket | null>(null)

  // Init state
  const [initLoading, setInitLoading] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<TrackOption[]>([])
  const [gameVersions, setGameVersions] = useState<string[]>([])
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  // Selection
  const [selectedTrack, setSelectedTrack] = useState('')
  const [selectedCar, setSelectedCar] = useState('')
  const [distanceMode, setDistanceMode] = useState<'laps' | 'time'>('laps')
  const [distanceValue, setDistanceValue] = useState('')
  const [includeAllVersions, setIncludeAllVersions] = useState(false)
  const [overridesOpen, setOverridesOpen] = useState(false)
  const [fuelOverride, setFuelOverride] = useState('')
  const [veOverride, setVeOverride] = useState('')

  // Results
  const [result, setResult] = useState<FuelCalcResult | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)

  // Derived: cars available for selected track
  const availableCars = selectedTrack
    ? (tracks.find(t => t.track_venue === selectedTrack)?.cars ?? [])
    : []

  const selectedCarOption = availableCars.find(c => c.car_name === selectedCar) ?? null

  const canCalculate =
    selectedTrack !== '' &&
    selectedCar !== '' &&
    distanceValue !== '' &&
    !isNaN(parseFloat(distanceValue)) &&
    parseFloat(distanceValue) > 0

  // ── WebSocket ───────────────────────────────────────────────────────────────

  const sendCmd = useCallback((cmd: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd))
    }
  }, [])

  function handleMsg(msg: FuelCalcMsg) {
    if (msg.type === 'FuelCalcOptions') {
      setTracks(msg.options.tracks)
      setGameVersions(msg.options.game_versions)
      setCurrentVersion(msg.options.current_version)
      setInitLoading(false)
    } else if (msg.type === 'FuelCalcResult') {
      setResult(msg.result)
      setCalcLoading(false)
      setCalcError(null)
    } else if (msg.type === 'FuelCalcError') {
      if (initLoading) {
        setInitError(msg.message)
        setInitLoading(false)
      } else {
        setCalcError(msg.message)
        setCalcLoading(false)
      }
    }
  }

  useEffect(() => {
    const { wsHost, wsPort } = useSettingsStore.getState()
    const host = (wsHost || '').trim() || window.location.hostname
    const url = `ws://${host}:${wsPort}`
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      ws.send(JSON.stringify({ command: 'fuel_calc_init' }))
    }

    ws.onmessage = (event) => {
      try {
        let msg: FuelCalcMsg
        if (event.data instanceof ArrayBuffer) {
          msg = decode(new Uint8Array(event.data)) as FuelCalcMsg
        } else {
          msg = JSON.parse(event.data as string) as FuelCalcMsg
        }
        handleMsg(msg)
      } catch { /* malformed */ }
    }

    ws.onerror = () => {
      setInitError('WebSocket connection failed.')
      setInitLoading(false)
    }

    ws.onclose = () => {
      if (initLoading) {
        setInitError('Connection to bridge lost.')
        setInitLoading(false)
      }
    }

    return () => {
      ws.onclose = null
      ws.close()
      wsRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────────────

  function handleTrackChange(venue: string) {
    setSelectedTrack(venue)
    setSelectedCar('')
    setResult(null)
    setCalcError(null)
  }

  function handleCarChange(carName: string) {
    setSelectedCar(carName)
    setResult(null)
    setCalcError(null)
  }

  function handleCalculate() {
    if (!canCalculate) return
    setCalcLoading(true)
    setCalcError(null)
    setResult(null)

    const cmd: Record<string, unknown> = {
      command: 'fuel_calc_compute',
      track_venue: selectedTrack,
      car_name: selectedCar,
      include_all_versions: includeAllVersions,
    }

    const distNum = parseFloat(distanceValue)
    if (distanceMode === 'laps') {
      cmd.race_laps = Math.round(distNum)
    } else {
      cmd.race_minutes = distNum
    }

    sendCmd(cmd)
  }

  // ── Override-applied display values ─────────────────────────────────────────

  const fuelOvNum = fuelOverride !== '' ? parseFloat(fuelOverride) : null
  const veOvNum   = veOverride   !== '' ? parseFloat(veOverride) / 100 : null // input: %, stored: fraction

  const isOverrideFuel = fuelOvNum !== null && !isNaN(fuelOvNum) && fuelOvNum > 0
  const isOverrideVe   = veOvNum   !== null && !isNaN(veOvNum)   && veOvNum   > 0

  const effectiveFuelPerLap = isOverrideFuel ? fuelOvNum! : (result?.avg_fuel_per_lap ?? 0)
  const effectiveVePerLap   = isOverrideVe   ? veOvNum!   : (result?.avg_ve_per_lap ?? null)

  // Back-compute race laps from result (needed for pit stop re-calc when overriding).
  const raceLaps = result && result.avg_fuel_per_lap > 0
    ? Math.ceil(result.total_fuel_needed / result.avg_fuel_per_lap)
    : null

  const displayTotalFuel = result
    ? (isOverrideFuel && raceLaps ? effectiveFuelPerLap * raceLaps : result.total_fuel_needed)
    : null

  const displayFuelStint = result?.fuel_capacity && effectiveFuelPerLap > 0
    ? Math.floor(result.fuel_capacity / effectiveFuelPerLap)
    : result?.fuel_stint_laps ?? null

  const displayFuelPits = displayFuelStint && raceLaps
    ? Math.max(0, Math.ceil(raceLaps / displayFuelStint) - 1)
    : result?.fuel_pit_stops ?? null

  const displayVeStint = effectiveVePerLap && effectiveVePerLap > 0
    ? Math.floor(1.0 / effectiveVePerLap)
    : result?.ve_stint_laps ?? null

  const displayVePits = displayVeStint && raceLaps
    ? Math.max(0, Math.ceil(raceLaps / displayVeStint) - 1)
    : result?.ve_pit_stops ?? null

  const displayEffectiveStint = (displayFuelStint !== null && displayVeStint !== null)
    ? Math.min(displayFuelStint, displayVeStint)
    : displayFuelStint ?? displayVeStint ?? result?.effective_stint_laps ?? null

  const displayTotalPits = (displayFuelPits !== null && displayVePits !== null)
    ? Math.max(displayFuelPits, displayVePits)
    : displayFuelPits ?? displayVePits ?? result?.total_pit_stops ?? null

  const displayStartFuel = result?.fuel_capacity
    ? (() => {
        const firstStint = displayFuelStint && displayFuelPits && displayFuelPits > 0
          ? displayFuelStint
          : (raceLaps ?? 0)
        const needed = effectiveFuelPerLap * firstStint * 1.05
        return Math.min(needed, result.fuel_capacity!)
      })()
    : (displayTotalFuel ? displayTotalFuel * 1.05 : null)

  // ── Render ──────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    background: '#111',
    border: `1px solid ${colors.border}`,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 14,
    padding: '6px 10px',
    borderRadius: 4,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    cursor: 'pointer',
    fontFamily: fonts.body,
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      overflow: 'hidden',
      background: colors.bg,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 18px',
        background: colors.bgCard,
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: `1px solid ${colors.border}`,
            color: colors.textMuted,
            fontFamily: fonts.body,
            fontSize: 14,
            padding: '4px 12px',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ← Back
        </button>
        <span style={{
          fontFamily: fonts.body,
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: 2,
          color: colors.primary,
          textTransform: 'uppercase',
        }}>
          ⛽ Fuel Calculator
        </span>
        {currentVersion && (
          <span style={{
            fontFamily: fonts.mono,
            fontSize: 12,
            color: colors.textMuted,
          }}>
            DB version: {fmtVersion(currentVersion)}
          </span>
        )}
      </div>

      {/* Body */}
      {initLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: colors.textMuted, fontFamily: fonts.body, fontSize: 14 }}>
          Loading historical data…
        </div>
      ) : initError ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: colors.danger, fontFamily: fonts.body, fontSize: 14 }}>
          {initError}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '320px 1fr',
          flex: 1,
          overflow: 'hidden',
        }}>
          {/* ── Config Panel ── */}
          <div style={{
            overflowY: 'auto',
            borderRight: `1px solid ${colors.border}`,
            padding: '18px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}>
            {/* Track */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <Label>Track</Label>
              <select
                value={selectedTrack}
                onChange={e => handleTrackChange(e.target.value)}
                style={selectStyle}
              >
                <option value="">— Select track —</option>
                {tracks.map(t => (
                  <option key={t.track_venue} value={t.track_venue}>
                    {t.track_venue}
                    {t.track_course ? ` · ${t.track_course}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Car */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <Label>Car</Label>
              <select
                value={selectedCar}
                onChange={e => handleCarChange(e.target.value)}
                style={{ ...selectStyle, opacity: !selectedTrack ? 0.5 : 1 }}
                disabled={!selectedTrack}
              >
                <option value="">— Select car —</option>
                {availableCars.map(c => (
                  <option key={c.car_name} value={c.car_name ?? ''}>
                    {c.car_name ?? '?'}
                    {c.car_class ? ` (${c.car_class})` : ''}
                  </option>
                ))}
              </select>
              {selectedCarOption && (
                <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted }}>
                  {selectedCarOption.session_count} sessions · {selectedCarOption.total_laps} laps
                </span>
              )}
            </div>

            {/* Distance */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Label>Race Distance</Label>
              <div style={{ display: 'flex', gap: 10 }}>
                {(['laps', 'time'] as const).map(m => (
                  <label key={m} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    cursor: 'pointer',
                    fontFamily: fonts.body,
                    fontSize: 13,
                    color: distanceMode === m ? colors.text : colors.textMuted,
                  }}>
                    <input
                      type="radio"
                      checked={distanceMode === m}
                      onChange={() => { setDistanceMode(m); setDistanceValue('') }}
                      style={{ accentColor: colors.primary }}
                    />
                    {m === 'laps' ? 'Laps' : 'Time (min)'}
                  </label>
                ))}
              </div>
              <input
                type="number"
                min="1"
                placeholder={distanceMode === 'laps' ? 'e.g. 25' : 'e.g. 60'}
                value={distanceValue}
                onChange={e => setDistanceValue(e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* Version filter */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label>Version Filter</Label>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                cursor: 'pointer',
                fontFamily: fonts.body,
                fontSize: 13,
                color: colors.text,
              }}>
                <input
                  type="checkbox"
                  checked={!includeAllVersions}
                  onChange={() => setIncludeAllVersions(v => !v)}
                  style={{ accentColor: colors.primary }}
                />
                Current version only
                {currentVersion ? ` (${fmtVersion(currentVersion)})` : ''}
              </label>
              {includeAllVersions && gameVersions.length > 0 && (
                <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginLeft: 20 }}>
                  Versions in DB: {gameVersions.map(fmtVersion).join(', ')}
                </span>
              )}
            </div>

            {/* Manual Overrides */}
            <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
              <button
                onClick={() => setOverridesOpen(v => !v)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 1,
                  color: colors.textMuted,
                  textTransform: 'uppercase',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: 0,
                }}
              >
                {overridesOpen ? '▾' : '▸'} Manual Overrides
              </button>

              {overridesOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Label>Fuel / Lap (L)</Label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={result ? result.avg_fuel_per_lap.toFixed(2) : 'from DB'}
                      value={fuelOverride}
                      onChange={e => setFuelOverride(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Label>VE / Lap (%)</Label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      placeholder={result?.avg_ve_per_lap ? (result.avg_ve_per_lap * 100).toFixed(1) : 'from DB'}
                      value={veOverride}
                      onChange={e => setVeOverride(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  {(fuelOverride !== '' || veOverride !== '') && (
                    <button
                      onClick={() => { setFuelOverride(''); setVeOverride('') }}
                      style={{
                        background: 'none',
                        border: `1px solid ${colors.border}`,
                        color: colors.textMuted,
                        fontFamily: fonts.body,
                        fontSize: 12,
                        padding: '4px 10px',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                    >
                      Clear overrides
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Calculate button */}
            <button
              onClick={handleCalculate}
              disabled={!canCalculate || calcLoading}
              style={{
                background: canCalculate && !calcLoading ? colors.primary : '#333',
                color: canCalculate && !calcLoading ? '#000' : colors.textMuted,
                border: 'none',
                fontFamily: fonts.body,
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: 1.5,
                textTransform: 'uppercase',
                padding: '10px 0',
                borderRadius: 5,
                cursor: canCalculate && !calcLoading ? 'pointer' : 'not-allowed',
                marginTop: 4,
              }}
            >
              {calcLoading ? 'Calculating…' : 'Calculate'}
            </button>
          </div>

          {/* ── Results Panel ── */}
          <div style={{
            overflowY: 'auto',
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}>
            {!result && !calcLoading && !calcError && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                color: colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 14,
                textAlign: 'center',
                lineHeight: 1.8,
              }}>
                Select a track, car, and race distance<br />then press Calculate.
              </div>
            )}

            {calcLoading && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                color: colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 14,
              }}>
                Calculating…
              </div>
            )}

            {calcError && (
              <Card style={{ borderColor: colors.danger }}>
                <div style={{ color: colors.danger, fontFamily: fonts.body, fontSize: 13 }}>
                  {calcError}
                  {calcError.includes('No valid laps') && (
                    <div style={{ marginTop: 8, color: colors.textMuted, fontSize: 12 }}>
                      No historical data found for this combination.<br />
                      Try enabling "Include older versions" or check if you have race results for this track/car.
                    </div>
                  )}
                </div>
              </Card>
            )}

            {result && !calcLoading && (
              <>
                {/* Data Quality */}
                <Card>
                  <CardTitle>Data Quality</CardTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <StatRow
                      label="Laps used"
                      value={`${result.laps_used} laps from ${result.sessions_used} session${result.sessions_used !== 1 ? 's' : ''}`}
                    />
                    <StatRow
                      label="Confidence"
                      value={result.confidence.toUpperCase()}
                      badge={
                        <span style={{
                          fontFamily: fonts.body,
                          fontSize: 10,
                          fontWeight: 700,
                          color: confidenceColor(result.confidence),
                          background: confidenceColor(result.confidence) + '22',
                          border: `1px solid ${confidenceColor(result.confidence)}`,
                          borderRadius: 3,
                          padding: '0 5px',
                        }}>
                          ●
                        </span>
                      }
                    />
                    <StatRow label="FuelMult" value={`${result.fuel_mult.toFixed(1)}×`} />
                    <StatRow label="Version filter" value={result.version_filter} />
                    {result.car_class && (
                      <StatRow label="Class" value={result.car_class} />
                    )}
                  </div>
                  {result.confidence === 'low' && (
                    <div style={{
                      marginTop: 10,
                      padding: '6px 10px',
                      background: colors.danger + '15',
                      border: `1px solid ${colors.danger}40`,
                      borderRadius: 4,
                      fontFamily: fonts.body,
                      fontSize: 12,
                      color: colors.danger,
                    }}>
                      Limited data — consider adding manual overrides for accuracy.
                    </div>
                  )}
                </Card>

                {/* Fuel */}
                <Card>
                  <CardTitle>Fuel</CardTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <StatRow
                      label="Avg / Lap"
                      value={fmt(effectiveFuelPerLap) + ' L'}
                      badge={isOverrideFuel ? <OverrideBadge /> : undefined}
                    />
                    <StatRow
                      label="Std Dev"
                      value={'±' + fmt(result.fuel_std_dev) + ' L'}
                    />
                    <StatRow
                      label="Total needed"
                      value={fmt(displayTotalFuel) + ' L'}
                      badge={isOverrideFuel ? <OverrideBadge /> : undefined}
                    />
                    {result.fuel_capacity !== null && (
                      <StatRow label="Tank capacity" value={fmt(result.fuel_capacity) + ' L'} />
                    )}
                    <StatRow
                      label="Stint length"
                      value={displayFuelStint !== null ? `${displayFuelStint} laps` : '–'}
                      badge={isOverrideFuel ? <OverrideBadge /> : undefined}
                    />
                    <StatRow
                      label="Fuel pit stops"
                      value={displayFuelPits !== null ? String(displayFuelPits) : '–'}
                      badge={isOverrideFuel ? <OverrideBadge /> : undefined}
                    />
                  </div>
                </Card>

                {/* VE (conditional) */}
                {(result.has_ve || isOverrideVe) && (
                  <Card>
                    <CardTitle>Virtual Energy</CardTitle>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <StatRow
                        label="Avg / Lap"
                        value={effectiveVePerLap !== null ? fmt(effectiveVePerLap * 100, 1) + '%' : '–'}
                        badge={isOverrideVe ? <OverrideBadge /> : undefined}
                      />
                      {result.ve_std_dev !== null && !isOverrideVe && (
                        <StatRow label="Std Dev" value={'±' + fmt(result.ve_std_dev * 100, 1) + '%'} />
                      )}
                      <StatRow
                        label="Stint length"
                        value={displayVeStint !== null ? `${displayVeStint} laps` : '–'}
                        badge={isOverrideVe ? <OverrideBadge /> : undefined}
                      />
                      <StatRow
                        label="VE pit stops"
                        value={displayVePits !== null ? String(displayVePits) : '–'}
                        badge={isOverrideVe ? <OverrideBadge /> : undefined}
                      />
                      {result.limiting_factor && (
                        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted }}>Limiting factor</span>
                          <span style={{
                            fontFamily: fonts.body,
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: 1,
                            color: '#000',
                            background: colors.primary,
                            borderRadius: 3,
                            padding: '2px 8px',
                          }}>
                            {result.limiting_factor.toUpperCase()}
                          </span>
                        </div>
                      )}
                    </div>
                  </Card>
                )}

                {/* Strategy Summary */}
                <Card>
                  <CardTitle>Strategy Summary</CardTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <StatRow
                      label="Effective stint"
                      value={displayEffectiveStint !== null ? `${displayEffectiveStint} laps` : '–'}
                    />
                    <StatRow
                      label="Total pit stops"
                      value={displayTotalPits !== null ? String(displayTotalPits) : '–'}
                    />
                    <StatRow
                      label="Start fuel"
                      value={displayStartFuel !== null ? fmt(displayStartFuel) + ' L' : '–'}
                      badge={isOverrideFuel ? <OverrideBadge /> : undefined}
                    />
                    {result.has_ve && (
                      <StatRow label="Start VE" value="100%" />
                    )}
                  </div>
                  {displayTotalPits === 0 && (
                    <div style={{
                      marginTop: 10,
                      padding: '5px 12px',
                      background: colors.success + '18',
                      border: `1px solid ${colors.success}50`,
                      borderRadius: 4,
                      fontFamily: fonts.body,
                      fontSize: 12,
                      fontWeight: 700,
                      color: colors.success,
                      letterSpacing: 0.5,
                      textAlign: 'center',
                    }}>
                      NO STOP NEEDED
                    </div>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
