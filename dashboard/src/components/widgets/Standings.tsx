import { useRef, useState, useEffect, useMemo } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'
import { getClassColor } from '../../utils/classColors'
import { DAMAGE_ZONES, dentPct } from '../../utils/damage'
import type { VehicleScoring } from '../../types/telemetry'

function hexAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0')
  return `${hex}${a}`
}

function ClassBadge({ position, vehicleClass }: { position: string; vehicleClass: string }) {
  const base = getClassColor(vehicleClass)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 44, height: 24, flexShrink: 0,
      borderRadius: 4,
      background: hexAlpha(base, 0.15),
      border: `1px solid ${hexAlpha(base, 0.25)}`,
      fontFamily: fonts.mono, fontSize: 11, fontWeight: 700,
      color: base,
    }}>
      {position}
    </span>
  )
}

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

function compoundColor(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('soft') || n === 's')           return '#f5f5f5'   // white
  if (n.includes('medium') || n === 'm')          return '#eab308'   // yellow
  if (n.includes('hard') || n === 'h')            return '#ef4444'   // red
  if (n.includes('wet') || n.includes('rain') || n.includes('inter')) return '#3b82f6' // blue
  if (n.includes('slick'))                        return '#f97316'   // orange — LMU slick
  return '#a3a3a3'  // neutral gray for unknown
}

function bestS2(v: VehicleScoring): number {
  return v.best_sector1 > 0 && v.best_sector2 > 0 ? v.best_sector2 - v.best_sector1 : -1
}

function MiniDamageGrid({ dentSeverity, width }: { dentSeverity: number[]; width: number }) {
  const pct = dentPct(dentSeverity)
  const pctColor = pct >= 75 ? '#ef4444' : pct >= 40 ? '#f97316' : pct > 0 ? '#eab308' : colors.textMuted
  return (
    <div style={{ width, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 5px)', gridTemplateRows: 'repeat(3, 5px)', gap: '1px', flexShrink: 0 }}>
        {DAMAGE_ZONES.map(({ idx, col, row }) => {
          const sev = dentSeverity[idx] ?? 0
          return (
            <div key={idx} style={{
              gridColumn: col,
              gridRow: row,
              width: 5,
              height: 5,
              borderRadius: 1,
              background: sev === 2 ? '#ef4444' : sev === 1 ? '#f97316' : '#2a2a2a',
            }} />
          )
        })}
        <div style={{ gridColumn: 2, gridRow: 2, width: 5, height: 5, borderRadius: 1, background: '#161616' }} />
      </div>
      <span style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: pctColor, minWidth: 26, textAlign: 'right' }}>
        {pct > 0 ? `${pct}%` : '—'}
      </span>
    </div>
  )
}

function sectorColor(val: number, sessionBest: number, personalBest: number): string {
  if (val < 0) return colors.text
  if (isFinite(sessionBest) && Math.abs(val - sessionBest) < 0.001) return SECTOR_SB
  if (personalBest > 0 && Math.abs(val - personalBest) < 0.001) return SECTOR_PB
  return colors.text
}

export default function Standings() {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollableRef = useRef<HTMLDivElement>(null)
  const playerRowRef = useRef<HTMLDivElement>(null)
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
  const allDrivers = useTelemetryStore((s) => s.allDrivers.drivers)
  const settingShowCompound = useSettingsStore((s) => s.standingsShowCompound)
  const settingShowCarType  = useSettingsStore((s) => s.standingsShowCarType)
  const settingShowVE       = useSettingsStore((s) => s.standingsShowVE)

  const isRace = sessionType?.toLowerCase().includes('race') ?? false

  // Build compound lookup: driver id → compound name
  const compoundById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of allDrivers) {
      const front = d.tire_compound_front_name ?? ''
      const rear  = d.tire_compound_rear_name  ?? ''
      if (!front && !rear) continue
      // Use whichever name is non-empty; prefer front
      map.set(d.id, front || rear)
    }
    if (map.size > 0) {
      const sample = [...map.values()][0]
      console.debug('[Standings] compound sample:', sample, '| map size:', map.size)
    }
    return map
  }, [allDrivers])

  const sorted = useMemo(
    () => [...vehicles].sort((a: VehicleScoring, b: VehicleScoring) => a.position - b.position),
    [vehicles],
  )
  const leader = sorted[0]

  const playerPosition = useMemo(
    () => sorted.find(v => v.id === playerId)?.position ?? -1,
    [sorted, playerId],
  )
  useEffect(() => {
    const container = scrollableRef.current
    const row = playerRowRef.current
    if (!container || !row) return
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const rowOffsetInContainer = rowRect.top - containerRect.top + container.scrollTop
    const targetScrollTop = rowOffsetInContainer - container.clientHeight / 2 + rowRect.height / 2
    container.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
  }, [playerPosition, playerId])

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

  // Car name column only when widget is wide enough AND setting allows it
  const showCarName = settingShowCarType && containerWidth >= 680

  // VE column only when at least one vehicle has Virtual Energy data AND setting allows it
  const hasVeData = settingShowVE && sorted.some((v) => (v.virtual_energy ?? 0) > 0)

  // Compound column only when at least one driver has compound name data AND setting allows it
  const hasCompoundData = settingShowCompound && compoundById.size > 0

  // Damage column: show when any driver has at least one damaged zone
  const damageById = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const d of allDrivers) {
      if (d.dent_severity) map.set(d.id, Array.from(d.dent_severity))
    }
    return map
  }, [allDrivers])
  const hasDamageData = [...damageById.values()].some(s => s.some(v => v > 0))

  // Session best per sector and lap (minimum across all vehicles with valid data)
  const validNums = (arr: number[]) => arr.filter((x) => x > 0)
  const sbS1 = Math.min(...validNums(sorted.map((v) => v.best_sector1)))
  const sbS2 = Math.min(...validNums(sorted.map(bestS2)))
  const sbS3 = Math.min(...validNums(sorted.map((v) => v.best_sector3)))
  const sbLap = Math.min(...validNums(sorted.map((v) => v.best_lap_time)))

  // Column widths — sized for 13px mono strings
  const W_POS  = 44   // class position badge
  const W_NUM  = 40   // "#99"
  const W_SEC  = 58   // "88.888"
  const W_LAP  = 76   // "1:28.888"
  const W_LAST = 76   // "1:28.888"
  const W_GAP  = 72   // "+128.888"
  const W_VE   = 52   // "100%"
  const W_COMP = 52   // "Medium"
  const W_DMG  = 54   // 17px dots + 4px gap + 26px % text

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
          {hasCompoundData && colHdr('COMP', W_COMP)}
          {hasVeData && colHdr('VE', W_VE)}
          {hasDamageData && colHdr('DMG', W_DMG)}
          {colHdr('S1', W_SEC)}
          {colHdr('S2', W_SEC)}
          {colHdr('S3', W_SEC)}
          {colHdr('BEST LAP', W_LAP)}
          {colHdr('LAST LAP', W_LAST)}
          {colHdr('GAP', W_GAP)}
        </div>
      )}

      {/* Table body */}
      {sorted.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontFamily: fonts.body, fontSize: 15 }}>
          Waiting for session…
        </div>
      ) : (
        <div ref={scrollableRef} style={{ flex: 1, overflowY: 'auto' }}>
          {sorted.map((v) => {
            const isPlayer = v.id === playerId
            const vS1 = v.best_sector1
            const vS2 = bestS2(v)
            const vS3 = v.best_sector3
            const cS1 = sectorColor(vS1, sbS1, -1)
            const cS2 = sectorColor(vS2, sbS2, -1)
            const cS3 = sectorColor(vS3, sbS3, -1)

            return (
              <div key={v.id} ref={isPlayer ? playerRowRef : undefined} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 4px', borderRadius: 3,
                background: isPlayer ? `${colors.primary}18` : 'transparent',
                borderLeft: isPlayer ? `2px solid ${colors.primary}` : '2px solid transparent',
                marginBottom: 1,
              }}>
                {/* Class position badge */}
                <ClassBadge
                  position={`P${classPositions.get(v.id) ?? v.position}`}
                  vehicleClass={v.vehicle_class}
                />

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

                {/* Tire compound */}
                {hasCompoundData && (() => {
                  const name = compoundById.get(v.id) ?? ''
                  const col  = name && name !== '?' ? compoundColor(name) : '#a3a3a3'
                  const label = name || '?'
                  return (
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 11, fontWeight: 700,
                      color: col, border: `1px solid ${col}88`,
                      borderRadius: 3, padding: '1px 4px',
                      width: W_COMP, textAlign: 'center', flexShrink: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={name || 'Unknown'}>
                      {label}
                    </span>
                  )
                })()}

                {/* Virtual Energy */}
                {hasVeData && (() => {
                  const ve = v.virtual_energy ?? 0
                  const veColor = ve > 0.5 ? '#22c55e' : ve > 0.25 ? '#eab308' : ve > 0 ? '#ef4444' : colors.textMuted
                  return (
                    <span style={{
                      fontFamily: fonts.mono, fontSize: 11, fontWeight: 700,
                      color: veColor, border: `1px solid ${veColor}88`,
                      background: `${veColor}22`,
                      borderRadius: 3, padding: '1px 4px',
                      width: W_VE, textAlign: 'center', flexShrink: 0,
                    }}>
                      {ve > 0 ? `${Math.round(ve * 100)}%` : '—'}
                    </span>
                  )
                })()}

                {/* Damage grid */}
                {hasDamageData && (
                  <MiniDamageGrid
                    dentSeverity={damageById.get(v.id) ?? [0, 0, 0, 0, 0, 0, 0, 0]}
                    width={W_DMG}
                  />
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

                {/* Last lap time */}
                <span style={{
                  fontFamily: fonts.mono, fontSize: 13,
                  color: colors.textMuted,
                  width: W_LAST, textAlign: 'right', flexShrink: 0,
                }}>
                  {fmtLap(v.last_lap_time)}
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
