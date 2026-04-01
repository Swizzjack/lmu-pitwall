import { useRef, useState, useEffect, useMemo } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'
import { getClassColor } from '../../utils/classColors'
import type { VehicleScoring } from '../../types/telemetry'

const SECTOR_PB = '#22c55e'   // green — personal best in this sector
const SECTOR_SB = '#a855f7'   // purple — session best in this sector

function fmtSec(s: number): string {
  return s < 0 ? '---' : s.toFixed(3)
}

function fmtLap(s: number): string {
  if (s <= 0) return '--:--.---'
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(3).padStart(6, '0')}`
}

function fmtTimeDiff(diff: number): string {
  if (diff >= 60) {
    const m = Math.floor(diff / 60)
    return `+${m}:${(diff - m * 60).toFixed(3).padStart(6, '0')}`
  }
  return `+${diff.toFixed(3)}`
}

function fmtGap(v: VehicleScoring, leader: VehicleScoring, isRace: boolean): string {
  if (v.id === leader.id) return '—'
  if (isRace) {
    if (v.laps_behind_leader > 0) return `+${v.laps_behind_leader} lap${v.laps_behind_leader > 1 ? 's' : ''}`
    if (v.time_behind_leader > 0) return fmtTimeDiff(v.time_behind_leader)
    return '---'
  }
  // Practice / Qualifying: gap by best lap time
  if (v.best_lap_time <= 0 || leader.best_lap_time <= 0) return '---'
  const diff = v.best_lap_time - leader.best_lap_time
  if (diff < 0) return '---'
  return fmtTimeDiff(diff)
}

function bestS2(v: VehicleScoring): number {
  return v.best_sector1 > 0 && v.best_sector2 > 0 ? v.best_sector2 - v.best_sector1 : -1
}

function sectorColor(val: number, sessionBest: number, personalBest: number): string {
  if (val < 0) return colors.text
  if (isFinite(sessionBest) && Math.abs(val - sessionBest) < 0.001) return SECTOR_SB
  if (personalBest > 0 && Math.abs(val - personalBest) < 0.001) return SECTOR_PB
  return colors.text
}

export default function Standings() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(500)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setContainerWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const vehicles = useTelemetryStore((s) => s.scoring.vehicles)
  const playerId = useTelemetryStore((s) => s.scoring.player_vehicle_id)
  const sessionType = useTelemetryStore((s) => s.scoring.session_type)
  const numVehicles = useTelemetryStore((s) => s.scoring.num_vehicles)

  const isRace = sessionType?.toLowerCase().includes('race') ?? false

  const sorted = [...vehicles].sort((a: VehicleScoring, b: VehicleScoring) => a.position - b.position)
  const leader = sorted[0]

  // Compute class positions: rank within each vehicle_class (sorted already by overall position)
  const classPositions = useMemo(() => {
    const map = new Map<number, number>()
    const byClass = new Map<string, number>()
    for (const v of sorted) {
      const cls = v.vehicle_class || ''
      const rank = (byClass.get(cls) ?? 0) + 1
      byClass.set(cls, rank)
      map.set(v.id, rank)
    }
    return map
  }, [sorted])

  // Car name column only when widget is wide enough
  const showCarName = containerWidth >= 680

  // Session best per sector and lap (minimum across all vehicles with valid data)
  const validNums = (arr: number[]) => arr.filter((x) => x > 0)
  const sbS1 = Math.min(...validNums(sorted.map((v) => v.best_sector1)))
  const sbS2 = Math.min(...validNums(sorted.map(bestS2)))
  const sbS3 = Math.min(...validNums(sorted.map((v) => v.best_sector3)))
  const sbLap = Math.min(...validNums(sorted.map((v) => v.best_lap_time)))

  // Column widths — sized for 13px mono strings
  const W_POS = 32   // "P12"
  const W_NUM = 40   // "#99"
  const W_SEC = 58   // "88.888"
  const W_LAP = 76   // "1:28.888"
  const W_GAP = 72   // "+128.888"

  const colHdr = (label: string, width: number, right = true) => (
    <span style={{
      fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted,
      width, textAlign: right ? 'right' : 'left', flexShrink: 0,
    }}>
      {label}
    </span>
  )

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        paddingBottom: 6, borderBottom: `1px solid ${colors.border}`, marginBottom: 4,
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          {sessionType || 'Standings'}
        </span>
        <span style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted }}>
          {numVehicles} cars
        </span>
      </div>

      {/* Column header row */}
      {sorted.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px 3px', marginBottom: 2, borderBottom: `1px solid ${colors.border}33` }}>
          {colHdr('POS', W_POS)}
          {colHdr('#', W_NUM)}
          <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, flex: showCarName ? '2 1 140px' : 1, overflow: 'hidden' }}>DRIVER</span>
          {showCarName && <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, flex: '1 1 80px', overflow: 'hidden' }}>CAR</span>}
          {colHdr('S1', W_SEC)}
          {colHdr('S2', W_SEC)}
          {colHdr('S3', W_SEC)}
          {colHdr('BEST LAP', W_LAP)}
          {colHdr(isRace ? 'GAP' : 'GAP', W_GAP)}
        </div>
      )}

      {/* Table body */}
      {sorted.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontFamily: fonts.body, fontSize: 15 }}>
          Waiting for session…
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sorted.map((v) => {
            const isPlayer = v.id === playerId
            const vS1 = v.best_sector1
            const vS2 = bestS2(v)
            const vS3 = v.best_sector3
            const cS1 = sectorColor(vS1, sbS1, -1)
            const cS2 = sectorColor(vS2, sbS2, -1)
            const cS3 = sectorColor(vS3, sbS3, -1)

            return (
              <div key={v.id} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 4px', borderRadius: 3,
                background: isPlayer ? `${colors.primary}18` : 'transparent',
                borderLeft: isPlayer ? `2px solid ${colors.primary}` : '2px solid transparent',
                marginBottom: 1,
              }}>
                {/* Class position — colored by vehicle class */}
                <span style={{
                  fontFamily: fonts.mono, fontSize: 13,
                  color: isPlayer ? colors.primary : getClassColor(v.vehicle_class),
                  width: W_POS, textAlign: 'right', flexShrink: 0,
                  fontWeight: isPlayer ? 700 : 400,
                }}>
                  P{classPositions.get(v.id) ?? v.position}
                </span>

                {/* Car number */}
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.primary, width: W_NUM, textAlign: 'right', flexShrink: 0 }}>
                  #{v.car_number}
                </span>

                {/* Driver name + PIT badge */}
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  flex: showCarName ? '2 1 140px' : 1,
                  overflow: 'hidden', minWidth: 0,
                }}>
                  <span style={{
                    fontFamily: fonts.body, fontSize: 15,
                    color: isPlayer ? colors.primary : colors.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                  }}>
                    {isPlayer ? `★ ${v.driver_name || `Car #${v.id}`}` : (v.driver_name || `Car #${v.id}`)}
                  </span>
                  {v.in_pits && (
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 10, fontWeight: 700,
                      color: '#f97316', background: '#f9731622', border: '1px solid #f9731666',
                      borderRadius: 3, padding: '1px 4px', flexShrink: 0, lineHeight: 1.4,
                    }}>
                      PIT
                    </span>
                  )}
                </span>

                {/* Vehicle name (hidden when narrow) */}
                {showCarName && (
                  <span style={{
                    fontFamily: fonts.body, fontSize: 13, color: colors.textMuted,
                    flex: '1 1 80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                  }}>
                    {v.car_name}
                  </span>
                )}

                {/* Sector times */}
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: cS1, width: W_SEC, textAlign: 'right', flexShrink: 0 }}>{fmtSec(vS1)}</span>
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: cS2, width: W_SEC, textAlign: 'right', flexShrink: 0 }}>{fmtSec(vS2)}</span>
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: cS3, width: W_SEC, textAlign: 'right', flexShrink: 0 }}>{fmtSec(vS3)}</span>

                {/* Best lap time */}
                <span style={{
                  fontFamily: fonts.mono, fontSize: 13,
                  color: v.best_lap_time > 0 && isFinite(sbLap) && Math.abs(v.best_lap_time - sbLap) < 0.001 ? SECTOR_SB : colors.text,
                  width: W_LAP, textAlign: 'right', flexShrink: 0,
                }}>
                  {fmtLap(v.best_lap_time)}
                </span>

                {/* Gap to leader */}
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted, width: W_GAP, textAlign: 'right', flexShrink: 0 }}>
                  {leader ? fmtGap(v, leader, isRace) : '---'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
