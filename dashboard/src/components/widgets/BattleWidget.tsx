import { useRef, useState, useEffect, useMemo } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'
import { getClassColor } from '../../utils/classColors'
import { hexAlpha, fmtSec, fmtLap, fmtTimeDiff, sectorColor, bestS2, lastS2 } from '../../utils/lapFormat'
import type { VehicleScoring } from '../../types/telemetry'

// Minimal class-coloured position badge (mirrors Standings' ClassBadge)
function PosBadge({ label, vehicleClass }: { label: string; vehicleClass: string }) {
  const base = getClassColor(vehicleClass)
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 40, height: 22, flexShrink: 0, borderRadius: 4,
      background: hexAlpha(base, 0.15), border: `1px solid ${hexAlpha(base, 0.25)}`,
      fontFamily: fonts.mono, fontSize: 11, fontWeight: 700, color: base,
    }}>
      {label}
    </span>
  )
}

// Shortest signed distance from player to other along the track (metres).
// Positive = other is ahead on track, negative = behind.
function signedTrackDist(otherDist: number, playerDist: number, trackLength: number): number {
  let raw = otherDist - playerDist
  if (trackLength > 0) {
    if (raw > trackLength / 2) raw -= trackLength
    else if (raw < -trackLength / 2) raw += trackLength
  }
  return raw
}

interface Row {
  v: VehicleScoring
  gap: string          // formatted, signed (negative = ahead, positive = behind); '—' for player
  isPlayer: boolean
}

export default function BattleWidget() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(420)

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
  const trackLength = useTelemetryStore((s) => s.session.track_length)
  const playerSpeed = useTelemetryStore((s) => s.telemetry.speed_ms)

  const mode = useSettingsStore((s) => s.battleMode)
  const count = useSettingsStore((s) => s.battleCount)
  const showPosName = useSettingsStore((s) => s.battleShowPosName)
  const showSectors = useSettingsStore((s) => s.battleShowSectors)
  const showLaps = useSettingsStore((s) => s.battleShowLaps)
  const showGap = useSettingsStore((s) => s.battleShowGap)

  const isRace = sessionType?.toLowerCase().includes('race') ?? false

  // Session best per sector (minimum across all vehicles with valid data)
  const validNums = (arr: number[]) => arr.filter((x) => x > 0)
  const sbS1 = useMemo(() => Math.min(...validNums(vehicles.map((v) => v.best_sector1))), [vehicles])
  const sbS2 = useMemo(() => Math.min(...validNums(vehicles.map(bestS2))), [vehicles])
  const sbS3 = useMemo(() => Math.min(...validNums(vehicles.map((v) => v.best_sector3))), [vehicles])

  // Effective track length: prefer session value, fall back to furthest lap_dist seen
  const effTrackLength = useMemo(() => {
    if (trackLength > 0) return trackLength
    const maxDist = Math.max(0, ...vehicles.map((v) => v.lap_dist))
    return maxDist
  }, [trackLength, vehicles])

  const rows: Row[] = useMemo(() => {
    const player = vehicles.find((v) => v.id === playerId)
    if (!player) return []

    const fmtBattleGap = (other: VehicleScoring): string => {
      if (other.id === player.id) return '—'
      if (isRace) {
        const lapDiff = other.laps_behind_leader - player.laps_behind_leader
        if (lapDiff !== 0) return `${lapDiff > 0 ? '+' : '-'}${Math.abs(lapDiff)}L`
        return fmtTimeDiff(other.time_behind_leader - player.time_behind_leader)
      }
      // Practice / Qualifying: compare best lap times
      if (other.best_lap_time <= 0 || player.best_lap_time <= 0) return '---'
      return fmtTimeDiff(other.best_lap_time - player.best_lap_time)
    }

    if (mode === 'relative') {
      const speed = Math.max(playerSpeed, 5)   // avoid divide-by-zero when stopped
      const withDist = vehicles
        .filter((v) => v.id !== player.id)
        .map((v) => ({ v, dist: signedTrackDist(v.lap_dist, player.lap_dist, effTrackLength) }))
      const ahead = withDist.filter((x) => x.dist > 0).sort((a, b) => a.dist - b.dist).slice(0, count)
      const behind = withDist.filter((x) => x.dist <= 0).sort((a, b) => b.dist - a.dist).slice(0, count)
      const ordered = [
        ...ahead.sort((a, b) => b.dist - a.dist),   // farthest ahead first
        { v: player, dist: 0 },
        ...behind,                                   // nearest behind first
      ]
      return ordered.map(({ v, dist }) => ({
        v,
        isPlayer: v.id === player.id,
        gap: v.id === player.id ? '—' : fmtTimeDiff(-dist / speed),
      }))
    }

    // Battle mode: nearest by standings position
    const sorted = [...vehicles].sort((a, b) => a.position - b.position)
    const idx = sorted.findIndex((v) => v.id === player.id)
    if (idx < 0) return []
    const slice = sorted.slice(Math.max(0, idx - count), idx + count + 1)
    return slice.map((v) => ({
      v,
      isPlayer: v.id === player.id,
      gap: fmtBattleGap(v),
    }))
  }, [vehicles, playerId, mode, count, isRace, playerSpeed, effTrackLength])

  // Column widths
  const W_POS = 40
  const W_NUM = 36
  const W_SEC = 54
  const W_LAP = 72
  const W_GAP = 72
  const showName = containerWidth >= 240

  const colHdr = (label: string, width: number) => (
    <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted, width, textAlign: 'right', flexShrink: 0 }}>
      {label}
    </span>
  )

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        paddingBottom: 6, borderBottom: `1px solid ${colors.border}`, marginBottom: 4,
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Battle
        </span>
        <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted }}>
          {mode === 'relative' ? 'Relative' : 'Position'}
        </span>
      </div>

      {/* Column header row */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px 3px', marginBottom: 2, borderBottom: `1px solid ${colors.border}33` }}>
          {showPosName && colHdr('POS', W_POS)}
          {showPosName && colHdr('#', W_NUM)}
          <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, flex: 1, overflow: 'hidden' }}>DRIVER</span>
          {showSectors && colHdr('S1', W_SEC)}
          {showSectors && colHdr('S2', W_SEC)}
          {showSectors && colHdr('S3', W_SEC)}
          {showLaps && colHdr('BEST', W_LAP)}
          {showLaps && colHdr('LAST', W_LAP)}
          {showGap && colHdr('GAP', W_GAP)}
        </div>
      )}

      {/* Body */}
      {rows.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontFamily: fonts.body, fontSize: 15 }}>
          Waiting for session…
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rows.map(({ v, gap, isPlayer }) => {
            const c1 = sectorColor(v.last_sector1, sbS1, v.best_sector1)
            const c2 = sectorColor(lastS2(v), sbS2, bestS2(v))
            const c3 = sectorColor(v.last_sector3, sbS3, v.best_sector3)
            return (
              <div key={v.id} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 4px', borderRadius: 3, marginBottom: 1,
                background: isPlayer ? `${colors.primary}18` : 'transparent',
                borderLeft: isPlayer ? `2px solid ${colors.primary}` : '2px solid transparent',
              }}>
                {showPosName && <PosBadge label={`P${v.position}`} vehicleClass={v.vehicle_class} />}
                {showPosName && (
                  <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.primary, width: W_NUM, textAlign: 'right', flexShrink: 0 }}>
                    #{v.car_number}
                  </span>
                )}
                {showName && (
                  <span style={{
                    fontFamily: fonts.body, fontSize: 15,
                    color: isPlayer ? colors.primary : colors.text,
                    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                  }}>
                    {isPlayer ? `★ ${v.driver_name || `Car #${v.id}`}` : (v.driver_name || `Car #${v.id}`)}
                  </span>
                )}
                {!showName && <span style={{ flex: 1 }} />}

                {showSectors && (
                  <>
                    <span style={{ fontFamily: fonts.mono, fontSize: 13, color: c1, width: W_SEC, textAlign: 'right', flexShrink: 0 }}>{fmtSec(v.last_sector1)}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 13, color: c2, width: W_SEC, textAlign: 'right', flexShrink: 0 }}>{fmtSec(lastS2(v))}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 13, color: c3, width: W_SEC, textAlign: 'right', flexShrink: 0 }}>{fmtSec(v.last_sector3)}</span>
                  </>
                )}

                {showLaps && (
                  <>
                    <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text, width: W_LAP, textAlign: 'right', flexShrink: 0 }}>{fmtLap(v.best_lap_time)}</span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted, width: W_LAP, textAlign: 'right', flexShrink: 0 }}>{fmtLap(v.last_lap_time)}</span>
                  </>
                )}

                {showGap && (
                  <span style={{
                    fontFamily: fonts.mono, fontSize: 13, fontWeight: isPlayer ? 400 : 700,
                    color: isPlayer ? colors.textMuted : colors.text,
                    width: W_GAP, textAlign: 'right', flexShrink: 0,
                  }}>
                    {gap}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
