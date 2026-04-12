import { useRef, useEffect, useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

type Channel = 'THR' | 'BRK' | 'CLT' | 'STEER' | 'GX' | 'GZ' | 'REGEN'

const CHANNEL_COLORS: Record<Channel, string> = {
  THR:   colors.success,  // green
  BRK:   colors.danger,   // red
  CLT:   colors.info,     // blue
  STEER: colors.primary,  // yellow
  GX:    '#f97316',       // orange — lateral G
  GZ:    '#06b6d4',       // cyan   — longitudinal G
  REGEN: '#a855f7',       // purple — battery regen
}

const SPEED_OPTIONS = [
  { label: '5s',  seconds: 5  },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
]

const MAX_SAMPLES = 1800  // 30Hz × 60s headroom
const MAX_G       = 30    // m/s² — ±3G, covers typical LMU cars
const MAX_REGEN   = 500   // kW upper bound for normalisation

interface Sample {
  t:     number  // ms timestamp
  thr:   number  // 0–1
  brk:   number  // 0–1
  clt:   number  // 0–1
  steer: number  // 0–1 (normalised from -1…+1)
  gx:    number  // 0–1 (±MAX_G, centred at 0.5 = 0G)
  gz:    number  // 0–1 (±MAX_G, centred at 0.5 = 0G)
  regen: number  // 0–1 (0–MAX_REGEN kW)
}

const CHANNEL_GETTERS: Record<Channel, (s: Sample) => number> = {
  THR:   (s) => s.thr,
  BRK:   (s) => s.brk,
  CLT:   (s) => s.clt,
  STEER: (s) => s.steer,
  GX:    (s) => s.gx,
  GZ:    (s) => s.gz,
  REGEN: (s) => s.regen,
}

const BASE_CHANNELS: Channel[] = ['THR', 'BRK', 'CLT', 'STEER', 'GX', 'GZ']
const ALL_CHANNELS:  Channel[] = [...BASE_CHANNELS, 'REGEN']

export default function InputChart() {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const samplesRef = useRef<Sample[]>([])
  const animRef    = useRef<number>(0)
  const sizeRef    = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  const [active, setActive] = useState<Set<Channel>>(() => {
    try {
      const raw = localStorage.getItem('lmu-inputchart-channels')
      if (raw) {
        const parsed = JSON.parse(raw) as string[]
        const valid = parsed.filter((c): c is Channel => ALL_CHANNELS.includes(c as Channel))
        if (valid.length > 0) return new Set(valid)
      }
    } catch { /* ignore */ }
    return new Set<Channel>(['THR', 'BRK', 'CLT', 'STEER'])
  })

  const [speedIdx, setSpeedIdx] = useState(() => {
    try {
      const raw = localStorage.getItem('lmu-inputchart-speed')
      if (raw !== null) {
        const idx = parseInt(raw, 10)
        if (idx >= 0 && idx < SPEED_OPTIONS.length) return idx
      }
    } catch { /* ignore */ }
    return 1  // default 15s
  })

  // REGEN toggle only appears once we observe regen > 0 in the current session
  const [regenAvailable, setRegenAvailable] = useState(false)

  // ── pull latest telemetry ─────────────────────────────────────────────────
  const throttle   = useTelemetryStore((s) => s.telemetry.throttle)
  const brake      = useTelemetryStore((s) => s.telemetry.brake)
  const clutch     = useTelemetryStore((s) => s.telemetry.clutch)
  const steering   = useTelemetryStore((s) => s.telemetry.steering)
  const localAccel = useTelemetryStore((s) => s.telemetry.local_accel)
  const regenKw        = useTelemetryStore((s) => s.electronics.regen)
  const inputChartFps  = useSettingsStore((s) => s.inputChartFps)

  // ── track container size via ResizeObserver ───────────────────────────────
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      sizeRef.current = { w: Math.floor(width), h: Math.floor(height) }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── push sample on every telemetry tick ───────────────────────────────────
  useEffect(() => {
    if (regenKw > 0) setRegenAvailable(true)

    // G values: map ±MAX_G → 0–1, centre 0G at 0.5
    const gx = Math.min(Math.max((localAccel.x / MAX_G + 1) / 2, 0), 1)
    const gz = Math.min(Math.max((localAccel.z / MAX_G + 1) / 2, 0), 1)

    const buf = samplesRef.current
    buf.push({
      t:     Date.now(),
      thr:   throttle,
      brk:   brake,
      clt:   clutch,
      steer: (steering + 1) / 2,
      gx,
      gz,
      regen: Math.min(regenKw / MAX_REGEN, 1),
    })
    if (buf.length > MAX_SAMPLES) buf.shift()
  }, [throttle, brake, clutch, steering, localAccel, regenKw])

  // ── canvas render loop ────────────────────────────────────────────────────
  useEffect(() => {
    const windowMs = SPEED_OPTIONS[speedIdx].seconds * 1000
    const frameInterval = 1000 / inputChartFps
    let lastDraw = 0

    function draw(now: number) {
      if (now - lastDraw < frameInterval) { animRef.current = requestAnimationFrame(draw); return }
      lastDraw = now

      const canvas = canvasRef.current
      if (!canvas) { animRef.current = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')
      if (!ctx)   { animRef.current = requestAnimationFrame(draw); return }

      const { w, h } = sizeRef.current
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w
        canvas.height = h
      }
      if (w === 0 || h === 0) { animRef.current = requestAnimationFrame(draw); return }

      ctx.fillStyle = '#0a0a0a'
      ctx.fillRect(0, 0, w, h)

      // horizontal grid lines at 25 / 50 / 75 %
      // For G channels the 50% line = 0G, which serves as a useful zero reference
      ctx.strokeStyle = '#1e1e1e'
      ctx.lineWidth   = 1
      for (const pct of [0.25, 0.5, 0.75]) {
        const y = Math.round(pct * h) + 0.5
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      const ts        = Date.now()
      const startTime = ts - windowMs
      const buf       = samplesRef.current
      const visible   = buf.filter((s) => s.t >= startTime)
      if (visible.length < 2) { animRef.current = requestAnimationFrame(draw); return }

      const xFor = (t: number) => ((t - startTime) / windowMs) * w

      for (const ch of ALL_CHANNELS) {
        if (!active.has(ch)) continue
        const getter = CHANNEL_GETTERS[ch]
        ctx.beginPath()
        ctx.strokeStyle = CHANNEL_COLORS[ch]
        ctx.lineWidth   = 1.5
        ctx.lineJoin    = 'round'
        let first = true
        for (const s of visible) {
          const x = xFor(s.t)
          const y = (1 - getter(s)) * h
          if (first) { ctx.moveTo(x, y); first = false }
          else        ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      animRef.current = requestAnimationFrame(draw)
    }

    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [active, speedIdx, inputChartFps])

  function toggleChannel(ch: Channel) {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch)
      else              next.add(ch)
      try { localStorage.setItem('lmu-inputchart-channels', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }

  function changeSpeed(idx: number) {
    setSpeedIdx(idx)
    try { localStorage.setItem('lmu-inputchart-speed', String(idx)) } catch { /* ignore */ }
  }

  const visibleChannels: Channel[] = regenAvailable ? ALL_CHANNELS : BASE_CHANNELS

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>

      {/* chart */}
      <div ref={wrapperRef} style={{ flex: 1, position: 'relative', width: '100%', minHeight: 0 }}>
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', inset: 0, display: 'block', borderRadius: 3 }}
        />
      </div>

      {/* bottom bar: channel toggles left, speed selector right */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
        gap: 8,
      }}>

        {/* channel toggles */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {visibleChannels.map((ch) => {
            const on = active.has(ch)
            return (
              <button
                key={ch}
                onClick={() => toggleChannel(ch)}
                style={{
                  background:    on ? CHANNEL_COLORS[ch] + '22' : 'transparent',
                  border:        `1px solid ${on ? CHANNEL_COLORS[ch] : '#333'}`,
                  color:         on ? CHANNEL_COLORS[ch] : '#555',
                  borderRadius:  3,
                  padding:       '2px 7px',
                  fontSize:      13,
                  fontFamily:    fonts.mono,
                  cursor:        'pointer',
                  letterSpacing: 0.5,
                  transition:    'all 0.1s',
                }}
              >
                {ch}
              </button>
            )
          })}
        </div>

        {/* speed selector */}
        <div style={{ display: 'flex', gap: 3 }}>
          {SPEED_OPTIONS.map((opt, i) => {
            const on = speedIdx === i
            return (
              <button
                key={opt.label}
                onClick={() => changeSpeed(i)}
                style={{
                  background:   on ? '#ffffff12' : 'transparent',
                  border:       `1px solid ${on ? '#555' : '#2a2a2a'}`,
                  color:        on ? colors.text : colors.textMuted,
                  borderRadius: 3,
                  padding:      '2px 7px',
                  fontSize:     13,
                  fontFamily:   fonts.mono,
                  cursor:       'pointer',
                  transition:   'all 0.1s',
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

      </div>
    </div>
  )
}
