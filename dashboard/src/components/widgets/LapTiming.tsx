import { useState, useEffect, useRef } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

const purple = '#a855f7'

// Format seconds as mm:ss.xxx  (e.g. 1:32.456)
function formatLapTime(seconds: number): string {
  if (seconds < 0) return '--:--.---'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

// Format sector time as s.xxx (e.g. 32.456)  or mm:ss.xxx if ≥ 60s
function formatSector(seconds: number): string {
  if (seconds < 0) return '-.---'
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toFixed(3).padStart(6, '0')}`
  }
  return seconds.toFixed(3)
}

function formatDelta(delta: number): string {
  const sign = delta >= 0 ? '+' : '-'
  return `${sign}${Math.abs(delta).toFixed(3)}`
}

interface FrozenSectors { s1: number; s2: number; s3: number; lapDelta: number | null }

interface SectorRowProps {
  label: string
  time: number        // this lap sector time (-1 = not done)
  bestTime: number    // personal best for this sector (-1 = no best)
}

function SectorRow({ label, time, bestTime }: SectorRowProps) {
  let color: string = colors.textMuted
  let deltaColor: string = colors.textMuted

  if (time >= 0 && bestTime > 0) {
    if (time <= bestTime + 0.001) {
      color = purple
      deltaColor = purple
    } else {
      color = '#eab308'
      deltaColor = '#eab308'
    }
  } else if (time >= 0) {
    color = colors.text
  }

  const delta = (time >= 0 && bestTime > 0) ? time - bestTime : null

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1, minWidth: 20 }}>
        {label}
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 15, color }}>
        {time >= 0 ? formatSector(time) : '-.---'}
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 12, color: deltaColor, minWidth: 52, textAlign: 'center' }}>
        {delta !== null ? formatDelta(delta) : ''}
      </span>
      {bestTime > 0 && (
        <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted }}>
          ({formatSector(bestTime)})
        </span>
      )}
    </div>
  )
}

export default function LapTiming() {
  const currentEt   = useTelemetryStore((s) => s.telemetry.current_et)
  const lapStartEt  = useTelemetryStore((s) => s.telemetry.lap_start_et)
  const scoring     = useTelemetryStore((s) => s.scoring)

  // Find player vehicle in scoring
  const playerVeh = scoring.vehicles.find((v) => v.id === scoring.player_vehicle_id) ?? null

  // Current lap time computed live at 30Hz
  const currentLapTime = (currentEt > 0 && lapStartEt >= 0)
    ? currentEt - lapStartEt
    : -1

  const lastLap   = playerVeh?.last_lap_time ?? -1
  const bestLap   = playerVeh?.best_lap_time ?? -1
  const totalLaps = playerVeh?.total_laps ?? 0

  // Sector times from last lap
  const lastS1 = playerVeh?.last_sector1 ?? -1
  const lastS2 = playerVeh?.last_sector2 ?? -1   // cumulative S1+S2
  const lastS3 = (lastLap > 0 && lastS2 > 0) ? lastLap - lastS2 : -1

  // Current lap sectors (if already completed this lap)
  const curS1 = playerVeh?.cur_sector1 ?? -1
  const curS2 = playerVeh?.cur_sector2 ?? -1
  const curS2Only = (curS2 > 0 && curS1 > 0) ? curS2 - curS1 : -1

  // Personal best sector times (mBestSector1/2 are best individual, not from same lap)
  const bestS1 = playerVeh?.best_sector1 ?? -1
  const bestS2Full = playerVeh?.best_sector2 ?? -1  // cumulative S1+S2
  const bestS2Only = (bestS2Full > 0 && bestS1 > 0) ? bestS2Full - bestS1 : -1
  const bestS3 = (bestLap > 0 && bestS2Full > 0) ? bestLap - bestS2Full : -1

  const [frozenSectors, setFrozenSectors] = useState<FrozenSectors | null>(null)
  const prevTotalLaps = useRef(-1)
  // Bests snapshotted at lap start — used for delta to avoid comparing against an already-updated best
  const lapRefBests = useRef({ s1: bestS1, s2: bestS2Only, s3: bestS3, lap: bestLap })

  useEffect(() => {
    if (prevTotalLaps.current !== -1 && totalLaps > prevTotalLaps.current) {
      // Compute frozen lap delta against OLD ref before updating it
      const lapDelta = lastLap > 0 && lapRefBests.current.lap > 0
        ? lastLap - lapRefBests.current.lap
        : null

      // Snapshot bests for the new lap (bests achieved in all previous laps)
      lapRefBests.current = { s1: bestS1, s2: bestS2Only, s3: bestS3, lap: bestLap }

      if (lastS3 > 0) {
        const sectors: FrozenSectors = {
          s1: lastS1,
          s2: (lastS2 > 0 && lastS1 > 0) ? lastS2 - lastS1 : -1,
          s3: lastS3,
          lapDelta,
        }
        const t0 = setTimeout(() => setFrozenSectors(sectors), 0)
        const t1 = setTimeout(() => setFrozenSectors(null), 5000)
        prevTotalLaps.current = totalLaps
        return () => { clearTimeout(t0); clearTimeout(t1) }
      }
    }
    prevTotalLaps.current = totalLaps
  }, [totalLaps, bestS1, bestS2Only, bestS3, bestLap, lastS1, lastS2, lastS3, lastLap])

  // Live lap delta: cumulative sector gap vs reference, updated at each sector crossing
  let liveLapDelta: number | null = null
  const refS1 = lapRefBests.current.s1
  const refS2 = lapRefBests.current.s2
  if (curS2Only > 0 && refS1 > 0 && refS2 > 0) {
    liveLapDelta = (curS1 + curS2Only) - (refS1 + refS2)
  } else if (curS1 > 0 && refS1 > 0) {
    liveLapDelta = curS1 - refS1
  }
  // Show live if we have current-lap data; fall back to frozen at lap start
  const displayLapDelta = curS1 > 0 ? liveLapDelta : (frozenSectors?.lapDelta ?? null)

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '4px 2px',
      overflow: 'hidden',
    }}>
      {/* Header: Lap counter */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Lap Timing
        </span>
        {totalLaps > 0 && (
          <span style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.primary }}>
            Lap {totalLaps + 1}
          </span>
        )}
      </div>

      {/* Current lap time */}
      <div>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' }}>
          Current
        </span>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.text, letterSpacing: 1, lineHeight: 1.1 }}>
            {formatLapTime(currentLapTime)}
          </span>
          {displayLapDelta !== null && (
            <span style={{ fontFamily: fonts.mono, fontSize: 18, color: displayLapDelta <= 0 ? colors.success : colors.danger }}>
              {formatDelta(displayLapDelta)}
            </span>
          )}
        </div>
      </div>

      {/* Current lap sectors */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' }}>
          Sectors (current)
        </span>
        <SectorRow label="S1" time={curS1 > 0 ? curS1 : (frozenSectors?.s1 ?? -1)} bestTime={lapRefBests.current.s1} />
        <SectorRow label="S2" time={curS2Only > 0 ? curS2Only : (frozenSectors?.s2 ?? -1)} bestTime={lapRefBests.current.s2} />
        <SectorRow label="S3" time={frozenSectors?.s3 ?? -1} bestTime={lapRefBests.current.s3} />
      </div>

      {/* Last lap */}
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${colors.border}`, paddingTop: 4 }}>
        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' }}>Last</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.text }}>{formatLapTime(lastLap)}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted }}>{formatSector(lastS1)}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted }}>
              {(lastS2 > 0 && lastS1 > 0) ? formatSector(lastS2 - lastS1) : '-.---'}
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted }}>{formatSector(lastS3)}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: fonts.body, fontSize: 15, color: purple, letterSpacing: 1, textTransform: 'uppercase' }}>Best</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 15, color: purple }}>{formatLapTime(bestLap)}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: `${purple}99` }}>{formatSector(bestS1)}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: `${purple}99` }}>{formatSector(bestS2Only)}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: `${purple}99` }}>{formatSector(bestS3)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
