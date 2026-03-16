import { useRef, useMemo, useEffect, useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'
import { CLASS_COLORS, getClassColor } from '../../utils/classColors'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SVG_SIZE = 400
const PADDING  = 30

const PLAYER_STROKE  = '#facc15'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackPoint { x: number; z: number }

interface Bounds {
  minX: number; maxX: number
  minZ: number; maxZ: number
}

interface TrackOutline {
  trackName: string
  points:    TrackPoint[]
  bounds:    Bounds
  complete:  boolean
}

// ---------------------------------------------------------------------------
// Geometry utilities
// ---------------------------------------------------------------------------

const FALLBACK_BOUNDS: Bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }

function calcBounds(pts: TrackPoint[]): Bounds {
  if (!pts.length) return FALLBACK_BOUNDS
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z
  }
  return { minX, maxX, minZ, maxZ }
}


/** Map a world coordinate (x, z) to SVG pixel coordinates. */
function worldToSvg(x: number, z: number, b: Bounds): [number, number] {
  const rX = b.maxX - b.minX || 1
  const rZ = b.maxZ - b.minZ || 1
  const scale = Math.min((SVG_SIZE - 2 * PADDING) / rX, (SVG_SIZE - 2 * PADDING) / rZ)
  const oX = (SVG_SIZE - rX * scale) / 2
  const oZ = (SVG_SIZE - rZ * scale) / 2
  return [(x - b.minX) * scale + oX, (z - b.minZ) * scale + oZ]
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

function storedKey(name: string): string {
  return 'lmu-trackmap-' + name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

function loadOutline(name: string): TrackOutline | null {
  try {
    const raw = localStorage.getItem(storedKey(name))
    return raw ? (JSON.parse(raw) as TrackOutline) : null
  } catch { return null }
}

function saveOutline(o: TrackOutline): void {
  try { localStorage.setItem(storedKey(o.trackName), JSON.stringify(o)) } catch {}
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export default function TrackMap() {
  const vehicles    = useTelemetryStore((s) => s.scoring.vehicles)
  const playerId    = useTelemetryStore((s) => s.scoring.player_vehicle_id)
  const trackName   = useTelemetryStore((s) => s.session.track_name)
  const trackLength = useTelemetryStore((s) => s.session.track_length)

  // Refs so interval callbacks always see fresh values without re-creating intervals
  const vehiclesRef    = useRef(vehicles)
  const playerIdRef    = useRef(playerId)
  const trackLengthRef = useRef(trackLength)
  vehiclesRef.current    = vehicles
  playerIdRef.current    = playerId
  trackLengthRef.current = trackLength

  // Mutable outline being built (not state — mutations don't trigger renders)
  const buildingRef    = useRef<TrackOutline | null>(null)
  const lastPtRef      = useRef<TrackPoint | null>(null)
  const prevLapDistRef = useRef(0)
  const loadedTrackRef = useRef('')
  // Counts how many times lap_dist has reset (S/F line crossings):
  //   0 = outlap in progress, 1 = first real lap, 2 = outline complete
  const lapCrossingsRef = useRef(0)

  // Rendered outline (state — triggers re-render when a point is added or lap completes)
  const [outline, setOutline] = useState<TrackOutline | null>(null)
  // Drives header text — mirrors lapCrossingsRef for reactive rendering
  const [lapCrossings, setLapCrossings] = useState(0)

  // --------------------------------------------------------------------------
  // Load outline from localStorage when track changes
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!trackName || trackName === loadedTrackRef.current) return
    loadedTrackRef.current    = trackName
    lastPtRef.current         = null
    prevLapDistRef.current    = 0
    lapCrossingsRef.current   = 0
    setLapCrossings(0)

    const saved = loadOutline(trackName)
    if (saved) {
      buildingRef.current = saved
      setOutline(saved)
    } else {
      const fresh: TrackOutline = {
        trackName, points: [], bounds: FALLBACK_BOUNDS, complete: false,
      }
      buildingRef.current = fresh
      setOutline(fresh)
    }
  }, [trackName])

  // --------------------------------------------------------------------------
  // Sample player position every 50 ms to build the track outline
  // --------------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const cur = buildingRef.current
      if (!cur || cur.complete) return

      const veh = vehiclesRef.current
      const pid = playerIdRef.current
      const tl  = trackLengthRef.current
      if (tl <= 0) return

      const player = veh.find((v) => v.id === pid)
      if (!player || (player.pos_x === 0 && player.pos_z === 0)) return

      const lapDist = player.lap_dist
      const prev    = prevLapDistRef.current
      prevLapDistRef.current = lapDist

      // Detect S/F line crossing: lap_dist resets from high (>70%) to low (<10%)
      if (prev > tl * 0.7 && lapDist < tl * 0.1) {
        lapCrossingsRef.current++
        setLapCrossings(lapCrossingsRef.current)

        if (lapCrossingsRef.current === 2) {
          // End of first real lap — finalise outline if enough points collected
          if (cur.points.length > 50) {
            const bounds = calcBounds(cur.points)
            const done: TrackOutline = { ...cur, bounds, complete: true }
            buildingRef.current = done
            setOutline(done)
            saveOutline(done)
          }
        } else {
          // Crossing #1 = end of outlap — discard accumulated points and start recording
          const fresh: TrackOutline = { ...cur, points: [], bounds: FALLBACK_BOUNDS, complete: false }
          buildingRef.current = fresh
          lastPtRef.current   = null
          setOutline(fresh)
        }
        return
      }

      // Only record points during the first real lap (lapCrossings === 1)
      if (lapCrossingsRef.current !== 1) return

      // Skip if within 5 m of last recorded point
      const last = lastPtRef.current
      if (last) {
        const dx = player.pos_x - last.x, dz = player.pos_z - last.z
        if (dx * dx + dz * dz < 25) return   // 5² = 25
      }

      const newX = player.pos_x, newZ = player.pos_z

      // Outlier filter: skip points > 50 m from last — likely off-track, respawn or teleport
      // (at 300 km/h with 50 ms sampling a car moves ~4 m per tick)
      const MAX_POINT_DISTANCE = 50
      if (last) {
        const dist = Math.hypot(newX - last.x, newZ - last.z)
        if (dist > MAX_POINT_DISTANCE) return
      }

      const pt: TrackPoint = { x: newX, z: newZ }
      lastPtRef.current = pt
      const updated: TrackOutline = { ...cur, points: [...cur.points, pt] }
      buildingRef.current = updated
      setOutline(updated)
    }, 50)

    return () => clearInterval(id)
  }, [])  // run once; reads refs for fresh data

  // --------------------------------------------------------------------------
  // Render bounds:
  //   • When outline is complete → use stable outline.bounds (no jitter)
  //   • While building          → merge vehicle positions + recorded trail
  // --------------------------------------------------------------------------
  const renderBounds = useMemo<Bounds>(() => {
    if (outline?.complete) return outline.bounds

    const pts: TrackPoint[] = vehicles.map((v) => ({ x: v.pos_x, z: v.pos_z }))
    if (outline && outline.points.length > 0) pts.push(...outline.points)
    return pts.length ? calcBounds(pts) : FALLBACK_BOUNDS
  }, [outline, vehicles])

  // Memoise the SVG polyline points string.
  // When outline is complete and bounds are stable, this never changes.
  const outlinePoints = useMemo<string>(() => {
    if (!outline || outline.points.length < 2) return ''
    return outline.points
      .map((p) => {
        const [sx, sy] = worldToSvg(p.x, p.z, renderBounds)
        return `${sx.toFixed(1)},${sy.toFixed(1)}`
      })
      .join(' ')
  }, [outline, renderBounds])

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  const hasVehicles = vehicles.length > 0

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
            {trackName}{outline && !outline.complete
            ? (lapCrossings === 0 ? ' — outlap…' : ' — recording…')
            : ''}
          </span>
        )}
      </div>

      {!hasVehicles ? (
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
            {/* Track outline — thick dark band when complete, thin trail while building */}
            {outline && outline.points.length >= 2 && (
              <polyline
                points={outlinePoints}
                fill="none"
                stroke={outline.complete ? '#2d2d2d' : '#1e1e1e'}
                strokeWidth={outline.complete ? 14 : 3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/* Vehicles — 200ms ease-out transition interpolates smoothly between 5 Hz (200ms) scoring updates */}
            {vehicles.map((v) => {
              const isPlayer    = v.id === playerId
              const [sx, sy]    = worldToSvg(v.pos_x, v.pos_z, renderBounds)
              const vColor      = getClassColor(v.vehicle_class)
              const r           = isPlayer ? 13 : 10

              return (
                <g
                  key={v.id}
                  style={{
                    transform:  `translate(${sx}px, ${sy}px)`,
                    transition: 'transform 200ms ease-out',
                  }}
                >
                  {/* Glow ring for player */}
                  {isPlayer && (
                    <circle r={r + 5}
                      fill="none" stroke={PLAYER_STROKE} strokeWidth={1.5} opacity={0.35} />
                  )}
                  <circle
                    r={r}
                    fill={vColor}
                    stroke={isPlayer ? PLAYER_STROKE : 'rgba(0,0,0,0.4)'}
                    strokeWidth={isPlayer ? 2 : 1}
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
                    {v.position}
                  </text>
                </g>
              )
            })}
          </svg>

          {/* Class legend */}
          <div style={{
            position: 'absolute', bottom: 4, right: 6,
            display: 'flex', gap: 7, alignItems: 'center',
          }}>
            {([
              ['HC',   CLASS_COLORS.Hypercar],
              ['GT3',  CLASS_COLORS.LMGT3],
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
    </div>
  )
}
