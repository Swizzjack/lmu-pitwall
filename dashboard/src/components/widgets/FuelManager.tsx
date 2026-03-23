import { useRef } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

function isValidLapTime(t: number): boolean {
  return t > 10 && t < 600
}

function fuelBarColor(pct: number): string {
  if (pct < 0.20) return '#ef4444'
  if (pct < 0.50) return '#facc15'
  return '#22c55e'
}

function lapsColor(laps: number): string {
  if (laps < 3) return '#ef4444'
  if (laps < 5) return '#facc15'
  return colors.text
}

function veBarColor(pct: number): string {
  if (pct < 0.20) return '#ef4444'
  if (pct < 0.50) return '#facc15'
  return '#22c55e'
}

function refuelVeColor(pct: number): string {
  if (pct <= 0) return '#22c55e'
  return '#ef4444'
}

function arrayMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Compute median VE drop per lap from the history array.
 *  Ignores transitions where VE rises (pit stop / refuel). */
function veConsumptionPerLap(history: number[]): number | null {
  if (history.length < 2) return null
  const drops: number[] = []
  for (let i = 0; i < history.length - 1; i++) {
    const diff = history[i] - history[i + 1]
    if (diff > 0.001) drops.push(diff)
  }
  if (drops.length === 0) return null
  return arrayMedian(drops)
}

export default function FuelManager() {
  const fuel             = useTelemetryStore((s) => s.telemetry.fuel)
  const fuelCapacity     = useTelemetryStore((s) => s.telemetry.fuel_capacity)
  const fuelPct          = useTelemetryStore((s) => s.telemetry.fuel_pct)
  const avgConsumption   = useTelemetryStore((s) => s.telemetry.fuel_avg_consumption)
  const sampleCount      = useTelemetryStore((s) => s.telemetry.fuel_avg_sample_count)
  const lapsRemaining    = useTelemetryStore((s) => s.telemetry.fuel_laps_remaining)
  const stintNumber      = useTelemetryStore((s) => s.telemetry.fuel_stint_number)
  const stintLaps        = useTelemetryStore((s) => s.telemetry.fuel_stint_laps)
  const pitDetected      = useTelemetryStore((s) => s.telemetry.fuel_pit_detected)
  const avgLapTimeFromBridge = useTelemetryStore((s) => s.telemetry.fuel_avg_lap_time)
  const currentEt        = useTelemetryStore((s) => s.telemetry.current_et)
  const lapStartEt       = useTelemetryStore((s) => s.telemetry.lap_start_et)
  const sessionMinutes   = useTelemetryStore((s) => s.session.session_minutes)
  const sessionTime      = useTelemetryStore((s) => s.scoring.session_time)
  const scoring          = useTelemetryStore((s) => s.scoring)
  const veHistory        = useTelemetryStore((s) => s.telemetry.ve_history)
  const veAvailable      = useTelemetryStore((s) => s.telemetry.ve_available)

  const toDisplayFuel = useSettingsStore((s) => s.toDisplayFuel)
  const fuelUnitLabel = useSettingsStore((s) => s.fuelUnitLabel)
  const lapReserve    = useSettingsStore((s) => s.lapReserve)

  const unit     = fuelUnitLabel()
  const decimals = unit === 'gal' ? 2 : 1

  // True once we have at least one valid fuel-consumption sample from the bridge.
  const hasData = sampleCount > 0

  // --- Average lap time ---
  const playerVeh = scoring.vehicles.find((v) => v.id === scoring.player_vehicle_id) ?? null
  const lastLap   = playerVeh?.last_lap_time ?? 0
  const bestLap   = playerVeh?.best_lap_time ?? 0

  // Prefer the rolling median from the bridge; fall back to scoring lap times
  const avgLapTime = isValidLapTime(avgLapTimeFromBridge)
    ? avgLapTimeFromBridge
    : isValidLapTime(lastLap) ? lastLap
    : isValidLapTime(bestLap) ? bestLap
    : 0

  // --- Virtual Energy (current state + history) from REST API ---
  const lastKnownVe = veHistory && veHistory.length > 0 ? veHistory[veHistory.length - 1] : null
  const veConsPerLap = veHistory ? veConsumptionPerLap(veHistory) : null

  // Interpolate VE within the current lap so the refuel value stays stable.
  // strategy/usage only updates at lap crossings; we estimate the current VE
  // by subtracting the fraction of the lap already driven × avg VE per lap.
  const currentVe = (() => {
    if (lastKnownVe === null || veConsPerLap === null || !isValidLapTime(avgLapTime)) {
      return lastKnownVe
    }
    const timeIntoLap = Math.max(0, currentEt - lapStartEt)
    const lapProgress = Math.min(1, timeIntoLap / avgLapTime)
    return Math.max(0, lastKnownVe - lapProgress * veConsPerLap)
  })()

  // --- Remaining time ---
  const remainingSec = sessionMinutes > 0
    ? Math.max(0, sessionMinutes * 60 - sessionTime)
    : 0

  // --- VE-based refuel calculation (latched at lap crossings only) ---
  // Recomputing every tick causes up to veConsPerLap (~3%) drift within a lap.
  // Instead, we latch the result once per lap when veHistory gets a new entry
  // (i.e. at the start/finish line), using the fresh VE reading — no interpolation.
  const latchRef = useRef<{ histLen: number; refuelPct: number | null; remLaps: number | null }>({
    histLen: 0, refuelPct: null, remLaps: null,
  })

  const veHistLen = veHistory?.length ?? 0
  const canCalcVe = lastKnownVe !== null && veConsPerLap !== null
    && sessionMinutes > 0 && isValidLapTime(avgLapTime)

  if (canCalcVe && veHistLen > 0 && veHistLen !== latchRef.current.histLen) {
    const freshVe = veHistory![veHistLen - 1]
    const remLaps = Math.ceil(remainingSec / avgLapTime) + lapReserve
    const neededVe = remLaps * veConsPerLap!
    const refuelVe = neededVe - freshVe
    latchRef.current = {
      histLen: veHistLen,
      refuelPct: Math.max(0, Math.ceil(refuelVe * 100)),
      remLaps,
    }
  }

  const refuelVeDisplay = latchRef.current.refuelPct
  const estimatedRemainingLaps = latchRef.current.remLaps

  // --- Display helpers ---
  const barColor   = fuelBarColor(fuelPct)
  const stintColor = pitDetected ? '#facc15' : colors.textMuted

  const fmtLaps = (v: number) => {
    if (!hasData || !isFinite(v)) return '---'
    return v.toFixed(1)
  }

  const refuelColor = refuelVeDisplay !== null ? refuelVeColor(refuelVeDisplay) : '#444'

  // --- Fuel-based refuel (for non-VE vehicles) ---
  // Use ve_available from garage API if known; fall back to veHistory presence as heuristic.
  const noVeVehicle = veAvailable === null
    ? veHistory === null   // garage data not yet fetched → heuristic
    : veAvailable === false
  // Use a continuous (non-ceiled) laps value so that remLapsRaw * avgConsumption
  // decreases at the same rate as fuel burns → refuelFuelL stays stable mid-lap.
  const remLapsRaw = noVeVehicle && hasData && isValidLapTime(avgLapTime) && remainingSec > 0
    ? remainingSec / avgLapTime + lapReserve
    : null
  const remLapsFuel = remLapsRaw !== null ? Math.ceil(remLapsRaw) : null  // display only
  const refuelFuelL = remLapsRaw !== null
    ? Math.max(0, Math.ceil(remLapsRaw * avgConsumption - fuel))
    : null
  const refuelFuelColor = refuelFuelL !== null
    ? (refuelFuelL <= 0 ? '#22c55e' : '#ef4444')
    : '#444'

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '8px 10px',
      gap: 6,
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Fuel Manager
        </span>
        <span style={{ fontFamily: fonts.heading, fontSize: 15, color: stintColor, transition: 'color 0.3s' }}>
          Stint {stintNumber}
        </span>
      </div>

      {/* Fuel bar + level */}
      <div>
        <div style={{
          width: '100%', height: 8, background: '#1a1a1a',
          borderRadius: 4, overflow: 'hidden', marginBottom: 4,
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(fuelPct * 100, 100)}%`,
            background: barColor,
            borderRadius: 4,
            transition: 'width 0.3s, background 0.3s',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: fonts.heading, fontSize: 20, color: barColor, lineHeight: 1, transition: 'color 0.3s' }}>
            {toDisplayFuel(fuel).toFixed(decimals)}{unit}
          </span>
          <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted }}>
            / {toDisplayFuel(fuelCapacity).toFixed(decimals)}{unit} &nbsp; {(fuelPct * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Virtual Energy current state — only shown when REST API provides a value */}
      {currentVe !== null && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#111', borderRadius: 4, padding: '4px 8px',
        }}>
          <span style={{
            fontFamily: fonts.body, fontSize: 12, color: colors.textMuted,
            textTransform: 'uppercase', letterSpacing: 1, minWidth: 24,
          }}>
            VE
          </span>
          <span style={{ fontFamily: fonts.heading, fontSize: 16, color: veBarColor(currentVe), minWidth: 44, textAlign: 'right' }}>
            {(currentVe * 100).toFixed(0)}%
          </span>
          <div style={{ flex: 1, height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min(currentVe * 100, 100)}%`,
              background: veBarColor(currentVe),
              borderRadius: 3,
              transition: 'width 0.3s, background 0.3s',
            }} />
          </div>
          {veConsPerLap !== null && (
            <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555', whiteSpace: 'nowrap' }}>
              ø{(veConsPerLap * 100).toFixed(1)}%/lap
            </span>
          )}
        </div>
      )}

      {/* Stats row: Laps left / Avg consumption / Stint laps */}
      <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
        <div style={statBox}>
          <span style={{
            fontFamily: fonts.heading, fontSize: 18, lineHeight: 1,
            color: hasData && isFinite(lapsRemaining) ? lapsColor(lapsRemaining) : colors.textMuted,
          }}>
            {fmtLaps(lapsRemaining)}
          </span>
          <span style={statLabel}>Laps left</span>
        </div>
        <div style={statBox}>
          <span style={{ fontFamily: fonts.heading, fontSize: 18, lineHeight: 1, color: hasData ? colors.text : colors.textMuted }}>
            {hasData ? toDisplayFuel(avgConsumption).toFixed(decimals) : '---'}
          </span>
          <span style={statLabel}>{unit}/lap ø{sampleCount}</span>
        </div>
        <div style={statBox}>
          <span style={{ fontFamily: fonts.heading, fontSize: 18, lineHeight: 1, color: colors.text }}>
            {stintLaps}
          </span>
          <span style={statLabel}>Stint laps</span>
        </div>
      </div>

      {/* REFUEL — VE% for hybrid cars, fuel amount for non-VE cars */}
      {noVeVehicle ? (
        <div style={{
          padding: '8px 12px',
          background: refuelFuelL !== null ? `${refuelFuelColor}18` : '#1a1a1a',
          border: `2px solid ${refuelFuelL !== null ? refuelFuelColor : '#2a2a2a'}`,
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0,
          transition: 'background 0.3s, border-color 0.3s',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{
              fontFamily: fonts.body, fontSize: 13, color: colors.textMuted,
              textTransform: 'uppercase', letterSpacing: 1,
            }}>
              Refuel
            </span>
            {remLapsFuel !== null ? (
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555' }}>
                ~{remLapsFuel} laps
              </span>
            ) : (
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555' }}>
                {hasData ? 'No session time' : 'Need ≥1 lap'}
              </span>
            )}
          </div>
          <span style={{
            fontFamily: fonts.heading,
            fontSize: 40,
            fontWeight: 700,
            lineHeight: 1,
            color: refuelFuelL !== null ? refuelFuelColor : '#444',
            letterSpacing: -1,
          }}>
            {refuelFuelL !== null
              ? refuelFuelL === 0 ? '0' + unit : `+${toDisplayFuel(refuelFuelL).toFixed(decimals)}${unit}`
              : '---'}
          </span>
        </div>
      ) : (
        <div style={{
          padding: '8px 12px',
          background: refuelVeDisplay !== null ? `${refuelColor}18` : '#1a1a1a',
          border: `2px solid ${refuelVeDisplay !== null ? refuelColor : '#2a2a2a'}`,
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0,
          transition: 'background 0.3s, border-color 0.3s',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{
              fontFamily: fonts.body, fontSize: 13, color: colors.textMuted,
              textTransform: 'uppercase', letterSpacing: 1,
            }}>
              Refuel VE
            </span>
            {refuelVeDisplay !== null ? (
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555' }}>
                ~{estimatedRemainingLaps} laps
              </span>
            ) : (
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555' }}>
                Need ≥2 laps
              </span>
            )}
          </div>
          <span style={{
            fontFamily: fonts.heading,
            fontSize: 40,
            fontWeight: 700,
            lineHeight: 1,
            color: refuelVeDisplay !== null ? refuelColor : '#444',
            letterSpacing: -1,
          }}>
            {refuelVeDisplay !== null ? `${refuelVeDisplay}%` : '---'}
          </span>
        </div>
      )}

    </div>
  )
}

const statBox: React.CSSProperties = {
  flex: 1,
  background: '#111',
  borderRadius: 4,
  padding: '5px 6px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
}

const statLabel: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: 13,
  color: '#737373',
  textTransform: 'uppercase',
  letterSpacing: 1,
  textAlign: 'center',
  lineHeight: 1,
}
