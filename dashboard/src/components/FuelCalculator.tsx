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
  fuel_mult_options: number[]
  default_fuel_mult: number | null
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
  // Race distance
  avg_lap_time_secs: number | null
  estimated_laps: number | null
  race_laps: number
  buffer_laps: number
  // Fuel (%)
  avg_fuel_pct_per_lap: number
  fuel_std_dev_pct: number
  total_fuel_needed_pct: number
  fuel_stint_laps: number | null
  fuel_pit_stops: number | null
  // VE (%)
  has_ve: boolean
  avg_ve_pct_per_lap: number | null
  ve_std_dev_pct: number | null
  ve_stint_laps: number | null
  ve_pit_stops: number | null
  // Combined
  effective_stint_laps: number | null
  total_pit_stops: number | null
  limiting_factor: string | null
  // Recommended (%)
  recommended_start_fuel_pct: number | null
  recommended_start_ve_pct: number | null
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

function fmt(n: number | null | undefined, dp = 1, suffix = ''): string {
  if (n === null || n === undefined) return '–'
  return `${n.toFixed(dp)}${suffix}`
}

function fmtLapTime(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
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

function MultBadge({ mult }: { mult: number }) {
  return (
    <span style={{
      fontFamily: fonts.body,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.5,
      color: colors.primary,
      background: colors.primary + '22',
      border: `1px solid ${colors.primary}`,
      borderRadius: 3,
      padding: '0 4px',
    }}>
      ×{mult}
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
  const [distanceMode, setDistanceMode] = useState<'laps' | 'time'>('time')
  const [distanceValue, setDistanceValue] = useState('')
  const [includeAllVersions, setIncludeAllVersions] = useState(false)
  const [includePractice, setIncludePractice] = useState(true)
  const [fuelMultOverride, setFuelMultOverride] = useState<string>('')  // '' = auto
  const [bufferLaps, setBufferLaps] = useState(1)
  const [consumptionMult, setConsumptionMult] = useState(1.0)
  const [overridesOpen, setOverridesOpen] = useState(false)
  const [fuelOverride, setFuelOverride] = useState('')   // % per lap
  const [veOverride, setVeOverride] = useState('')       // % per lap

  // Estimated laps edit (time mode — user can override backend's estimate)
  const [estimatedLapsEdit, setEstimatedLapsEdit] = useState('')

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

  // Use a ref so the onmessage handler always calls the latest version,
  // avoiding stale-closure bugs (e.g. initLoading stuck at true).
  const handleMsgRef = useRef<(msg: FuelCalcMsg) => void>(null!)
  handleMsgRef.current = function handleMsg(msg: FuelCalcMsg) {
    if (msg.type === 'FuelCalcOptions') {
      setTracks(msg.options.tracks)
      setGameVersions(msg.options.game_versions)
      setCurrentVersion(msg.options.current_version)
      setInitLoading(false)
    } else if (msg.type === 'FuelCalcResult') {
      setResult(msg.result)
      setEstimatedLapsEdit('')
      setCalcLoading(false)
      setCalcError(null)
    } else if (msg.type === 'FuelCalcError') {
      setInitLoading(prev => {
        if (prev) {
          setInitError(msg.message)
          return false
        }
        setCalcError(msg.message)
        setCalcLoading(false)
        return false
      })
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
        handleMsgRef.current(msg)
      } catch { /* malformed */ }
    }

    ws.onerror = () => {
      setInitError('WebSocket connection failed.')
      setInitLoading(false)
    }

    ws.onclose = () => {
      setInitLoading(prev => {
        if (prev) {
          setInitError('Connection to bridge lost.')
          return false
        }
        return prev
      })
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
    setFuelMultOverride('')
    setResult(null)
    setCalcError(null)
  }

  function handleCarChange(carName: string) {
    setSelectedCar(carName)
    setFuelMultOverride('')
    setResult(null)
    setCalcError(null)
  }

  function handleCalculate() {
    if (!canCalculate) return
    setCalcLoading(true)
    setCalcError(null)
    setResult(null)
    setEstimatedLapsEdit('')

    const cmd: Record<string, unknown> = {
      command: 'fuel_calc_compute',
      track_venue: selectedTrack,
      car_name: selectedCar,
      include_all_versions: includeAllVersions,
      include_practice: includePractice,
      buffer_laps: bufferLaps,
    }

    if (fuelMultOverride !== '') {
      const fm = parseFloat(fuelMultOverride)
      if (!isNaN(fm)) cmd.fuel_mult = fm
    }

    const distNum = parseFloat(distanceValue)
    if (distanceMode === 'laps') {
      cmd.race_laps = Math.round(distNum)
    } else {
      cmd.race_minutes = distNum
    }

    sendCmd(cmd)
  }

  // ── Derived display values (client-side, override-aware) ─────────────────────

  // Parse overrides — all in % per lap
  const fuelOvNum  = fuelOverride !== '' ? parseFloat(fuelOverride) : null
  const veOvNum    = veOverride   !== '' ? parseFloat(veOverride)   : null
  const isOverrideFuel = fuelOvNum !== null && !isNaN(fuelOvNum) && fuelOvNum > 0
  const isOverrideVe   = veOvNum   !== null && !isNaN(veOvNum)   && veOvNum   > 0

  // Effective per-lap consumption (%) — normalize DB values from their recorded fuel_mult
  // to the user's target consumptionMult: factor = consumptionMult / data_fuel_mult
  const dataFuelMult = result?.fuel_mult ?? 1.0
  const normFactor = dataFuelMult > 0 ? consumptionMult / dataFuelMult : consumptionMult

  const effectiveFuelPct = isOverrideFuel
    ? fuelOvNum!
    : (result?.avg_fuel_pct_per_lap ?? 0) * normFactor
  const effectiveVePct = isOverrideVe
    ? veOvNum!
    : result?.avg_ve_pct_per_lap != null
      ? result.avg_ve_pct_per_lap * normFactor
      : null

  // Effective race laps (may be overridden by user edit in time mode)
  const estimatedLapsNum = estimatedLapsEdit !== ''
    ? parseInt(estimatedLapsEdit, 10)
    : null
  const effectiveLaps = (estimatedLapsNum !== null && !isNaN(estimatedLapsNum) && estimatedLapsNum > 0)
    ? estimatedLapsNum
    : (result?.race_laps ?? 0)

  // Fuel calculations
  const displayTotalFuelPct = effectiveLaps > 0
    ? effectiveFuelPct * effectiveLaps
    : null

  const displayFuelStint = effectiveFuelPct > 0
    ? Math.floor(100 / effectiveFuelPct)
    : result?.fuel_stint_laps ?? null

  const displayFuelPits = displayFuelStint && effectiveLaps
    ? Math.max(0, Math.ceil(effectiveLaps / displayFuelStint) - 1)
    : result?.fuel_pit_stops ?? null

  // VE calculations
  const displayVeStint = effectiveVePct && effectiveVePct > 0
    ? Math.floor(100 / effectiveVePct)
    : result?.ve_stint_laps ?? null

  const displayVePits = displayVeStint && effectiveLaps
    ? Math.max(0, Math.ceil(effectiveLaps / displayVeStint) - 1)
    : result?.ve_pit_stops ?? null

  // Combined
  const displayEffectiveStint = (displayFuelStint !== null && displayVeStint !== null)
    ? Math.min(displayFuelStint, displayVeStint)
    : displayFuelStint ?? displayVeStint ?? result?.effective_stint_laps ?? null

  const displayTotalPits = (displayFuelPits !== null && displayVePits !== null)
    ? Math.max(displayFuelPits, displayVePits)
    : displayFuelPits ?? displayVePits ?? result?.total_pit_stops ?? null

  // Rolling start surcharge: fuel/VE consumed before the start line in LMU
  const ROLLING_START_LAPS = 0.5

  // Start fuel / VE: (effectiveLaps + bufferLaps + rolling start) × consumption, capped at 100%
  const displayStartFuelPct = effectiveFuelPct > 0
    ? Math.min(100, (effectiveLaps + bufferLaps + ROLLING_START_LAPS) * effectiveFuelPct)
    : result?.recommended_start_fuel_pct != null
      ? Math.min(100, result.recommended_start_fuel_pct + ROLLING_START_LAPS * (result.avg_fuel_pct_per_lap * normFactor))
      : null

  const displayStartVePct = effectiveVePct && effectiveVePct > 0
    ? Math.min(100, (effectiveLaps + bufferLaps + ROLLING_START_LAPS) * effectiveVePct)
    : result?.recommended_start_ve_pct != null && result.avg_ve_pct_per_lap != null
      ? Math.min(100, result.recommended_start_ve_pct + ROLLING_START_LAPS * (result.avg_ve_pct_per_lap * normFactor))
      : null

  // Pit stop refuel / VE amounts
  // Laps in the final stint = total race laps minus all preceding full stints
  const remainingLapsAfterLastPit =
    displayEffectiveStint !== null && displayTotalPits !== null && displayTotalPits > 0
      ? Math.max(1, effectiveLaps - displayTotalPits * displayEffectiveStint)
      : null
  // Regular stops (stints 1..P-1): refuel for a full next stint
  const pitstopFuelRegular =
    displayEffectiveStint !== null && effectiveFuelPct > 0 && displayTotalPits !== null && displayTotalPits >= 2
      ? Math.min(100, displayEffectiveStint * effectiveFuelPct)
      : null
  // Last (or only) stop: refuel for remaining laps + buffer
  const pitstopFuelLast =
    remainingLapsAfterLastPit !== null && effectiveFuelPct > 0
      ? Math.min(100, (remainingLapsAfterLastPit + bufferLaps) * effectiveFuelPct)
      : null
  const pitstopVeRegular =
    displayEffectiveStint !== null && effectiveVePct !== null && effectiveVePct > 0 && displayTotalPits !== null && displayTotalPits >= 2
      ? Math.min(100, displayEffectiveStint * effectiveVePct)
      : null
  const pitstopVeLast =
    remainingLapsAfterLastPit !== null && effectiveVePct !== null && effectiveVePct > 0
      ? Math.min(100, (remainingLapsAfterLastPit + bufferLaps) * effectiveVePct)
      : null

  // ── Styles ──────────────────────────────────────────────────────────────────

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

  // ── FuelMult options for selected car ───────────────────────────────────────
  const availableFuelMults = selectedCarOption?.fuel_mult_options ?? []
  const showFuelMultSelector = availableFuelMults.length > 1

  // ── Scale ────────────────────────────────────────────────────────────────────
  const SCALE_MIN = 0.5
  const SCALE_MAX = 2.0
  const SCALE_STEP = 0.1
  const LS_SCALE_KEY = 'fuel-calc-scale'
  const [scale, setScaleState] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem(LS_SCALE_KEY) ?? '1')
    return isNaN(v) ? 1 : Math.min(SCALE_MAX, Math.max(SCALE_MIN, v))
  })
  function adjustScale(delta: number) {
    setScaleState(prev => {
      const next = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, prev + delta)) * 10) / 10
      localStorage.setItem(LS_SCALE_KEY, String(next))
      return next
    })
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

        {/* Scale controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <button
            onClick={() => adjustScale(-SCALE_STEP)}
            disabled={scale <= SCALE_MIN}
            title="Kleiner"
            style={{
              width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: `1px solid ${scale <= SCALE_MIN ? '#333' : colors.border}`,
              color: scale <= SCALE_MIN ? '#333' : colors.textMuted, cursor: scale <= SCALE_MIN ? 'not-allowed' : 'pointer',
              borderRadius: 3, fontSize: 14, padding: 0, lineHeight: 1,
            }}
          >−</button>
          <span style={{ fontSize: 13, color: colors.textMuted, minWidth: 34, textAlign: 'center', fontFamily: fonts.mono }}>
            {scale.toFixed(1)}×
          </span>
          <button
            onClick={() => adjustScale(SCALE_STEP)}
            disabled={scale >= SCALE_MAX}
            title="Grösser"
            style={{
              width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: `1px solid ${scale >= SCALE_MAX ? '#333' : colors.border}`,
              color: scale >= SCALE_MAX ? '#333' : colors.textMuted, cursor: scale >= SCALE_MAX ? 'not-allowed' : 'pointer',
              borderRadius: 3, fontSize: 14, padding: 0, lineHeight: 1,
            }}
          >+</button>
        </div>
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
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        <div style={{
          position: 'absolute', top: 0, left: 0,
          width: `${100 / scale}%`, height: `${100 / scale}%`,
          transform: `scale(${scale})`, transformOrigin: 'top left',
          display: 'grid',
          gridTemplateColumns: '320px 1fr',
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

            {/* FuelMult selector — only shown when multiple values exist */}
            {showFuelMultSelector && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Label>Fuel Multiplier</Label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    cursor: 'pointer', fontFamily: fonts.body, fontSize: 13,
                    color: fuelMultOverride === '' ? colors.text : colors.textMuted,
                  }}>
                    <input
                      type="radio"
                      checked={fuelMultOverride === ''}
                      onChange={() => setFuelMultOverride('')}
                      style={{ accentColor: colors.primary }}
                    />
                    Auto ({selectedCarOption?.default_fuel_mult?.toFixed(1)}×)
                  </label>
                  {availableFuelMults.map(fm => (
                    <label key={fm} style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      cursor: 'pointer', fontFamily: fonts.body, fontSize: 13,
                      color: fuelMultOverride === String(fm) ? colors.text : colors.textMuted,
                    }}>
                      <input
                        type="radio"
                        checked={fuelMultOverride === String(fm)}
                        onChange={() => setFuelMultOverride(String(fm))}
                        style={{ accentColor: colors.primary }}
                      />
                      {fm.toFixed(1)}×
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Distance */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Label>Race Distance</Label>
              <div style={{ display: 'flex', gap: 10 }}>
                {(['time', 'laps'] as const).map(m => (
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

            {/* Buffer laps */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label>Buffer</Label>
              <div style={{ display: 'flex', gap: 8 }}>
                {[0, 1, 2, 3].map(n => (
                  <label key={n} style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    cursor: 'pointer', fontFamily: fonts.body, fontSize: 13,
                    color: bufferLaps === n ? colors.text : colors.textMuted,
                  }}>
                    <input
                      type="radio"
                      checked={bufferLaps === n}
                      onChange={() => setBufferLaps(n)}
                      style={{ accentColor: colors.primary }}
                    />
                    {n === 0 ? 'None' : `+${n}`}
                  </label>
                ))}
              </div>
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted }}>
                Extra laps of fuel added to start values
              </span>
            </div>

            {/* Consumption Multiplier */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label>Consumption Multiplier</Label>
              <div style={{ display: 'flex', gap: 8 }}>
                {[1.0, 1.5, 2.0].map(m => (
                  <label key={m} style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    cursor: 'pointer', fontFamily: fonts.body, fontSize: 13,
                    color: consumptionMult === m ? colors.text : colors.textMuted,
                  }}>
                    <input
                      type="radio"
                      checked={consumptionMult === m}
                      onChange={() => setConsumptionMult(m)}
                      style={{ accentColor: colors.primary }}
                    />
                    {m === 1.0 ? '1×' : `${m}×`}
                  </label>
                ))}
              </div>
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted }}>
                Scales fuel &amp; VE consumption from DB
              </span>
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

            {/* Session type filter */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label>Session Data</Label>
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
                  checked={includePractice}
                  onChange={() => setIncludePractice(v => !v)}
                  style={{ accentColor: colors.primary }}
                />
                Include Practice sessions
              </label>
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
                    <Label>Fuel / Lap (%)</Label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      placeholder={result ? result.avg_fuel_pct_per_lap.toFixed(1) : 'from DB'}
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
                      placeholder={result?.avg_ve_pct_per_lap != null ? result.avg_ve_pct_per_lap.toFixed(1) : 'from DB'}
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

                {/* Race Distance (time mode) */}
                {result.estimated_laps != null && (
                  <Card>
                    <CardTitle>Race Estimate</CardTitle>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {result.avg_lap_time_secs != null && (
                        <StatRow
                          label="Avg lap time"
                          value={fmtLapTime(result.avg_lap_time_secs)}
                        />
                      )}
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '3px 0',
                      }}>
                        <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted }}>Estimated laps</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {estimatedLapsEdit !== '' && <OverrideBadge />}
                          <input
                            type="number"
                            min="1"
                            value={estimatedLapsEdit !== '' ? estimatedLapsEdit : result.estimated_laps}
                            onChange={e => setEstimatedLapsEdit(e.target.value)}
                            style={{
                              background: '#111',
                              border: `1px solid ${estimatedLapsEdit !== '' ? colors.accent : colors.border}`,
                              color: colors.text,
                              fontFamily: fonts.mono,
                              fontSize: 14,
                              padding: '2px 8px',
                              borderRadius: 4,
                              outline: 'none',
                              width: 70,
                              textAlign: 'right',
                            }}
                          />
                          {estimatedLapsEdit !== '' && (
                            <button
                              onClick={() => setEstimatedLapsEdit('')}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: colors.textMuted,
                                cursor: 'pointer',
                                fontFamily: fonts.body,
                                fontSize: 12,
                                padding: 0,
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                      <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                        Edit to override the estimated lap count
                      </span>
                    </div>
                  </Card>
                )}

                {/* Fuel */}
                <Card>
                  <CardTitle>Fuel</CardTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <StatRow
                      label="Avg / Lap"
                      value={fmt(effectiveFuelPct, 1, '%')}
                      badge={isOverrideFuel ? <OverrideBadge /> : Math.abs(normFactor - 1.0) > 0.001 ? <MultBadge mult={consumptionMult} /> : undefined}
                    />
                    <StatRow
                      label="Std Dev"
                      value={'±' + fmt(result.fuel_std_dev_pct, 1, '%')}
                    />
                    <StatRow
                      label="Total needed"
                      value={fmt(displayTotalFuelPct, 1, '%')}
                      badge={(isOverrideFuel || estimatedLapsEdit !== '') ? <OverrideBadge /> : undefined}
                    />
                    <StatRow
                      label="Stint length"
                      value={displayFuelStint !== null ? `${displayFuelStint} laps` : '–'}
                      badge={isOverrideFuel ? <OverrideBadge /> : undefined}
                    />
                    <StatRow
                      label="Fuel pit stops"
                      value={displayFuelPits !== null ? String(displayFuelPits) : '–'}
                      badge={(isOverrideFuel || estimatedLapsEdit !== '') ? <OverrideBadge /> : undefined}
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
                        value={effectiveVePct !== null ? fmt(effectiveVePct, 1, '%') : '–'}
                        badge={isOverrideVe ? <OverrideBadge /> : Math.abs(normFactor - 1.0) > 0.001 ? <MultBadge mult={consumptionMult} /> : undefined}
                      />
                      {result.ve_std_dev_pct !== null && !isOverrideVe && (
                        <StatRow label="Std Dev" value={'±' + fmt(result.ve_std_dev_pct, 1, '%')} />
                      )}
                      <StatRow
                        label="Stint length"
                        value={displayVeStint !== null ? `${displayVeStint} laps` : '–'}
                        badge={isOverrideVe ? <OverrideBadge /> : undefined}
                      />
                      <StatRow
                        label="VE pit stops"
                        value={displayVePits !== null ? String(displayVePits) : '–'}
                        badge={(isOverrideVe || estimatedLapsEdit !== '') ? <OverrideBadge /> : undefined}
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
                  </div>

                  {/* Start Fuel / Start VE — prominent tiles */}
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <div style={{
                      flex: 1,
                      background: colors.bg,
                      border: `1px solid ${colors.primary}55`,
                      borderRadius: 6,
                      padding: '10px 14px',
                      textAlign: 'center',
                    }}>
                      <div style={{
                        fontFamily: fonts.body,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 1.5,
                        color: colors.primary,
                        textTransform: 'uppercase',
                        marginBottom: 4,
                      }}>
                        Start Fuel
                      </div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 24, fontWeight: 700, color: colors.text }}>
                        {displayStartFuelPct !== null ? fmt(displayStartFuelPct, 1, '%') : '–'}
                      </div>
                      {displayStartFuelPct !== null && displayStartFuelPct >= 100 && (
                        <div style={{ color: colors.danger, fontFamily: fonts.body, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, marginTop: 2 }}>
                          FULL TANK
                        </div>
                      )}
                    </div>
                    {(result.has_ve || isOverrideVe) && effectiveVePct !== null && (
                      <div style={{
                        flex: 1,
                        background: colors.bg,
                        border: `1px solid ${colors.primary}55`,
                        borderRadius: 6,
                        padding: '10px 14px',
                        textAlign: 'center',
                      }}>
                        <div style={{
                          fontFamily: fonts.body,
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 1.5,
                          color: colors.primary,
                          textTransform: 'uppercase',
                          marginBottom: 4,
                        }}>
                          Start VE
                        </div>
                        <div style={{ fontFamily: fonts.mono, fontSize: 24, fontWeight: 700, color: colors.text }}>
                          {displayStartVePct !== null ? fmt(displayStartVePct, 1, '%') : '–'}
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ fontFamily: fonts.body, fontSize: 10, color: colors.textMuted, textAlign: 'right', marginTop: 4, letterSpacing: 0.3 }}>
                    incl. +0.5 laps rolling start
                  </div>

                  {/* Pit stop refuel section */}
                  {displayTotalPits !== null && displayTotalPits > 0 && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
                      <div style={{
                        fontFamily: fonts.body,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 1,
                        color: colors.textMuted,
                        textTransform: 'uppercase',
                        marginBottom: 8,
                      }}>
                        Pit Stop Refuel
                      </div>
                      {/* Regular stops (1..P-1) — only shown when P ≥ 2 */}
                      {displayTotalPits >= 2 && (
                        <StatRow
                          label={`Fuel — ${displayTotalPits === 2 ? 'stop 1' : `stops 1–${displayTotalPits - 1}`}`}
                          value={pitstopFuelRegular !== null ? fmt(pitstopFuelRegular, 1, '%') : '–'}
                        />
                      )}
                      {displayTotalPits >= 2 && (result.has_ve || isOverrideVe) && pitstopVeRegular !== null && (
                        <StatRow
                          label={`VE — ${displayTotalPits === 2 ? 'stop 1' : `stops 1–${displayTotalPits - 1}`}`}
                          value={fmt(pitstopVeRegular, 1, '%')}
                        />
                      )}
                      {/* Last (or only) stop */}
                      <StatRow
                        label={displayTotalPits === 1 ? 'Fuel — stop 1' : `Fuel — stop ${displayTotalPits}`}
                        value={pitstopFuelLast !== null ? fmt(pitstopFuelLast, 1, '%') : '–'}
                      />
                      {(result.has_ve || isOverrideVe) && pitstopVeLast !== null && (
                        <StatRow
                          label={displayTotalPits === 1 ? 'VE — stop 1' : `VE — stop ${displayTotalPits}`}
                          value={fmt(pitstopVeLast, 1, '%')}
                        />
                      )}
                    </div>
                  )}

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
        </div>
      )}
    </div>
  )
}
