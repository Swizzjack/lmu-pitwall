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

function fmtTime(sec: number | null): string {
  if (sec === null || sec < 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function FuelManager() {
  const fuel             = useTelemetryStore((s) => s.telemetry.fuel)
  const fuelCapacity     = useTelemetryStore((s) => s.telemetry.fuel_capacity)
  const fuelPct          = useTelemetryStore((s) => s.telemetry.fuel_pct)
  const avgConsumption   = useTelemetryStore((s) => s.telemetry.fuel_avg_consumption)
  const sampleCount      = useTelemetryStore((s) => s.telemetry.fuel_avg_sample_count)
  const lapsRemaining    = useTelemetryStore((s) => s.telemetry.fuel_laps_remaining)
  const stintNumber      = useTelemetryStore((s) => s.telemetry.fuel_stint_number)
  const pitDetected      = useTelemetryStore((s) => s.telemetry.fuel_pit_detected)
  const avgLapTimeFromBridge = useTelemetryStore((s) => s.telemetry.fuel_avg_lap_time)
  const sessionMinutes   = useTelemetryStore((s) => s.session.session_minutes)
  const sessionLaps      = useTelemetryStore((s) => s.session.session_laps)
  const sessionTime      = useTelemetryStore((s) => s.scoring.session_time)
  const sessionType      = useTelemetryStore((s) => s.scoring.session_type)
  const scoring          = useTelemetryStore((s) => s.scoring)
  const veHistory        = useTelemetryStore((s) => s.telemetry.ve_history)
  const veAvailable      = useTelemetryStore((s) => s.telemetry.ve_available)
  const virtualEnergy    = useTelemetryStore((s) => s.electronics.virtual_energy)

  const toDisplayFuel = useSettingsStore((s) => s.toDisplayFuel)
  const fuelUnitLabel = useSettingsStore((s) => s.fuelUnitLabel)
  const lapReserve    = useSettingsStore((s) => s.lapReserve)

  const unit     = fuelUnitLabel()
  const decimals = unit === 'gal' ? 2 : 1

  const hasData = sampleCount > 0

  // --- Average lap time (rolling median from bridge, fallback to scoring) ---
  const playerVeh = scoring.vehicles.find((v) => v.id === scoring.player_vehicle_id) ?? null
  const lastLap   = playerVeh?.last_lap_time ?? 0
  const bestLap   = playerVeh?.best_lap_time ?? 0

  const avgLapTime = isValidLapTime(avgLapTimeFromBridge)
    ? avgLapTimeFromBridge
    : isValidLapTime(lastLap) ? lastLap
    : isValidLapTime(bestLap) ? bestLap
    : 0

  // --- VE data ---
  const veHistLen    = veHistory?.length ?? 0
  const lastKnownVe  = veHistory && veHistory.length > 0 ? veHistory[veHistory.length - 1] : null
  const veConsPerLap = veHistory ? veConsumptionPerLap(veHistory) : null

  // --- Remaining session time (ground truth) ---
  const remainingSec = sessionMinutes > 0
    ? Math.max(0, sessionMinutes * 60 - sessionTime)
    : 0

  // --- VE vehicle detection ---
  const noVeVehicle = veAvailable === null
    ? veHistory === null
    : veAvailable === false

  // --- Total laps needed to finish the race ---
  // Math.ceil handles the current partial lap; lapReserve is user-configurable.
  const totalLapsNeeded: number | null = (() => {
    if (!isValidLapTime(avgLapTime)) return null
    if (sessionLaps > 0 && playerVeh !== null) {
      // Lap-based session: exact remaining laps
      return Math.max(0, sessionLaps - (playerVeh.total_laps ?? 0)) + lapReserve
    }
    if (sessionMinutes > 0 && remainingSec > 0) {
      return Math.ceil(remainingSec / avgLapTime) + lapReserve
    }
    return null
  })()

  // --- VE refuel: latched at lap crossings to prevent intra-lap drift ---
  const latchRef = useRef<{
    histLen:    number
    refuelPct:  number | null
    extraStops: number
    remLaps:    number | null
  }>({ histLen: 0, refuelPct: null, extraStops: 0, remLaps: null })

  // Reset latch when the bridge clears ve_history on session restart
  if (veHistLen < latchRef.current.histLen) {
    latchRef.current = { histLen: 0, refuelPct: null, extraStops: 0, remLaps: null }
  }

  const canCalcVe = lastKnownVe !== null && veConsPerLap !== null
    && sessionMinutes > 0 && isValidLapTime(avgLapTime)

  if (canCalcVe && veHistLen > 0 && veHistLen !== latchRef.current.histLen) {
    const remLaps    = totalLapsNeeded ?? (Math.ceil(remainingSec / avgLapTime) + 1 + lapReserve)
    const neededVe   = remLaps * veConsPerLap!
    const extraStops = Math.max(0, Math.ceil(neededVe) - 1)
    latchRef.current = {
      histLen:    veHistLen,
      refuelPct:  Math.min(Math.ceil(neededVe * 100), 100),
      extraStops,
      remLaps,
    }
  }

  const refuelVeDisplay    = latchRef.current.refuelPct
  const refuelVeExtraStops = latchRef.current.extraStops
  // --- Fuel refuel (non-VE vehicles): delta = liters to ADD ---
  const neededFuelTotal = (noVeVehicle && hasData && totalLapsNeeded !== null)
    ? totalLapsNeeded * avgConsumption
    : null
  const refuelFuelDelta = neededFuelTotal !== null
    ? Math.max(0, Math.min(
        Math.ceil((neededFuelTotal - fuel) * 10) / 10,
        fuelCapacity - fuel,
      ))
    : null
  const remLapsFuel    = (totalLapsNeeded !== null && noVeVehicle) ? Math.ceil(totalLapsNeeded) : null
  const fuelExtraStops = neededFuelTotal !== null
    ? Math.max(0, Math.ceil(neededFuelTotal / fuelCapacity) - 1)
    : 0

  // --- Remaining row ---
  const fuelLapsLeft = (hasData && isFinite(lapsRemaining)) ? lapsRemaining : null

  // veLapsLeft = 0 when virtualEnergy = 0 → correctly triggers PIT NOW via effectiveLapsLeft
  const veLapsLeft = (!noVeVehicle && veConsPerLap !== null && veConsPerLap > 0)
    ? virtualEnergy / veConsPerLap
    : null

  const effectiveLapsLeft = noVeVehicle
    ? fuelLapsLeft
    : (veLapsLeft !== null && fuelLapsLeft !== null
        ? Math.min(fuelLapsLeft, veLapsLeft)
        : veLapsLeft ?? fuelLapsLeft)

  const remainingTimeSec = (effectiveLapsLeft !== null && isValidLapTime(avgLapTime))
    ? effectiveLapsLeft * avgLapTime
    : null

  // LMU always uses rolling start: total_laps includes the formation lap,
  // so total_laps already equals the game-displayed lap number.
  const currentLap = playerVeh?.total_laps ?? 1

  // --- Smoothed remaining time (Option B: lap-start anchor) ---
  // Re-anchor once per lap crossing; between crossings count down 1:1 with session time.
  // This eliminates intra-lap noise caused by varying fuel burn rate (brake vs. straight).
  const timeLatchRef = useRef<{
    lap: number
    sessionTime: number
    fuelTimeSec: number
  } | null>(null)

  // --- Refuel + Planner latch (frozen between lap crossings) ---
  const refuelPlannerLatchRef = useRef<{
    lap:                    number
    refuelFuelDelta:        number | null
    refuelVePct:            number | null
    extraStops:             number
    remLapsFuel:            number | null
    estimatedRemainingLaps: number | null
    pitLap:                 number | null
    showPlanner:            boolean
    pitNow:                 boolean
    noStopNeeded:           boolean
    plannerCells: Array<{
      L:            number
      display:      string
      isOptimal:    boolean
      isUnreachable:boolean
      isPast:       boolean
    }>
  } | null>(null)

  if (remainingTimeSec !== null) {
    if (timeLatchRef.current === null || currentLap !== timeLatchRef.current.lap) {
      timeLatchRef.current = { lap: currentLap, sessionTime, fuelTimeSec: remainingTimeSec }
    }
  } else {
    timeLatchRef.current = null
  }

  const smoothedRemainingTime = timeLatchRef.current !== null
    ? Math.max(0, timeLatchRef.current.fuelTimeSec - (sessionTime - timeLatchRef.current.sessionTime))
    : null

  // --- Pit Lap Planner ---
  const isRace = sessionType?.toLowerCase().includes('race') ?? false
  void isRace

  const raceLapsRemaining: number | null = (() => {
    if (sessionLaps > 0) return sessionLaps - (playerVeh?.total_laps ?? 0)
    if (remainingSec > 0 && isValidLapTime(avgLapTime)) return remainingSec / avgLapTime
    return null
  })()

  // Optimal pit lap: latest lap reachable on current fuel/VE
  const optimalPitLap = effectiveLapsLeft !== null
    ? currentLap + Math.floor(effectiveLapsLeft)
    : null

  // No stop needed: current resources cover all laps required to finish
  const noStopNeeded = effectiveLapsLeft !== null && totalLapsNeeded !== null
    && effectiveLapsLeft >= totalLapsNeeded

  const pitNow = optimalPitLap !== null && optimalPitLap <= currentLap && !noStopNeeded

  const refuelKnown = noVeVehicle ? refuelFuelDelta !== null : refuelVeDisplay !== null

  const showPlanner = refuelKnown
    && raceLapsRemaining !== null && raceLapsRemaining > 0
    && effectiveLapsLeft !== null
    && !noStopNeeded

  const plannerScenarios = (showPlanner && optimalPitLap !== null && !pitNow)
    ? [-3, -2, -1, 0, 1].map((offset) => optimalPitLap + offset)
    : []

  function calcScenarioRefuel(L: number): {
    display:       string
    rawFuelDelta:  number | null   // liters to ADD at this stop
    rawVeTarget:   number | null   // VE% to SET in MFD
    extraStops:    number          // additional pit stops needed beyond this one
    isOptimal:     boolean
    isUnreachable: boolean
    isPast:        boolean
  } {
    const isOptimal     = L === optimalPitLap
    const isUnreachable = (L - currentLap) > (effectiveLapsLeft ?? 0)
    const isPast        = L <= currentLap

    if (isPast || raceLapsRemaining === null) {
      return { display: '---', rawFuelDelta: null, rawVeTarget: null, extraStops: 0, isOptimal, isUnreachable, isPast }
    }

    const lapsToL = L - currentLap

    // Laps needed after pitting at L (+1 for post-flag lap in time-based sessions)
    let lapsAfterPit: number
    if (sessionLaps > 0) {
      const remaining = sessionLaps - ((playerVeh?.total_laps ?? 0) + lapsToL)
      lapsAfterPit = Math.max(0, remaining) + lapReserve
    } else {
      const timeToReachL      = lapsToL * avgLapTime
      const remainingAfterPit = remainingSec - timeToReachL
      lapsAfterPit = remainingAfterPit > 0
        ? Math.ceil(remainingAfterPit / avgLapTime) + lapReserve
        : lapReserve
    }

    let display      = '---'
    let rawFuelDelta: number | null = null
    let rawVeTarget:  number | null = null
    let extraStops   = 0

    if (noVeVehicle && hasData && avgConsumption > 0) {
      const fuelAtL      = fuel - lapsToL * avgConsumption
      const neededTotal  = lapsAfterPit * avgConsumption
      const spaceInTank  = fuelCapacity - Math.max(0, fuelAtL)
      const delta        = Math.max(0, neededTotal - fuelAtL)
      rawFuelDelta       = Math.min(Math.ceil(delta * 10) / 10, spaceInTank)
      extraStops         = Math.max(0, Math.ceil(neededTotal / fuelCapacity) - 1)

      display = rawFuelDelta <= 0.05
        ? `0${unit}`
        : `+${toDisplayFuel(rawFuelDelta).toFixed(decimals)}${unit}`
      if (extraStops > 0) display += ` (${extraStops})`

    } else if (!noVeVehicle && veConsPerLap !== null && veConsPerLap > 0) {
      const neededVeTotal = lapsAfterPit * veConsPerLap
      const veTargetRaw   = Math.ceil(neededVeTotal * 100)
      extraStops          = Math.max(0, Math.ceil(neededVeTotal) - 1)
      rawVeTarget         = Math.min(veTargetRaw, 100)

      display = rawVeTarget <= 0 ? '0%' : `${rawVeTarget}%`
      if (extraStops > 0) display += ` (${extraStops})`
    }

    return { display, rawFuelDelta, rawVeTarget, extraStops, isOptimal, isUnreachable, isPast }
  }

  // Compute optimal scenario once — drives both the REFUEL box and the planner's optimal cell
  const optimalCell = (!pitNow && showPlanner && optimalPitLap !== null)
    ? calcScenarioRefuel(optimalPitLap)
    : null

  // When planner is visible, use planner formula for the REFUEL box.
  // When no stop is needed (enough fuel/VE to finish), always show 0.
  const effectiveRefuelFuelDelta = noStopNeeded ? 0 : (optimalCell?.rawFuelDelta ?? refuelFuelDelta)
  const effectiveRefuelVePct     = noStopNeeded ? 0 : (optimalCell?.rawVeTarget  ?? refuelVeDisplay)
  const effectiveExtraStops      = noStopNeeded ? 0 : (optimalCell?.extraStops   ?? (noVeVehicle ? fuelExtraStops : refuelVeExtraStops))

  // --- Lap-crossing latch: Refuel box + Planner frozen between crossings ---
  // Reset on session restart (lap counter drops)
  if (refuelPlannerLatchRef.current !== null && currentLap < refuelPlannerLatchRef.current.lap) {
    refuelPlannerLatchRef.current = null
  }
  if (refuelPlannerLatchRef.current === null || currentLap !== refuelPlannerLatchRef.current.lap) {
    refuelPlannerLatchRef.current = {
      lap:                    currentLap,
      refuelFuelDelta:        effectiveRefuelFuelDelta,
      refuelVePct:            effectiveRefuelVePct,
      extraStops:             effectiveExtraStops,
      remLapsFuel:            remLapsFuel,
      estimatedRemainingLaps: latchRef.current.remLaps,
      pitLap:                 optimalPitLap,
      showPlanner,
      pitNow,
      noStopNeeded,
      plannerCells: plannerScenarios.map((L) => {
        const r = calcScenarioRefuel(L)
        return { L, display: r.display, isOptimal: r.isOptimal, isUnreachable: r.isUnreachable, isPast: r.isPast }
      }),
    }
  }
  const latched = refuelPlannerLatchRef.current

  // --- Display helpers ---
  const barColor   = fuelBarColor(fuelPct)
  const stintColor = pitDetected ? '#facc15' : colors.textMuted

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

      {/* Virtual Energy current state — live value from shared memory */}
      {virtualEnergy > 0 && (
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
          <span style={{ fontFamily: fonts.heading, fontSize: 16, color: veBarColor(virtualEnergy), minWidth: 44, textAlign: 'right' }}>
            {Math.round(virtualEnergy * 100)}%
          </span>
          <div style={{ flex: 1, height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min(virtualEnergy * 100, 100)}%`,
              background: veBarColor(virtualEnergy),
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

      {/* Remaining: REMAINING TIME | REMAINING LAPS */}
      <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
        <div style={statBox}>
          <span style={{
            fontFamily: fonts.heading, fontSize: 18, lineHeight: 1,
            color: smoothedRemainingTime !== null ? colors.text : colors.textMuted,
          }}>
            {fmtTime(smoothedRemainingTime)}
          </span>
          <span style={statLabel}>Remaining Time</span>
        </div>
        <div style={statBox}>
          <span style={{
            fontFamily: fonts.heading, fontSize: 18, lineHeight: 1,
            color: effectiveLapsLeft !== null ? lapsColor(effectiveLapsLeft) : colors.textMuted,
          }}>
            {effectiveLapsLeft !== null ? effectiveLapsLeft.toFixed(1) : '---'}
          </span>
          <span style={statLabel}>Remaining Laps</span>
        </div>
      </div>

      {/* REFUEL — VE% target for hybrid cars, fuel delta for non-VE cars */}
      {/* Values are latched at each S/F crossing to prevent intra-lap drift */}
      {noVeVehicle ? (() => {
        const dispFuel  = latched.refuelFuelDelta
        const dispColor = dispFuel !== null ? (dispFuel <= 0.05 ? '#22c55e' : '#ef4444') : '#444'
        const dispStr   = dispFuel === null ? '---'
          : dispFuel <= 0.05
            ? `0${unit}${latched.extraStops > 0 ? ` (${latched.extraStops})` : ''}`
            : `+${toDisplayFuel(dispFuel).toFixed(decimals)}${unit}${latched.extraStops > 0 ? ` (${latched.extraStops})` : ''}`
        return (
          <div style={{
            padding: '8px 12px',
            background: dispFuel !== null ? `${dispColor}18` : '#1a1a1a',
            border: `2px solid ${dispFuel !== null ? dispColor : '#2a2a2a'}`,
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
              {latched.remLapsFuel !== null ? (
                <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555' }}>
                  ~{latched.remLapsFuel} laps
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
              color: dispFuel !== null ? dispColor : '#444',
              letterSpacing: -1,
            }}>
              {dispStr}
            </span>
          </div>
        )
      })() : (() => {
        const dispPct   = latched.refuelVePct
        const dispColor = dispPct !== null ? (dispPct <= 0 ? '#22c55e' : '#ef4444') : '#444'
        const dispStr   = dispPct === null ? '---'
          : `${dispPct}%${latched.extraStops > 0 ? ` (${latched.extraStops})` : ''}`
        return (
          <div style={{
            padding: '8px 12px',
            background: dispPct !== null ? `${dispColor}18` : '#1a1a1a',
            border: `2px solid ${dispPct !== null ? dispColor : '#2a2a2a'}`,
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
              {dispPct !== null ? (
                <span style={{ fontFamily: fonts.body, fontSize: 11, color: '#555' }}>
                  ~{latched.estimatedRemainingLaps} laps
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
              color: dispPct !== null ? dispColor : '#444',
              letterSpacing: -1,
            }}>
              {dispStr}
            </span>
          </div>
        )
      })()}

      {/* Pit Lap Planner — latched at S/F crossing */}
      {latched.showPlanner && (
        latched.pitNow ? (
          <div style={{
            textAlign: 'center',
            padding: '6px 0',
            fontFamily: fonts.heading,
            fontSize: 16,
            color: '#ef4444',
            letterSpacing: 2,
            background: '#ef444414',
            borderRadius: 4,
            border: '1px solid #ef4444',
          }}>
            PIT NOW
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{
              fontFamily: fonts.body, fontSize: 10, color: '#555',
              textTransform: 'uppercase', letterSpacing: 1,
              textAlign: 'center',
            }}>
              Pit Lap Planner
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {latched.plannerCells.map(({ L, display, isOptimal, isUnreachable, isPast }) => {
                const textColor = isOptimal
                  ? '#22c55e'
                  : isUnreachable ? '#ef4444'
                  : isPast ? '#333'
                  : colors.textMuted
                const borderColor = isOptimal
                  ? '#22c55e'
                  : isUnreachable ? '#ef444460'
                  : '#2a2a2a'
                const bg = isOptimal ? '#22c55e12' : '#111'
                return (
                  <div key={L} style={{
                    flex: 1,
                    background: bg,
                    border: `1px solid ${borderColor}`,
                    borderRadius: 4,
                    padding: '4px 2px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 2,
                  }}>
                    <span style={{ fontFamily: fonts.heading, fontSize: 13, lineHeight: 1, color: textColor }}>
                      L{L}
                    </span>
                    <span style={{ fontFamily: fonts.body, fontSize: 11, lineHeight: 1, color: textColor }}>
                      {display}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
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
