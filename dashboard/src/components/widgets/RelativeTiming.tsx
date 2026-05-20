import { useMemo, useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

const WINDOW = 3

function fmtLap(s: number): string {
    if (s <= 0) return '—'
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toFixed(3).padStart(6, '0')}`
}

function fmtGap(gap: number): string {
    const sign = gap >= 0 ? '+' : ''
    return `${sign}${gap.toFixed(3)}s`
}

function fmtDelta(delta: number): string {
    const sign = delta >= 0 ? '+' : ''
    return `${sign}${delta.toFixed(3)}`
}

/** delta > 0 = car moving away from player.
 *  Ahead car moving away = bad (red). Behind car moving away = good (green). */
function deltaColor(delta: number, isAhead: boolean): string {
    if (Math.abs(delta) < 0.001) return colors.textMuted
    if (isAhead) return delta > 0 ? '#ef4444' : '#22c55e'
    return delta > 0 ? '#22c55e' : '#ef4444'
}

interface SectorState {
    /** Sector key that triggered this snapshot */
    key: string
    /** Gap to each vehicle (by id) at the last sector boundary */
    gaps: Map<number, number>
    /** Computed display data per vehicle: frozen gap + delta vs previous sector */
    display: Map<number, { gap: number; delta: number | null; isAhead: boolean }>
}

const emptySectorState: SectorState = { key: '', gaps: new Map(), display: new Map() }

export default function RelativeTiming() {
    const vehicles = useTelemetryStore((s) => s.scoring.vehicles)
    const playerId = useTelemetryStore((s) => s.scoring.player_vehicle_id)

    // ── Sector snapshot state (updated with setState-during-render pattern) ──
    const [sectorState, setSectorState] = useState<SectorState>(emptySectorState)

    const player = useMemo(
        () => vehicles.find((v) => v.id === playerId),
        [vehicles, playerId],
    )

    const sameClassSorted = useMemo(() => {
        if (!player) return []
        return [...vehicles]
            .filter((v) => v.vehicle_class === player.vehicle_class)
            .sort((a, b) => a.position - b.position)
    }, [vehicles, player])

    const classPos = useMemo(() => {
        const map = new Map<number, number>()
        sameClassSorted.forEach((v, i) => map.set(v.id, i + 1))
        return map
    }, [sameClassSorted])

    const rows = useMemo(() => {
        const playerIndex = sameClassSorted.findIndex((v) => v.id === playerId)
        if (playerIndex === -1) return []
        const from = Math.max(0, playerIndex - WINDOW)
        const to = Math.min(sameClassSorted.length - 1, playerIndex + WINDOW)
        return sameClassSorted.slice(from, to + 1)
    }, [sameClassSorted, playerId])

    const enriched = useMemo(() => {
        if (!player) return []
        return rows.map((v) => {
            const isPlayer = v.id === playerId
            // positive gap = v is ahead, negative gap = v is behind
            const gap = isPlayer ? 0 : player.time_behind_leader - v.time_behind_leader
            // lap difference: positive = v is behind player, negative = v is ahead
            const lapDiff = isPlayer ? 0 : v.laps_behind_leader - player.laps_behind_leader
            return { v, gap, isPlayer, lapDiff }
        })
    }, [rows, player, playerId])

    // ── Detect sector crossing and update snapshot (setState-during-render) ──
    // React re-renders immediately with the new state, discarding this output.
    if (player) {
        const sectorKey = `${player.total_laps}|${player.cur_sector1 > 0 ? '1' : 'x'}|${player.cur_sector2 > 0 ? '1' : 'x'}`

        if (sectorKey !== sectorState.key) {
            const isFirst = sectorState.key === ''
            const newGaps = new Map<number, number>()
            const newDisplay = new Map<number, { gap: number; delta: number | null; isAhead: boolean }>()

            for (const { v, gap, isPlayer, lapDiff } of enriched) {
                if (isPlayer) continue
                newGaps.set(v.id, gap)

                // Only compute time-based delta when both cars are on the same lap
                const isAhead = lapDiff < 0 || (lapDiff === 0 && gap > 0)
                let delta: number | null = null

                if (!isFirst && lapDiff === 0) {
                    const prevGap = sectorState.gaps.get(v.id)
                    if (prevGap !== undefined) {
                        const rawDelta = gap - prevGap
                        delta = isAhead ? rawDelta : -rawDelta
                    }
                }
                newDisplay.set(v.id, { gap, delta, isAhead })
            }

            setSectorState({ key: sectorKey, gaps: newGaps, display: newDisplay })
        }
    }

    if (!player || enriched.length === 0) {
        return (
            <div style={{
                width: '100%', height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: colors.textMuted, fontFamily: fonts.body, fontSize: 15,
            }}>
                Waiting for session…
            </div>
        )
    }

    const W_POS   = 32
    const W_NUM   = 36
    const W_LAST  = 76
    const W_GAP   = 80
    const W_DELTA = 72

    const colHdr = (label: string, width: number, right = false) => (
        <span style={{
            fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted,
            width, textAlign: right ? 'right' : 'left', flexShrink: 0,
        }}>
            {label}
        </span>
    )

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                paddingBottom: 6, borderBottom: `1px solid ${colors.border}`, marginBottom: 4,
            }}>
                <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
                    Relative
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted }}>
                    {player.vehicle_class}
                </span>
            </div>

            {/* Column header row */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '0 6px 3px', marginBottom: 2,
                borderBottom: `1px solid ${colors.border}33`,
            }}>
                {colHdr('POS', W_POS)}
                {colHdr('#', W_NUM, true)}
                <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, flex: 1 }}>DRIVER</span>
                {colHdr('LAST LAP', W_LAST, true)}
                {colHdr('GAP', W_GAP, true)}
                {colHdr('ΔSECT', W_DELTA, true)}
            </div>

            {/* Rows centered vertically */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
                {enriched.map(({ v, gap, isPlayer, lapDiff }) => {
                    const sd = sectorState.display.get(v.id)
                    // Use sector-frozen gap when available; fall back to live gap before first snapshot
                    const displayedGap = isPlayer ? 0 : (sd?.gap ?? gap)
                    const delta = (lapDiff === 0 ? sd?.delta : null) ?? null
                    const isAhead = displayedGap > 0

                    // Gap label: show lap count when on different laps, seconds otherwise
                    function gapLabel(): string {
                        if (isPlayer) return '—'
                        if (lapDiff > 0) return `+${lapDiff} L`
                        if (lapDiff < 0) return `${lapDiff} L`
                        return fmtGap(displayedGap)
                    }

                    return (
                        <div key={v.id} style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '4px 6px', borderRadius: 4,
                            background: isPlayer ? `${colors.primary}18` : 'transparent',
                            borderLeft: isPlayer ? `2px solid ${colors.primary}` : '2px solid transparent',
                        }}>
                            {/* Class position */}
                            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted, width: W_POS, flexShrink: 0 }}>
                                P{classPos.get(v.id) ?? v.position}
                            </span>

                            {/* Car number */}
                            <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.primary, width: W_NUM, textAlign: 'right', flexShrink: 0 }}>
                                #{v.car_number}
                            </span>

                            {/* Driver name */}
                            <span style={{
                                fontFamily: fonts.body, fontSize: 15,
                                color: isPlayer ? colors.primary : colors.text,
                                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                            }}>
                                {isPlayer ? `★ ${v.driver_name || `Car #${v.id}`}` : (v.driver_name || `Car #${v.id}`)}
                            </span>

                            {/* PIT badge */}
                            {v.in_pits && (
                                <span style={{
                                    fontFamily: fonts.mono, fontSize: 10, fontWeight: 700,
                                    color: '#f97316', background: '#f9731622', border: '1px solid #f9731666',
                                    borderRadius: 3, padding: '1px 4px', flexShrink: 0, lineHeight: 1.4,
                                }}>PIT</span>
                            )}

                            {/* Last lap time */}
                            <span style={{
                                fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted,
                                width: W_LAST, textAlign: 'right', flexShrink: 0,
                            }}>
                                {fmtLap(v.last_lap_time)}
                            </span>

                            {/* Gap frozen at last sector crossing */}
                            <span style={{
                                fontFamily: fonts.mono, fontSize: 13,
                                color: lapDiff !== 0 ? '#a855f7' : colors.textMuted,
                                width: W_GAP, textAlign: 'right', flexShrink: 0,
                            }}>
                                {gapLabel()}
                            </span>

                            {/* Sector delta: green/red depending on position (ahead/behind) */}
                            <span style={{
                                fontFamily: fonts.mono, fontSize: 13, fontWeight: 600,
                                color: (isPlayer || delta === null) ? colors.textMuted : deltaColor(delta, isAhead),
                                width: W_DELTA, textAlign: 'right', flexShrink: 0,
                            }}>
                                {isPlayer || delta === null ? '—' : fmtDelta(delta)}
                            </span>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}