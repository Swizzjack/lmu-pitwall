/**
 * Motion trails — smooth positions out of stepped updates.
 *
 * Car positions arrive as discrete updates. Drawing a frame straight from the
 * newest one makes cars step: they cover the gap in one jump and then hold
 * still until the next update lands. Instead every update is timestamped into a
 * short buffer, and the renderer asks for the position at a moment slightly in
 * the past — one that always has a sample either side of it, so the answer is
 * an interpolation and the motion is continuous.
 *
 * The delay is the whole cost, and it is a fraction of a second on a display of
 * where cars are, not a control input.
 */

export interface Sample {
  /** `performance.now()` when this position arrived (ms). */
  t: number
  x: number
  z: number
  /** Lap distance (m). Negative in the pit lane, and resets at the line. */
  d: number
}

export interface Trail {
  samples: Sample[]
  /** Rolling mean interval between position changes for this car (ms). */
  gapMs: number
}

/** Samples kept per car — about a second at any realistic update rate. */
const MAX_SAMPLES = 24

/** A jump further than this (m) between samples is a teleport, not driving. */
const TELEPORT_M = 200

/** Weight of the newest interval in the rolling mean. */
const GAP_SMOOTHING = 0.15

export function newTrail(): Trail {
  return { samples: [], gapMs: 0 }
}

/**
 * Record a position, unless it says nothing new.
 *
 * An unchanged position means the source has not ticked — the same value
 * arriving twice is not the car standing still. Storing it would tell the
 * interpolator exactly that, and then that the car jumped to catch up, which is
 * the motion this module exists to remove.
 *
 * A position that jumped implausibly far is a respawn, a session restart or a
 * car swap. Sliding a marker across the map over that is worse than moving it,
 * so the buffer is dropped and the car reappears at its new position.
 */
export function pushSample(trail: Trail, t: number, x: number, z: number, d: number): void {
  const last = trail.samples[trail.samples.length - 1]
  if (last) {
    if (last.x === x && last.z === z) return
    const gap = t - last.t
    if (gap > 0) trail.gapMs = trail.gapMs === 0 ? gap : trail.gapMs * (1 - GAP_SMOOTHING) + gap * GAP_SMOOTHING
    if (Math.hypot(x - last.x, z - last.z) > TELEPORT_M) trail.samples.length = 0
  }
  trail.samples.push({ t, x, z, d })
  if (trail.samples.length > MAX_SAMPLES) trail.samples.shift()
}

/**
 * How far behind live to draw this car, in milliseconds.
 *
 * A little over one of its own update intervals, so there is nearly always a
 * sample on the far side of the drawn moment. Measured per car rather than
 * assumed, because a field can be mixed — the game publishes the player's
 * position more often than it may publish an opponent's, and one global delay
 * would either stall the fast ones or over-lag the slow ones.
 */
export function renderDelay(trail: Trail): number {
  return Math.min(400, Math.max(60, trail.gapMs * 1.5 + 20))
}

/**
 * Position at time `t`, interpolated between the samples either side of it.
 *
 * Outside the buffer the nearest end is held: ahead of the newest sample means
 * the updates stopped coming, and a car frozen where it was last seen is the
 * honest answer — guessing where it went would only have to be taken back.
 */
export function sampleAt(trail: Trail, t: number): Sample | null {
  const s = trail.samples
  if (s.length === 0) return null
  if (s.length === 1 || t >= s[s.length - 1].t) return s[s.length - 1]
  if (t <= s[0].t) return s[0]

  for (let i = s.length - 1; i > 0; i--) {
    const b = s[i], a = s[i - 1]
    if (t < a.t) continue
    const span = b.t - a.t
    const f = span > 0 ? (t - a.t) / span : 1
    return {
      t,
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      // Lap distance resets to zero at the line. Interpolating across that
      // would run the car backwards over a whole lap, so the reset snaps.
      d: b.d < a.d ? b.d : a.d + (b.d - a.d) * f,
    }
  }
  return s[s.length - 1]
}
