/**
 * Track Map — the field's live positions on a track outline recorded from a lap.
 *
 * Two things here are worth knowing before changing anything.
 *
 * **Cars do not move by re-rendering.** Position samples arrive in discrete
 * updates; a frame drawn straight from the newest one steps between them, which
 * on screen is a stutter. Instead every update is timestamped into a per-car
 * buffer, and a requestAnimationFrame loop writes an interpolated `transform`
 * onto each marker directly, at the display's refresh rate. React renders the
 * markers; it does not animate them, and it does not re-render when they move.
 *
 * **The outline is recorded once and kept.** See `utils/trackOutline.ts`. An
 * outline stored by an older version stays on screen and is quietly replaced by
 * a fuller record on the next clean lap — nothing has to be re-recorded by hand.
 */

import { useRef, useMemo, useEffect, useState, useCallback } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'
import { CLASS_COLORS, getClassColor } from '../../utils/classColors'
import {
  OUTLINE_VERSION, SVG_SIZE, FALLBACK_BOUNDS,
  calcBounds, unionBounds, boundsEqual, worldToSvg, toPolyline, crossMark,
  splitSectors, indexAtDistance, computeStats, elevationPath, hasDetail,
  loadOutline, saveOutline,
  type Bounds, type TrackOutline, type TrackPoint,
} from '../../utils/trackOutline'
import { newTrail, pushSample, renderDelay, sampleAt, type Trail } from '../../utils/motionTrail'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLAYER_STROKE = '#facc15'

/** Road colour per sector — three greys, distinct enough to read as three
 *  sections without competing with the class colours the cars are drawn in. */
const SECTOR_FILL = ['#3d3d3d', '#2d2d2d', '#1f1f1f']
const SECTOR_YELLOW = '#6b5410'
const TRACK_FILL = '#2d2d2d'

/** How often the outline recorder samples the player's position. */
const RECORD_INTERVAL_MS = 50
/** Points closer together than this (m) are dropped — 5 m is plenty of detail. */
const MIN_POINT_SPACING = 5
/** A step longer than this (m) is a respawn or a teleport, not driving. */
const MAX_POINT_STEP = 50
/** Fewer points than this is not a lap worth keeping. */
const MIN_LAP_POINTS = 50
/** Refit the view and redraw the lap being recorded on this interval, rather
 *  than on every update — bounds that move at 20 Hz make the map shimmer. */
const REFIT_MS = 400

const ELEV_STRIP_H = 46

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

interface Build {
  trackName: string
  points: TrackPoint[]
  /** S/F crossings seen: 0 = outlap in progress, 1 = recording a lap. */
  crossings: number
  sector1Dist: number
  sector2Dist: number
  prevDist: number
  prevCurS1: number
  prevCurS2: number
  last: TrackPoint | null
}

/**
 * Starting value for the previous sector times.
 *
 * The sector lines are found by watching a sector time go from "none" to a
 * value. Crossing S/F clears those times, but scoring only refreshes at 5 Hz,
 * so for a moment after the line the *previous* lap's times are still being
 * reported. Starting from a positive value means the watch cannot fire on that
 * stale reading — it arms itself only after seeing the times actually clear.
 */
const NOT_YET_CLEARED = Infinity

function freshBuild(trackName: string): Build {
  const build = {
    trackName, points: [], crossings: 0,
    sector1Dist: -1, sector2Dist: -1,
    prevDist: 0, prevCurS1: NOT_YET_CLEARED, prevCurS2: NOT_YET_CLEARED, last: null,
  }
  return build
}

/** Begin a recording lap. The car is at the line when this is called. */
function restartLap(build: Build): void {
  build.points = []
  build.last = null
  build.crossings = 1
  build.sector1Dist = -1
  build.sector2Dist = -1
  build.prevCurS1 = NOT_YET_CLEARED
  build.prevCurS2 = NOT_YET_CLEARED
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const km = (m: number) => (m / 1000).toFixed(3) + ' km'
const kmShort = (m: number) => (m / 1000).toFixed(2)
const metres = (m: number) => Math.round(m) + ' m'

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

interface Marker {
  id: number
  color: string
  label: number
  isPlayer: boolean
}

export default function TrackMap() {
  const trackName = useTelemetryStore((s) => s.session.track_name)
  const trackLength = useTelemetryStore((s) => s.session.track_length)
  const detail = useSettingsStore((s) => s.trackMapDetail)

  // The cars on screen, with their class colour and rank within that class.
  //
  // The selector returns the previous array unchanged unless the field itself
  // changed, so React stays out of the 20 Hz update path entirely: a re-render
  // happens when a car joins, leaves or changes position, not when one moves.
  const rosterCache = useRef<{ key: string; list: Marker[] }>({ key: '', list: [] })
  const roster = useTelemetryStore((s) => {
    const { vehicles, player_vehicle_id } = s.scoring
    let key = String(player_vehicle_id)
    for (const v of vehicles) key += `|${v.id}:${v.vehicle_class}:${v.position}`
    if (key === rosterCache.current.key) return rosterCache.current.list

    const rankInClass = new Map<string, number>()
    const list = [...vehicles]
      .sort((a, b) => a.position - b.position)
      .map((v) => {
        const cls = v.vehicle_class || ''
        const rank = (rankInClass.get(cls) ?? 0) + 1
        rankInClass.set(cls, rank)
        return { id: v.id, color: getClassColor(cls), label: rank || v.position, isPlayer: v.id === player_vehicle_id }
      })
    rosterCache.current = { key, list }
    return list
  })

  // Local yellows. In LMU `1` means yellow and `11` means clear — not `0`.
  const sectorFlagKey = useTelemetryStore((s) => s.vehicleStatus.sector_flags.join(','))
  const yellowSectors = useMemo(() => sectorFlagKey.split(',').map((v) => v === '1'), [sectorFlagKey])

  // --------------------------------------------------------------------------
  // State and refs
  // --------------------------------------------------------------------------

  const [outline, setOutline] = useState<TrackOutline | null>(null)
  const [recordState, setRecordState] = useState<'idle' | 'outlap' | 'recording'>('idle')
  const [bounds, setBounds] = useState<Bounds>(FALLBACK_BOUNDS)
  /** The lap being recorded, already projected. Written by the refit timer. */
  const [trailLine, setTrailLine] = useState('')

  const buildRef = useRef<Build | null>(null)
  const loadedTrackRef = useRef('')
  /** False until the view has been fitted to something real, so the placeholder
   *  bounds never end up merged into a track's own extent. */
  const fittedRef = useRef(false)
  /** The live copy of `bounds`, for the parts that run outside render: the
   *  animation loop reads it every frame, the refit timer grows it. */
  const boundsRef = useRef<Bounds>(FALLBACK_BOUNDS)

  const trailsRef = useRef(new Map<number, Trail>())
  const markersRef = useRef(new Map<number, SVGGElement>())
  const elevMarkerRef = useRef<SVGGElement | null>(null)
  const playerIdRef = useRef(-1)

  /** Returning the previous value tells React there is nothing to re-render,
   *  which matters because the recorder calls this on every sample. */
  const setRecord = useCallback((next: 'idle' | 'outlap' | 'recording') => {
    setRecordState((prev) => (prev === next ? prev : next))
  }, [])

  const applyBounds = useCallback((next: Bounds) => {
    if (boundsEqual(next, boundsRef.current)) return
    boundsRef.current = next
    setBounds(next)
  }, [])

  // --------------------------------------------------------------------------
  // Load the stored outline when the track changes
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!trackName || trackName === loadedTrackRef.current) return
    loadedTrackRef.current = trackName

    const saved = loadOutline(trackName)
    fittedRef.current = false
    setOutline(saved)
    setTrailLine('')
    setRecord('idle')

    // Record when there is nothing stored, and re-record when what is stored
    // predates the elevation and sector data. The old outline keeps drawing
    // until the new one is finished.
    buildRef.current = (!saved || !saved.complete || saved.version < OUTLINE_VERSION)
      ? freshBuild(trackName)
      : null
  }, [trackName, setRecord])

  // --------------------------------------------------------------------------
  // Sample the player's line into an outline
  // --------------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const build = buildRef.current
      if (!build) return

      const { scoring, session } = useTelemetryStore.getState()
      const length = session.track_length
      if (length <= 0) return
      const player = scoring.vehicles.find((v) => v.id === scoring.player_vehicle_id)
      if (!player || (player.pos_x === 0 && player.pos_z === 0)) return

      const dist = player.lap_dist
      const prev = build.prevDist
      build.prevDist = dist

      // S/F crossing: lap distance falls from near a full lap back to near zero.
      if (prev > length * 0.7 && dist < length * 0.1) {
        if (build.crossings >= 1 && build.points.length > MIN_LAP_POINTS) {
          const done: TrackOutline = {
            version: OUTLINE_VERSION,
            trackName: build.trackName,
            points: build.points,
            bounds: calcBounds(build.points),
            complete: true,
            sector1Dist: build.sector1Dist,
            sector2Dist: build.sector2Dist,
          }
          setOutline(done)
          saveOutline(done)
          setRecord('idle')

          // A lap whose sector lines were never seen still makes a perfectly
          // good map, so it is kept and drawn. Recording just carries on into
          // the next lap to try for them again — invisibly, because a finished
          // outline is what gets drawn from here on.
          if (done.sector1Dist > 0 && done.sector2Dist > done.sector1Dist) {
            buildRef.current = null
          } else {
            restartLap(build)
          }
          return
        }
        // Either the outlap just ended or the lap was unusable. The car is at
        // the line either way, so a fresh recording lap starts here.
        restartLap(build)
        setTrailLine('')
        setRecord('recording')
        return
      }

      if (build.crossings < 1) {
        setRecord('outlap')
        return
      }

      // The pit lane is not the track. A lap that visits it is abandoned, and
      // the next S/F crossing starts a new attempt.
      if (player.in_pits) {
        buildRef.current = freshBuild(build.trackName)
        setTrailLine('')
        setRecord('outlap')
        return
      }

      // Sector lines, caught the moment the game starts reporting a time for
      // the sector just left. That lands within one scoring tick of the real
      // line, which at map scale is well under a pixel.
      if (build.sector1Dist < 0 && build.prevCurS1 <= 0 && player.cur_sector1 > 0) build.sector1Dist = dist
      if (build.sector2Dist < 0 && build.prevCurS2 <= 0 && player.cur_sector2 > 0) build.sector2Dist = dist
      build.prevCurS1 = player.cur_sector1
      build.prevCurS2 = player.cur_sector2

      const last = build.last
      if (last) {
        const step = Math.hypot(player.pos_x - last.x, player.pos_z - last.z)
        if (step < MIN_POINT_SPACING) return
        if (step > MAX_POINT_STEP) return  // off-track, respawn or teleport
      }

      const pt: TrackPoint = { x: player.pos_x, y: player.pos_y, z: player.pos_z, d: dist }
      build.points.push(pt)
      build.last = pt
    }, RECORD_INTERVAL_MS)

    return () => clearInterval(id)
  }, [setRecord])  // reads the store imperatively, so it never needs re-creating

  // --------------------------------------------------------------------------
  // Fit the view
  //
  // A finished outline pins the view to its own extent, which is what keeps the
  // map from drifting under the cars. Until there is one, the view grows to
  // hold the cars and the lap being recorded, and never shrinks again.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (outline?.complete) {
      fittedRef.current = true
      applyBounds(outline.bounds)
      setTrailLine('')
      return
    }

    const fit = () => {
      const pts = buildRef.current?.points ?? []
      const cars = useTelemetryStore.getState().scoring.vehicles
        .filter((v) => v.pos_x !== 0 || v.pos_z !== 0)
        .map((v) => ({ x: v.pos_x, z: v.pos_z }))
      if (!pts.length && !cars.length) return

      const seen = calcBounds([...pts, ...cars])
      applyBounds(fittedRef.current ? unionBounds(boundsRef.current, seen) : seen)
      fittedRef.current = true
      setTrailLine(pts.length >= 2 ? toPolyline(pts, boundsRef.current) : '')
    }

    fit()
    const id = setInterval(fit, REFIT_MS)
    return () => clearInterval(id)
  }, [outline, applyBounds])

  // --------------------------------------------------------------------------
  // Collect position samples — no render, straight into the motion buffers
  // --------------------------------------------------------------------------
  useEffect(() => {
    return useTelemetryStore.subscribe((state, prev) => {
      if (state.scoring.vehicles === prev.scoring.vehicles) return
      const now = performance.now()
      const trails = trailsRef.current
      playerIdRef.current = state.scoring.player_vehicle_id

      const live = new Set<number>()
      for (const v of state.scoring.vehicles) {
        live.add(v.id)
        let trail = trails.get(v.id)
        if (!trail) { trail = newTrail(); trails.set(v.id, trail) }
        pushSample(trail, now, v.pos_x, v.pos_z, v.lap_dist)
      }
      for (const id of trails.keys()) if (!live.has(id)) trails.delete(id)
    })
  }, [])

  // --------------------------------------------------------------------------
  // Move the markers, every frame
  // --------------------------------------------------------------------------
  const placeMarker = useCallback((node: SVGGElement, id: number, now: number) => {
    const trail = trailsRef.current.get(id)
    const p = trail ? sampleAt(trail, now - renderDelay(trail)) : null
    if (!p) {
      node.setAttribute('opacity', '0')   // no position yet — not at the origin
      return
    }
    const [sx, sy] = worldToSvg(p.x, p.z, boundsRef.current)
    node.setAttribute('transform', `translate(${sx.toFixed(2)} ${sy.toFixed(2)})`)
    node.setAttribute('opacity', '1')
  }, [])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const now = performance.now()
      for (const [id, node] of markersRef.current) placeMarker(node, id, now)

      const elev = elevMarkerRef.current
      if (!elev) return
      const trail = trailsRef.current.get(playerIdRef.current)
      const p = trail ? sampleAt(trail, now - renderDelay(trail)) : null
      const len = useTelemetryStore.getState().session.track_length
      // Lap distance runs negative down the pit lane, where a marker on an axis
      // of track distance would be meaningless.
      if (p && len > 0 && p.d >= 0) {
        elev.setAttribute('transform', `translate(${((p.d / len) * 100).toFixed(3)} 0)`)
        elev.setAttribute('opacity', '1')
      } else {
        elev.setAttribute('opacity', '0')
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [placeMarker])

  const attachMarker = useCallback((id: number, node: SVGGElement | null) => {
    if (node) {
      markersRef.current.set(id, node)
      placeMarker(node, id, performance.now())   // placed before its first paint
    } else {
      markersRef.current.delete(id)
    }
  }, [placeMarker])

  // --------------------------------------------------------------------------
  // Geometry, recomputed only when the outline or the view changes
  // --------------------------------------------------------------------------
  const sectorLines = useMemo(() => {
    const runs = outline && splitSectors(outline)
    return runs ? runs.map((run) => toPolyline(run, bounds)) : null
  }, [outline, bounds])

  const plainLine = useMemo(
    () => (!sectorLines && outline && outline.points.length >= 2 ? toPolyline(outline.points, bounds) : ''),
    [sectorLines, outline, bounds],
  )

  const marks = useMemo(() => {
    if (!outline?.complete || !hasDetail(outline)) return null
    const pts = outline.points
    const at = (i: number, half: number) => (i >= 0 ? crossMark(pts, i, bounds, half) : null)
    return {
      start: at(0, 13),
      s1: at(indexAtDistance(pts, outline.sector1Dist), 10),
      s2: at(indexAtDistance(pts, outline.sector2Dist), 10),
    }
  }, [outline, bounds])

  const stats = useMemo(() => computeStats(outline, trackLength), [outline, trackLength])

  const elevation = useMemo(
    () => (detail === 'full' && outline ? elevationPath(outline, 100, ELEV_STRIP_H) : null),
    [detail, outline],
  )

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  const rich = detail !== 'compact'
  const roadWidth = outline?.complete ? 14 : 3
  const status = recordState === 'recording' ? ' — recording…'
    : recordState === 'outlap' ? ' — outlap…'
    : ''

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        paddingBottom: 4, borderBottom: `1px solid ${colors.border}`, marginBottom: 4, flexShrink: 0,
      }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Track Map
        </span>
        {trackName && (
          <span style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted }}>
            {trackName}{status}
          </span>
        )}
      </div>

      {roster.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textMuted, fontFamily: fonts.body, fontSize: 15 }}>
          Waiting for session…
        </div>
      ) : (
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <svg
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            style={{ width: '100%', height: '100%' }}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* Road — split into its sectors once the boundaries are known, and
                shaded per sector unless the widget is set to compact */}
            {sectorLines ? sectorLines.map((pts, i) => (
              <polyline
                key={i}
                points={pts}
                fill="none"
                stroke={!rich ? TRACK_FILL : yellowSectors[i] ? SECTOR_YELLOW : SECTOR_FILL[i]}
                strokeWidth={roadWidth}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )) : plainLine && (
              <polyline
                points={plainLine}
                fill="none"
                stroke={TRACK_FILL}
                strokeWidth={roadWidth}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/* The lap being recorded, drawn over whatever outline is stored */}
            {trailLine && (
              <polyline
                points={trailLine}
                fill="none"
                stroke={colors.primary}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.65}
              />
            )}

            {/* Start/finish and sector lines */}
            {rich && marks && (
              <g>
                {marks.s1 && <line {...marks.s1} stroke="#8a8a8a" strokeWidth={2} />}
                {marks.s2 && <line {...marks.s2} stroke="#8a8a8a" strokeWidth={2} />}
                {marks.start && <line {...marks.start} stroke="#e5e5e5" strokeWidth={3} />}
              </g>
            )}

            {/* Cars — placed by the animation loop, not by this render */}
            {roster.map((v) => {
              const r = v.isPlayer ? 13 : 10
              return (
                <g key={v.id} ref={(node) => attachMarker(v.id, node)} opacity={0}>
                  {v.isPlayer && (
                    <circle r={r + 5} fill="none" stroke={PLAYER_STROKE} strokeWidth={1.5} opacity={0.35} />
                  )}
                  <circle
                    r={r}
                    fill={v.color}
                    stroke={v.isPlayer ? PLAYER_STROKE : 'rgba(0,0,0,0.4)'}
                    strokeWidth={v.isPlayer ? 2 : 1}
                    opacity={0.92}
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize={r > 11 ? 10 : 8}
                    fontWeight="bold"
                    fontFamily={fonts.body}
                    style={{ userSelect: 'none', pointerEvents: 'none' }}
                  >
                    {v.label}
                  </text>
                </g>
              )
            })}
          </svg>

          {/* Track data */}
          {rich && (trackLength > 0 || stats) && (
            <div style={{
              position: 'absolute', top: 0, left: 0,
              display: 'flex', flexDirection: 'column', gap: 1,
              fontFamily: fonts.mono, fontSize: 13, pointerEvents: 'none',
            }}>
              {trackLength > 0 && <StatRow label="LENGTH" value={km(trackLength)} />}
              {stats?.sectors && (
                <StatRow
                  label="SECTORS"
                  value={`${kmShort(stats.sectors[0])} / ${kmShort(stats.sectors[1])} / ${kmShort(stats.sectors[2])} km`}
                />
              )}
              {stats && <StatRow label="ELEV" value={`Δ ${metres(stats.elevRange)}   ↑ ${metres(stats.climb)}`} />}
              {stats && detail === 'full' && (
                <>
                  <StatRow label="RANGE" value={`${Math.round(stats.elevMin)} – ${Math.round(stats.elevMax)} m`} />
                  <StatRow label="GRADE" value={`${stats.maxGradient.toFixed(1)} % max`} />
                </>
              )}
            </div>
          )}

          {/* Class legend */}
          <div style={{
            position: 'absolute', bottom: 4, right: 6,
            display: 'flex', gap: 7, alignItems: 'center',
          }}>
            {([
              ['HC', CLASS_COLORS.Hypercar],
              ['GT3', CLASS_COLORS.LMGT3],
              ['LMP2', CLASS_COLORS.LMP2],
              ['LMP3', CLASS_COLORS.LMP3],
            ] as [string, string][]).map(([label, clr]) => (
              <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: clr, display: 'inline-block', flexShrink: 0,
                }} />
                <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted }}>
                  {label}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Elevation over one lap, with the player's position on it */}
      {elevation && (
        <div style={{ flexShrink: 0, marginTop: 4, borderTop: `1px solid ${colors.border}`, paddingTop: 4 }}>
          <svg
            viewBox={`0 0 100 ${ELEV_STRIP_H}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: ELEV_STRIP_H, display: 'block' }}
          >
            <path d={elevation.area} fill={colors.primary} opacity={0.12} />
            <path d={elevation.line} fill="none" stroke={colors.primary} strokeWidth={1}
              opacity={0.7} vectorEffect="non-scaling-stroke" />
            {trackLength > 0 && [outline?.sector1Dist, outline?.sector2Dist].map((d, i) =>
              d && d > 0 ? (
                <line key={i} x1={(d / trackLength) * 100} y1={0} x2={(d / trackLength) * 100} y2={ELEV_STRIP_H}
                  stroke={colors.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              ) : null,
            )}
            <g ref={elevMarkerRef} opacity={0}>
              <line x1={0} y1={0} x2={0} y2={ELEV_STRIP_H}
                stroke={PLAYER_STROKE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          </svg>
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <span style={{ width: 54, color: '#4b4b4b' }}>{label}</span>
      <span style={{ color: colors.textMuted }}>{value}</span>
    </div>
  )
}
