/**
 * Track outline — the shape the TrackMap widget draws cars on.
 *
 * The outline is recorded, not shipped: LMU publishes no track geometry, so the
 * widget samples the player's own position for one clean lap and keeps the
 * result in localStorage. This module owns everything about that record except
 * the sampling itself — its shape, how it is stored and migrated, how world
 * metres become SVG pixels, and what can be derived from it.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** One sample of the track's centre line. */
export interface TrackPoint {
  x: number // world X (m)
  y: number // world Y — elevation (m)
  z: number // world Z (m)
  d: number // lap distance at this point (m)
}

export interface Bounds {
  minX: number; maxX: number
  minZ: number; maxZ: number
}

/**
 * Stored-outline schema version.
 *
 * v1 recorded `{x, z}` only. v2 adds elevation and lap distance per point plus
 * the sector-boundary distances, which is what every derived statistic needs.
 * v1 outlines still draw perfectly, so they are kept and used on sight; the
 * recorder just re-runs in the background and replaces them with a v2 record on
 * the next clean lap. Nobody has to re-record anything by hand.
 */
export const OUTLINE_VERSION = 2

export interface TrackOutline {
  version: number
  trackName: string
  points: TrackPoint[]
  bounds: Bounds
  complete: boolean
  /** Lap distance of the S1/S2 line (m); -1 = not captured. */
  sector1Dist: number
  /** Lap distance of the S2/S3 line (m); -1 = not captured. */
  sector2Dist: number
}

/** Whether this outline carries the per-point detail v2 added. */
export function hasDetail(o: TrackOutline | null): boolean {
  return !!o && o.version >= OUTLINE_VERSION
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export const SVG_SIZE = 400
export const PADDING = 30

export const FALLBACK_BOUNDS: Bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }

export function calcBounds(pts: { x: number; z: number }[]): Bounds {
  if (!pts.length) return FALLBACK_BOUNDS
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z
  }
  return { minX, maxX, minZ, maxZ }
}

/** Smallest bounds containing both. Used while recording, so the map only ever
 *  grows and never rescales backwards under the cars already drawn on it. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
  }
}

export function boundsEqual(a: Bounds, b: Bounds): boolean {
  return a.minX === b.minX && a.maxX === b.maxX && a.minZ === b.minZ && a.maxZ === b.maxZ
}

/**
 * Map a world coordinate (x, z) to SVG pixel coordinates.
 *
 * X is mirrored so the map matches the orientation LMU's own in-game map uses.
 * Both axes share one scale factor, so the track keeps its real proportions.
 */
export function worldToSvg(x: number, z: number, b: Bounds): [number, number] {
  const rX = b.maxX - b.minX || 1
  const rZ = b.maxZ - b.minZ || 1
  const scale = Math.min((SVG_SIZE - 2 * PADDING) / rX, (SVG_SIZE - 2 * PADDING) / rZ)
  const oX = (SVG_SIZE - rX * scale) / 2
  const oZ = (SVG_SIZE - rZ * scale) / 2
  return [(b.maxX - x) * scale + oX, (z - b.minZ) * scale + oZ]
}

/** Projected polyline `points` attribute for a run of track points. */
export function toPolyline(pts: TrackPoint[], b: Bounds): string {
  let out = ''
  for (const p of pts) {
    const [sx, sy] = worldToSvg(p.x, p.z, b)
    out += (out ? ' ' : '') + sx.toFixed(1) + ',' + sy.toFixed(1)
  }
  return out
}

/**
 * A line across the track at `index`, `halfLen` pixels to each side.
 *
 * The direction comes from the neighbouring points, so the mark sits square to
 * the racing line wherever it lands. Returned in SVG pixels, ready for `<line>`.
 */
export function crossMark(
  pts: TrackPoint[], index: number, b: Bounds, halfLen: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (pts.length < 2) return null
  const i = Math.max(0, Math.min(pts.length - 1, index))
  const a = pts[Math.max(0, i - 1)]
  const c = pts[Math.min(pts.length - 1, i + 1)]
  const [ax, ay] = worldToSvg(a.x, a.z, b)
  const [cx, cy] = worldToSvg(c.x, c.z, b)
  const dx = cx - ax, dy = cy - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  // Normal of the tangent, scaled to the requested half-length.
  const nx = (-dy / len) * halfLen
  const ny = (dx / len) * halfLen
  const [px, py] = worldToSvg(pts[i].x, pts[i].z, b)
  return { x1: px - nx, y1: py - ny, x2: px + nx, y2: py + ny }
}

// ---------------------------------------------------------------------------
// Sectors
// ---------------------------------------------------------------------------

/**
 * Split the outline into its three sectors.
 *
 * Runs share their boundary point so the drawn segments meet without a gap, and
 * the last run closes back onto the first point — the recording starts and ends
 * at the S/F line, a metre or two apart, and leaving that open shows as a nick
 * in the track. Returns `null` when the boundaries were never captured.
 */
export function splitSectors(o: TrackOutline): [TrackPoint[], TrackPoint[], TrackPoint[]] | null {
  if (!hasDetail(o) || o.sector1Dist <= 0 || o.sector2Dist <= o.sector1Dist) return null
  const pts = o.points
  if (pts.length < 6) return null

  const firstAtOrAfter = (dist: number) => {
    const i = pts.findIndex((p) => p.d >= dist)
    return i < 0 ? pts.length - 1 : i
  }
  const i1 = firstAtOrAfter(o.sector1Dist)
  const i2 = firstAtOrAfter(o.sector2Dist)
  if (i1 < 1 || i2 <= i1 || i2 >= pts.length - 1) return null

  return [
    pts.slice(0, i1 + 1),
    pts.slice(i1, i2 + 1),
    o.complete ? [...pts.slice(i2), pts[0]] : pts.slice(i2),
  ]
}

/** Index of the point closest to a lap distance; -1 when unavailable. */
export function indexAtDistance(pts: TrackPoint[], dist: number): number {
  if (!pts.length || dist < 0) return -1
  let best = -1, bestErr = Infinity
  for (let i = 0; i < pts.length; i++) {
    const err = Math.abs(pts[i].d - dist)
    if (err < bestErr) { bestErr = err; best = i }
  }
  return best
}

// ---------------------------------------------------------------------------
// Derived statistics
// ---------------------------------------------------------------------------

/**
 * Points either side of a value are averaged before any elevation figure is
 * taken from them. `mPos.y` is the car body, not the tarmac, so it carries
 * suspension travel, kerb hops and a bump or two of noise.
 */
const ELEV_SMOOTHING = 5

/**
 * A rise has to clear this (metres) before it counts towards the lap's climb.
 * Below it, a flat track would accumulate its own noise into a total.
 */
const CLIMB_DEADBAND = 0.3

/** Gradient is measured over at least this much track (m), not point to point. */
const GRADIENT_WINDOW = 40

export interface TrackStats {
  /** Sector lengths in metres, or null when the boundaries were not captured. */
  sectors: [number, number, number] | null
  elevMin: number
  elevMax: number
  /** Highest point minus lowest (m). */
  elevRange: number
  /** Metres of ascent over one lap. */
  climb: number
  /** Steepest sustained slope, percent. */
  maxGradient: number
}

/** Centred moving average over the elevation channel. */
function smoothElevation(pts: TrackPoint[]): number[] {
  const n = pts.length
  const half = Math.floor(ELEV_SMOOTHING / 2)
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0
    for (let k = i - half; k <= i + half; k++) {
      if (k < 0 || k >= n) continue
      sum += pts[k].y; count++
    }
    out[i] = sum / count
  }
  return out
}

/**
 * Everything the recorded geometry can say about the track itself.
 *
 * `null` for a v1 outline, which has neither elevation nor lap distance.
 */
export function computeStats(o: TrackOutline | null, trackLength: number): TrackStats | null {
  if (!o || !hasDetail(o) || !o.complete || o.points.length < 10) return null
  const pts = o.points
  const ys = smoothElevation(pts)

  let elevMin = Infinity, elevMax = -Infinity
  for (const y of ys) {
    if (y < elevMin) elevMin = y
    if (y > elevMax) elevMax = y
  }

  // Total ascent, counted against a reference that follows the track down
  // freely but only follows it up once a rise clears the deadband. Undershoots
  // a genuine climb by at most one deadband per slope, which is the right way
  // round: better to lose 30 cm than to report noise as elevation gain.
  let climb = 0
  let ref = ys[0]
  for (const y of ys) {
    if (y >= ref + CLIMB_DEADBAND) { climb += y - ref; ref = y }
    else if (y < ref) { ref = y }
  }

  // Steepest slope over a window wide enough that a single kerb cannot set it.
  let maxGradient = 0
  for (let i = 0, j = 0; i < pts.length; i++) {
    while (j < pts.length - 1 && pts[j].d - pts[i].d < GRADIENT_WINDOW) j++
    const run = pts[j].d - pts[i].d
    if (run < GRADIENT_WINDOW) break
    const grade = Math.abs((ys[j] - ys[i]) / run) * 100
    if (grade > maxGradient) maxGradient = grade
  }

  const length = trackLength > 0 ? trackLength : pts[pts.length - 1].d
  const sectors: [number, number, number] | null =
    o.sector1Dist > 0 && o.sector2Dist > o.sector1Dist && length > o.sector2Dist
      ? [o.sector1Dist, o.sector2Dist - o.sector1Dist, length - o.sector2Dist]
      : null

  return {
    sectors,
    elevMin,
    elevMax,
    elevRange: elevMax - elevMin,
    climb,
    maxGradient,
  }
}

/**
 * Elevation profile as an SVG path, filled down to the baseline.
 *
 * Drawn against lap distance rather than point index so the horizontal axis is
 * the track, not the sampling rate.
 */
export function elevationPath(
  o: TrackOutline, width: number, height: number,
): { area: string; line: string } | null {
  if (!hasDetail(o) || o.points.length < 10) return null
  const pts = o.points
  const ys = smoothElevation(pts)
  const maxD = pts[pts.length - 1].d
  if (maxD <= 0) return null

  let lo = Infinity, hi = -Infinity
  for (const y of ys) { if (y < lo) lo = y; if (y > hi) hi = y }
  const span = hi - lo || 1

  let line = ''
  for (let i = 0; i < pts.length; i++) {
    const px = (pts[i].d / maxD) * width
    const py = height - ((ys[i] - lo) / span) * height
    line += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1)
  }
  return { area: `${line}L${width} ${height}L0 ${height}Z`, line }
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

function storedKey(name: string): string {
  return 'lmu-trackmap-' + name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

/** Bring a stored record up to the current shape, or reject it as unusable. */
function migrate(raw: unknown): TrackOutline | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<TrackOutline> & { points?: unknown }
  if (!Array.isArray(o.points) || !o.bounds) return null

  const version = typeof o.version === 'number' ? o.version : 1
  const points: TrackPoint[] = o.points.map((p) => {
    const q = p as Partial<TrackPoint>
    return {
      x: q.x ?? 0,
      y: typeof q.y === 'number' ? q.y : 0,
      z: q.z ?? 0,
      d: typeof q.d === 'number' ? q.d : -1,
    }
  })

  return {
    version,
    trackName: o.trackName ?? '',
    points,
    bounds: o.bounds,
    complete: !!o.complete,
    sector1Dist: typeof o.sector1Dist === 'number' ? o.sector1Dist : -1,
    sector2Dist: typeof o.sector2Dist === 'number' ? o.sector2Dist : -1,
  }
}

export function loadOutline(name: string): TrackOutline | null {
  try {
    const raw = localStorage.getItem(storedKey(name))
    return raw ? migrate(JSON.parse(raw)) : null
  } catch { return null }
}

export function saveOutline(o: TrackOutline): void {
  try { localStorage.setItem(storedKey(o.trackName), JSON.stringify(o)) } catch { /* quota — the map still works this session */ }
}
