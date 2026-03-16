import React, { useRef, useState, useEffect } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'
import type { TireData } from '../../types/telemetry'

// Color thresholds in °C — applied on the raw °C value before display conversion
function tempColorC(tempC: number): string {
  if (tempC <= 0) return '#333'
  if (tempC < 60)  return '#3b82f6'  // cold
  if (tempC < 80)  return '#22c55e'  // optimal
  if (tempC < 100) return '#facc15'  // warm
  return '#ef4444'                   // hot
}

function wearColor(pct: number): string {
  if (pct >= 70) return '#22c55e'
  if (pct >= 40) return '#facc15'
  if (pct >= 20) return '#f97316'
  return '#ef4444'
}

// Brake temp color thresholds always in °C regardless of display unit
function brakeColorC(tempC: number): string {
  if (tempC < 200) return '#3b82f6'  // cold
  if (tempC < 600) return '#22c55e'  // optimal
  if (tempC < 800) return '#facc15'  // hot
  return '#ef4444'                   // critical
}

// ---------------------------------------------------------------------------
// WearDonut — SVG donut chart showing remaining tire material
// pct = worn percentage (0 = new, 100 = fully worn)
// ---------------------------------------------------------------------------
function WearDonut({ pct }: { pct: number }) {
  const r = 8
  const size = 22
  const cx = size / 2
  const cy = size / 2
  const circ = 2 * Math.PI * r
  const dashLen = (Math.max(0, Math.min(100, pct)) / 100) * circ
  const col = wearColor(pct)

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      {/* Track */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1f2937" strokeWidth={4} />
      {/* Fill — remaining material */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke={col}
        strokeWidth={4}
        strokeDasharray={`${dashLen} ${circ}`}
        strokeLinecap="butt"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// BrakeBar — small vertical bar showing brake temperature
// ---------------------------------------------------------------------------
function BrakeBar({ tempC }: { tempC: number }) {
  const maxC = 1000
  const pct = Math.min(tempC / maxC * 100, 100)
  const col = brakeColorC(tempC)
  return (
    <div style={{
      width: 8,
      height: 22,
      background: '#1f2937',
      borderRadius: 2,
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'flex-end',
      flexShrink: 0,
    }}>
      <div style={{
        width: '100%',
        height: `${pct}%`,
        background: col,
        transition: 'height 0.4s ease',
      }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// TireCell — adapts to available size via `size` prop
// ---------------------------------------------------------------------------

type CellSize = 'tiny' | 'normal'

function TireCell({ label, tire, size, mirror = false }: { label: string; tire: TireData; size: CellSize; mirror?: boolean }) {
  const toDisplayTemp     = useSettingsStore((s) => s.toDisplayTemp)
  const tempUnitLabel     = useSettingsStore((s) => s.tempUnitLabel)
  const toDisplayPressure = useSettingsStore((s) => s.toDisplayPressure)
  const pressureUnitLabel = useSettingsStore((s) => s.pressureUnitLabel)

  const avgTempC        = (tire.temp_inner + tire.temp_mid + tire.temp_outer) / 3
  const avgTempDisplay  = toDisplayTemp(avgTempC)
  const pressureDisplay = toDisplayPressure(tire.pressure)
  const pressureDec     = pressureUnitLabel() === 'psi' ? 0 : 1

  const wearPct          = Math.round(tire.wear * 100)
  const wearCol          = wearColor(wearPct)
  const brakeTempC       = tire.brake_temp
  const brakeTempDisplay = toDisplayTemp(brakeTempC)
  const brakeCol         = brakeColorC(brakeTempC)

  // No data sentinel: all fields zero means game not connected / garage
  const hasData = avgTempC !== 0 || tire.pressure !== 0 || tire.brake_temp !== 0

  const txt = (sz: number, col: string): React.CSSProperties => ({
    fontFamily: fonts.mono,
    fontSize: sz,
    color: col,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  })

  if (size === 'tiny') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, lineHeight: 1, letterSpacing: 1 }}>{label}</span>
        <div style={{ display: 'flex', gap: 2, height: 20, width: 24 }}>
          {[tire.temp_inner, tire.temp_mid, tire.temp_outer].map((t, i) => (
            <div key={i} style={{ flex: 1, background: tempColorC(t), borderRadius: 2, opacity: 0.85 }} />
          ))}
        </div>
        <span style={txt(15, wearCol)}>W:{wearPct}%</span>
        <span style={txt(15, brakeCol)}>
          B:{hasData ? `${Math.round(brakeTempDisplay)}${tempUnitLabel()}` : '--'}
        </span>
      </div>
    )
  }

  // Normal mode layout:
  //   [label]
  //   [temp bars (left)] | [wear donut + wear%   (right)]
  //   [avg temp         ] | [brake bar  + brake°C (right)]
  //   [pressure         ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      {/* Label */}
      <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, lineHeight: 1, letterSpacing: 1 }}>
        {label}
      </span>

      {/* Main row */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'flex-start', flexDirection: mirror ? 'row-reverse' : 'row' }}>

        {/* Temp: 3-zone temp bars + avg temp + pressure */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <div style={{ display: 'flex', gap: 2, height: 22, width: 30 }}>
            {[tire.temp_inner, tire.temp_mid, tire.temp_outer].map((t, i) => (
              <div key={i} style={{ flex: 1, background: tempColorC(t), borderRadius: 2, opacity: 0.85 }} />
            ))}
          </div>
          <span style={txt(15, colors.text)}>
            {hasData && avgTempC > 0 ? `${Math.round(avgTempDisplay)}${tempUnitLabel()}` : '--'}
          </span>
          <span style={txt(15, colors.textMuted)}>
            {hasData && tire.pressure > 0 ? `${pressureDisplay.toFixed(pressureDec)} ${pressureUnitLabel()}` : '--'}
          </span>
        </div>

        {/* Wear/Brake: wear (donut + text) above, brake (bar + text) below */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>

          {/* Wear row */}
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <WearDonut pct={wearPct} />
            <span style={txt(15, wearCol)}>{wearPct}%</span>
          </div>

          {/* Brake row */}
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <BrakeBar tempC={brakeTempC} />
            <span style={txt(15, brakeCol)}>
              {hasData ? `${Math.round(brakeTempDisplay)}${tempUnitLabel()}` : '--'}
            </span>
          </div>

        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TireMonitor
// ---------------------------------------------------------------------------

export default function TireMonitor() {
  const tires        = useTelemetryStore((s) => s.telemetry.tires)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<CellSize>('normal')

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height
      const w = entry.contentRect.width
      setSize(h < 160 || w < 120 ? 'tiny' : 'normal')
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const defaultTire: TireData = { temp_inner: 0, temp_mid: 0, temp_outer: 0, pressure: 0, wear: 0, brake_temp: 0 }
  const [fl, fr, rl, rr] = tires ?? [defaultTire, defaultTire, defaultTire, defaultTire]

  const gap     = size === 'tiny' ? 6 : 8
  const cellGap = size === 'tiny' ? '4px 8px' : '6px 14px'

  return (
    <div ref={containerRef} style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: cellGap }}>
        <TireCell label="FL" tire={fl} size={size} mirror />
        <TireCell label="FR" tire={fr} size={size} />
        <TireCell label="RL" tire={rl} size={size} mirror />
        <TireCell label="RR" tire={rr} size={size} />
      </div>
      <div style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
        Tires
      </div>
    </div>
  )
}
