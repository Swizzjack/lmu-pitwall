import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

// Minimum stint laps before using the per-stint avg as a fallback
const FALLBACK_MIN_LAPS = 1

// Fuel bar gradient based on percentage
function fuelBarColor(pct: number): string {
  if (pct < 0.20) return '#ef4444'
  if (pct < 0.50) return '#facc15'
  return '#22c55e'
}

function lapsColor(laps: number): string {
  if (!isFinite(laps)) return colors.textMuted
  if (laps < 3) return '#ef4444'
  if (laps < 5) return '#facc15'
  return colors.text
}

function formatLaps(laps: number): string {
  if (!isFinite(laps)) return '---'
  return laps.toFixed(1)
}

function formatAvg(avg: number, decimals: number): string {
  if (avg === 0) return '---'
  return avg.toFixed(decimals)
}

// Format lap time as m:ss (no ms — used as reference label)
function formatLapRef(seconds: number): string {
  if (seconds <= 0) return '?:??'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function refuelColor(delta: number): string {
  if (delta <= 0) return '#22c55e'        // surplus — green
  if (delta < 5)  return '#facc15'        // small deficit — yellow
  return '#ef4444'                         // significant deficit — red
}

export default function FuelManager() {
  const fuel             = useTelemetryStore((s) => s.telemetry.fuel)
  const fuelCapacity     = useTelemetryStore((s) => s.telemetry.fuel_capacity)
  const fuelPct          = useTelemetryStore((s) => s.telemetry.fuel_pct)
  const avgConsumption   = useTelemetryStore((s) => s.telemetry.fuel_avg_consumption)
  const lapsRemaining    = useTelemetryStore((s) => s.telemetry.fuel_laps_remaining)
  const stintNumber      = useTelemetryStore((s) => s.telemetry.fuel_stint_number)
  const stintLaps        = useTelemetryStore((s) => s.telemetry.fuel_stint_laps)
  const stintConsumption = useTelemetryStore((s) => s.telemetry.fuel_stint_consumption)
  const pitDetected      = useTelemetryStore((s) => s.telemetry.fuel_pit_detected)
  const sessionLaps      = useTelemetryStore((s) => s.session.session_laps)
  const sessionMinutes   = useTelemetryStore((s) => s.session.session_minutes)
  const sessionTime      = useTelemetryStore((s) => s.scoring.session_time)
  const scoring          = useTelemetryStore((s) => s.scoring)

  const toDisplayFuel  = useSettingsStore((s) => s.toDisplayFuel)
  const fuelUnitLabel  = useSettingsStore((s) => s.fuelUnitLabel)
  const lapReserve     = useSettingsStore((s) => s.lapReserve)

  const unit     = fuelUnitLabel()
  const decimals = unit === 'gal' ? 2 : 1

  const fuelDisplay     = toDisplayFuel(fuel)
  const capacityDisplay = toDisplayFuel(fuelCapacity)

  // Fallback avg: per-stint average when the 5-lap rolling median hasn't populated yet
  const stintAvgRaw = stintLaps >= FALLBACK_MIN_LAPS && stintConsumption > 0
    ? stintConsumption / stintLaps
    : 0
  const effectiveAvg   = avgConsumption > 0 ? avgConsumption : stintAvgRaw
  const isFallbackAvg  = avgConsumption === 0 && effectiveAvg > 0

  const avgDisplay      = toDisplayFuel(effectiveAvg)
  const barColor        = fuelBarColor(fuelPct)
  const stintColor      = pitDetected ? '#facc15' : colors.textMuted

  // --- Refuel estimate ---
  // Prefer last_lap_time; fall back to best_lap_time
  const playerVeh  = scoring.vehicles.find((v) => v.id === scoring.player_vehicle_id) ?? null
  const lastLap    = playerVeh?.last_lap_time ?? 0
  const bestLap    = playerVeh?.best_lap_time ?? 0
  const avgLapTime = lastLap > 0 ? lastLap : bestLap > 0 ? bestLap : 0

  const remainingSec = sessionMinutes > 0
    ? Math.max(0, sessionMinutes * 60 - sessionTime)
    : 0

  // Effective laps remaining: use bridge value if available, else compute from effectiveAvg
  const effectiveLapsRemaining = isFinite(lapsRemaining) ? lapsRemaining
    : effectiveAvg > 0 ? fuel / effectiveAvg
    : Infinity

  // Time-based: use remaining session time + avg lap time reference
  const canCalcTimeBased = sessionMinutes > 0 && avgLapTime > 0 && effectiveAvg > 0
  // Lap-based: derive laps remaining from session total and completed laps
  const playerLapsCompleted  = playerVeh?.total_laps ?? 0
  const sessionLapsRemaining = Math.max(0, sessionLaps - playerLapsCompleted)
  const canCalcLapBased      = sessionLaps > 0 && sessionLapsRemaining > 0 && effectiveAvg > 0

  let refuelDelta: number | null = null   // positive = need to add, negative = surplus
  let refuelLapsEst: number | null = null
  let refuelMode: 'time' | 'laps' | null = null

  if (canCalcTimeBased) {
    refuelLapsEst = remainingSec / avgLapTime
    const fuelNeeded = refuelLapsEst * effectiveAvg + effectiveAvg * lapReserve
    refuelDelta = fuelNeeded - fuel
    refuelMode  = 'time'
  } else if (canCalcLapBased) {
    const fuelNeeded = sessionLapsRemaining * effectiveAvg + lapReserve * effectiveAvg
    refuelDelta = fuelNeeded - fuel
    refuelMode  = 'laps'
  }

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
      {/* Header row */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Fuel Manager
        </span>
        <span style={{ fontFamily: fonts.heading, fontSize: 15, color: stintColor, transition: 'color 0.3s' }}>
          Stint {stintNumber}
        </span>
      </div>

      {/* Fuel bar + level */}
      <div>
        {/* Bar */}
        <div style={{
          width: '100%',
          height: 8,
          background: '#1a1a1a',
          borderRadius: 4,
          overflow: 'hidden',
          marginBottom: 4,
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(fuelPct * 100, 100)}%`,
            background: barColor,
            borderRadius: 4,
            transition: 'width 0.3s, background 0.3s',
          }} />
        </div>
        {/* Level text */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: fonts.heading, fontSize: 20, color: barColor, lineHeight: 1, transition: 'color 0.3s' }}>
            {fuelDisplay.toFixed(decimals)}{unit}
          </span>
          <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted }}>
            / {capacityDisplay.toFixed(decimals)}{unit} &nbsp; {(fuelPct * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Stats row: laps remaining / avg / stint laps */}
      <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
        {/* Laps remaining */}
        <div style={statBox}>
          <span style={{ fontFamily: fonts.heading, fontSize: 18, color: lapsColor(effectiveLapsRemaining), lineHeight: 1 }}>
            {formatLaps(effectiveLapsRemaining)}
          </span>
          <span style={statLabel}>Laps left</span>
        </div>
        {/* Avg consumption */}
        <div style={statBox}>
          <span style={{ fontFamily: fonts.heading, fontSize: 18, color: isFallbackAvg ? '#f97316' : colors.text, lineHeight: 1 }}>
            {formatAvg(avgDisplay, decimals)}
          </span>
          <span style={statLabel}>{unit}/lap {isFallbackAvg ? 'est.' : 'ø5'}</span>
        </div>
        {/* Stint laps */}
        <div style={statBox}>
          <span style={{ fontFamily: fonts.heading, fontSize: 18, color: colors.text, lineHeight: 1 }}>
            {stintLaps}
          </span>
          <span style={statLabel}>Stint laps</span>
        </div>
      </div>

      {/* Refuel estimate — prominent section */}
      <div style={{
        padding: '8px 10px',
        background: refuelDelta !== null ? `${refuelColor(refuelDelta)}18` : '#1a1a1a',
        border: `2px solid ${refuelDelta !== null ? refuelColor(refuelDelta) : '#2a2a2a'}`,
        borderRadius: 6,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
        transition: 'background 0.3s, border-color 0.3s',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
            Refuel
          </span>
          {refuelDelta !== null && refuelMode !== null ? (
            <span style={{ fontFamily: fonts.body, fontSize: 12, color: '#666' }}>
              {refuelMode === 'time'
                ? `~${refuelLapsEst!.toFixed(1)} laps · ref ${formatLapRef(avgLapTime)} · +${lapReserve} res.`
                : `${sessionLapsRemaining} laps left · +${lapReserve} res.`}
              {isFallbackAvg ? ' · est.' : ''}
            </span>
          ) : (
            <span style={{ fontFamily: fonts.body, fontSize: 12, color: '#555' }}>Waiting for data…</span>
          )}
        </div>
        <span style={{
          fontFamily: fonts.heading,
          fontSize: 26,
          lineHeight: 1,
          color: refuelDelta !== null ? refuelColor(refuelDelta) : '#444',
          letterSpacing: -0.5,
        }}>
          {refuelDelta !== null
            ? `${refuelDelta > 0 ? '+' : ''}${toDisplayFuel(refuelDelta).toFixed(decimals)}${unit}`
            : '---'}
        </span>
      </div>

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
