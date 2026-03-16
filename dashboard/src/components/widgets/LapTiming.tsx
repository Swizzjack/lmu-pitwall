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

interface SectorRowProps {
  label: string
  time: number        // this lap sector time (-1 = not done)
  bestTime: number    // personal best for this sector (-1 = no best)
}

function SectorRow({ label, time, bestTime }: SectorRowProps) {
  let color: string = colors.textMuted
  if (time >= 0 && bestTime > 0) {
    // purple if equals/beats personal best, green if improved, yellow if slower
    if (time <= bestTime + 0.001) {
      color = purple
    } else {
      color = colors.success // can't be green if not beating best; use yellow for slower
    }
    if (time > bestTime + 0.001) {
      color = '#eab308' // yellow
    }
  } else if (time >= 0) {
    color = colors.text
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1, minWidth: 20 }}>
        {label}
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 15, color }}>
        {time >= 0 ? formatSector(time) : '-.---'}
      </span>
      {bestTime > 0 && (
        <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted, marginLeft: 4 }}>
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
        <div style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.text, letterSpacing: 1, lineHeight: 1.1 }}>
          {formatLapTime(currentLapTime)}
        </div>
      </div>

      {/* Current lap sectors */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' }}>
          Sectors (current)
        </span>
        <SectorRow label="S1" time={curS1}   bestTime={bestS1} />
        <SectorRow label="S2" time={curS2Only > 0 ? curS2Only : -1} bestTime={bestS2Only} />
        <SectorRow label="S3" time={-1}       bestTime={bestS3} />
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
