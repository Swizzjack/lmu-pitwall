import { Sun, CloudSun, Cloud, CloudRain, CloudLightning, CloudDrizzle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'
import type { WeatherForecastNode } from '../../types/telemetry'
import type { WeatherSnapshot } from '../../stores/telemetryStore'

// ---------------------------------------------------------------------------
// Weather icon resolver — shared by main section and forecast
// ---------------------------------------------------------------------------

interface WeatherIconDef { Icon: LucideIcon; color: string }

function resolveWeatherIcon(rainValue: number, skyType?: number, darkCloud?: number): WeatherIconDef {
  if (skyType !== undefined && skyType >= 0 && skyType <= 10) {
    // WNV_SKY: 0=Clear, 1=Light Cloud, 2=Partly Cloudy, 3=Mostly Cloudy, 4=Overcast,
    //          5=Drizzle, 6=Light Rain, 7=Overcast+Light Rain, 8=Rain, 9=Heavy Rain, 10=Storm
    switch (skyType) {
      case 0:  return { Icon: Sun,            color: '#facc15' }
      case 1:  return { Icon: CloudSun,       color: '#94a3b8' }
      case 2:  return { Icon: CloudSun,       color: '#6b7280' }
      case 3:  return { Icon: Cloud,          color: '#9ca3af' }
      case 4:  return { Icon: Cloud,          color: '#6b7280' }  // Overcast
      case 5:  return { Icon: CloudDrizzle,   color: '#93c5fd' }
      case 6:  return { Icon: CloudDrizzle,   color: '#60a5fa' }
      case 7:  return { Icon: CloudRain,      color: '#60a5fa' }
      case 8:  return { Icon: CloudRain,      color: '#3b82f6' }
      case 9:  return { Icon: CloudRain,      color: '#ef4444' }  // Heavy Rain
      case 10: return { Icon: CloudLightning, color: '#ef4444' }
    }
  }
  // Fallback: thresholds match TinyPedal's mRaining → sky_type mapping
  if (rainValue > 0.60) return { Icon: CloudLightning, color: '#ef4444' }  // storm
  if (rainValue > 0.40) return { Icon: CloudRain,      color: '#ef4444' }  // heavy rain
  if (rainValue > 0.20) return { Icon: CloudRain,      color: '#3b82f6' }  // rain
  if (rainValue > 0.15) return { Icon: CloudRain,      color: '#60a5fa' }  // light rain
  if (rainValue > 0.10) return { Icon: CloudDrizzle,   color: '#60a5fa' }  // drizzle+
  if (rainValue > 0)    return { Icon: CloudDrizzle,   color: '#93c5fd' }  // drizzle
  // No rain — use dark_cloud (mDarkCloud) for overcast/cloudy conditions
  const dc = darkCloud ?? 0
  if (dc > 0.70) return { Icon: Cloud,    color: '#6b7280' }  // overcast
  if (dc > 0.40) return { Icon: Cloud,    color: '#9ca3af' }  // mostly cloudy
  if (dc > 0.20) return { Icon: CloudSun, color: '#6b7280' }  // partly cloudy
  if (dc > 0.05) return { Icon: CloudSun, color: '#94a3b8' }  // light cloud
  return                 { Icon: Sun,     color: '#facc15' }  // clear
}

// ---------------------------------------------------------------------------
// Trend computation from history
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wetness state — based on actual water on track (mAvgPathWetness)
// WET is a threshold state (track saturated ≥ 40%), not a trend direction.
// DAMP = stable moderate moisture between DRY and WET.
// ---------------------------------------------------------------------------

type WetState = 'dry' | 'drying' | 'damp' | 'wetting' | 'wet'

function computeWetState(history: WeatherSnapshot[]): WetState {
  const COMPARE_WINDOW = 6
  const latest = history[history.length - 1]
  if (!latest) return 'dry'
  const avg = latest.avg_path_wetness
  if (avg >= 0.40) return 'wet'
  if (avg < 0.02)  return 'dry'
  if (history.length >= COMPARE_WINDOW) {
    const old   = history[history.length - COMPARE_WINDOW]
    const delta = avg - old.avg_path_wetness
    if (delta >  0.03) return 'wetting'
    if (delta < -0.03) return 'drying'
  }
  return 'damp'
}

const WET_CONFIG: Record<WetState, { label: string; symbol: string; color: string }> = {
  dry:     { label: 'DRY',     symbol: '○', color: '#facc15' },
  drying:  { label: 'DRYING',  symbol: '↑', color: '#22c55e' },
  damp:    { label: 'DAMP',    symbol: '~', color: '#6b7280' },
  wetting: { label: 'WETTING', symbol: '↓', color: '#60a5fa' },
  wet:     { label: 'WET',     symbol: '●', color: '#38bdf8' },
}

// ---------------------------------------------------------------------------
// Temperature trend — track temp over 90s window (grip / rubber / evaporation)
// ---------------------------------------------------------------------------

type TempTrend = 'warming' | 'stable' | 'cooling'

function computeTempTrend(history: WeatherSnapshot[]): TempTrend {
  const COMPARE_WINDOW = 6
  if (history.length < COMPARE_WINDOW) return 'stable'
  const recent = history[history.length - 1]
  const old    = history[history.length - COMPARE_WINDOW]
  const delta  = recent.track_temp - old.track_temp
  if (delta >  1.5) return 'warming'
  if (delta < -1.0) return 'cooling'
  return 'stable'
}

const TEMP_CONFIG: Record<TempTrend, { label: string; symbol: string; color: string }> = {
  warming: { label: 'WARMING', symbol: '↑', color: '#f97316' },
  stable:  { label: 'STABLE',  symbol: '→', color: '#6b7280' },
  cooling: { label: 'COOLING', symbol: '↓', color: '#94a3b8' },
}

// ---------------------------------------------------------------------------
// Sparkline — track temp + rain over history
// ---------------------------------------------------------------------------

function Sparkline({ history, toDisplayTemp }: {
  history: WeatherSnapshot[]
  toDisplayTemp: (c: number) => number
}) {
  if (history.length < 3) return null

  const W = 200
  const H = 36
  const PAD = 2

  function buildRainPath(values: number[]): string {
    // Always anchored at 0 so a small drizzle doesn't fill the whole chart
    const fixedMax = Math.max(1.0, ...values)
    return values.map((v, i) => {
      const x = PAD + (i / (values.length - 1)) * (W - PAD * 2)
      const y = PAD + (1 - v / fixedMax) * (H - PAD * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  function buildTempPath(values: number[]): string {
    const min = Math.min(...values)
    const max = Math.max(...values)
    // Enforce minimum 3° range to avoid noise amplification on stable temps
    const mid = (min + max) / 2
    const half = Math.max((max - min) / 2, 1.5)
    const lo = mid - half
    const hi = mid + half
    return values.map((v, i) => {
      const x = PAD + (i / (values.length - 1)) * (W - PAD * 2)
      const y = PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  const trackVals   = history.map(s => toDisplayTemp(s.track_temp))
  const rainVals    = history.map(s => s.rain_intensity)
  const wetnessVals = history.map(s => s.avg_path_wetness)
  const rainPath    = buildRainPath(rainVals)
  const wetPath     = buildRainPath(wetnessVals)
  const bottom      = (PAD + (H - PAD * 2)).toFixed(1)

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', height: H }}>
        {/* Track wetness (cyan filled — actual water on track) */}
        <path
          d={wetPath + ` L${(PAD + (W - PAD * 2)).toFixed(1)},${bottom} L${PAD},${bottom} Z`}
          fill="#38bdf818" stroke="none"
        />
        <path d={wetPath} fill="none" stroke="#38bdf8" strokeWidth="1.2" strokeLinejoin="round" />
        {/* Rain intensity (blue line — precipitation rate) */}
        <path d={rainPath} fill="none" stroke="#60a5fa" strokeWidth="1.2" strokeDasharray="3,2" strokeLinejoin="round" />
        {/* Track temp (orange line, relative scale) */}
        <path d={buildTempPath(trackVals)} fill="none" stroke="#f97316" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 2 }}>
        <span style={{ fontFamily: fonts.body, fontSize: 9, color: '#f97316', display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ display: 'inline-block', width: 12, height: 2, background: '#f97316', borderRadius: 1 }} />
          Track °
        </span>
        <span style={{ fontFamily: fonts.body, fontSize: 9, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ display: 'inline-block', width: 12, height: 2, background: '#60a5fa', borderRadius: 1, opacity: 0.6 }} />
          Rain
        </span>
        <span style={{ fontFamily: fonts.body, fontSize: 9, color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ display: 'inline-block', width: 12, height: 2, background: '#38bdf8', borderRadius: 1 }} />
          Wet
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Forecast panel
// ---------------------------------------------------------------------------

// Fractions of session length at which each forecast node is defined (from TinyPedal source).
// START=0.0, NODE_25=0.2, NODE_50=0.4, NODE_75=0.6, FINISH=0.8
const NODE_FRACTIONS = [0.0, 0.2, 0.4, 0.6, 0.8]

interface NodeEta {
  minutes: number       // minutes until this node; negative = already passed
  laps: number | null   // estimated laps; null = no avg lap time available yet
}

function formatEta(eta: NodeEta): string {
  const { minutes, laps } = eta
  if (minutes < 1) return '< 1 min'
  const lapStr = laps !== null && laps > 0 ? ` / ${laps} lap` : ''
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} h${lapStr}`
  return `${Math.round(minutes)} min${lapStr}`
}

function ForecastPanel({ nodes, toDisplayTemp, tempLabel, nodeEta }: {
  nodes: WeatherForecastNode[]
  toDisplayTemp: (c: number) => number
  tempLabel: string
  nodeEta: NodeEta[]
}) {
  if (nodes.length === 0) return null
  return (
    <div>
      <div style={{
        fontFamily: fonts.body, fontSize: 11, color: colors.textMuted,
        textTransform: 'uppercase', letterSpacing: 2, marginBottom: 5,
      }}>Forecast</div>
      <div style={{ display: 'flex', gap: 3 }}>
        {nodes.map((node, i) => {
          const eta = nodeEta[i]
          if (i > 0 && eta.minutes <= 0) return null
          const { Icon, color } = resolveWeatherIcon(node.rain_chance, node.sky_type)
          const rainColor = node.rain_chance > 0.5 ? '#60a5fa' : node.rain_chance > 0.2 ? '#93c5fd' : colors.textMuted
          const isNow = i === 0
          const label = isNow ? 'NOW' : formatEta(eta)
          return (
            <div key={i} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              background: isNow ? '#1a1a2e' : '#111', borderRadius: 4, padding: '6px 4px',
              border: `1px solid ${isNow ? colors.accent + '66' : colors.border}`,
              minWidth: 0,
            }}>
              {/* Label ETA */}
              <span style={{
                fontFamily: fonts.mono, fontSize: 10,
                color: isNow ? colors.accent : colors.textMuted,
                letterSpacing: 0.3, textAlign: 'center', lineHeight: 1.3,
                whiteSpace: 'pre-line',
              }}>
                {label}
              </span>
              {/* Icône seule */}
              <Icon size={28} color={color} strokeWidth={1.6} />
              {/* Température + pluie sur la même ligne */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: '#9ca3af', fontWeight: 600 }}>
                  {toDisplayTemp(node.temperature).toFixed(0)}{tempLabel}
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: rainColor, fontWeight: 700 }}>
                  {(node.rain_chance * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempColor(temp: number, isTrack: boolean): string {
  const cold = isTrack ? 20 : 12
  const hot  = isTrack ? 50 : 35
  if (temp <= cold) return '#60a5fa'
  if (temp >= hot)  return colors.accent
  return colors.success
}

function Divider() {
  return <div style={{ height: 1, background: colors.border, flexShrink: 0 }} />
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export default function WeatherWidget() {
  const weather            = useTelemetryStore((s) => s.session.weather)
  const weatherHistory     = useTelemetryStore((s) => s.weatherHistory)
  const scoringSessionTime = useTelemetryStore((s) => s.scoring.session_time)
  const sessionMinutes     = useTelemetryStore((s) => s.session.session_minutes)
  const avgLapTime         = useTelemetryStore((s) => s.telemetry.fuel_avg_lap_time)
  const toDisplayTemp      = useSettingsStore((s) => s.toDisplayTemp)
  const tempUnitLabel      = useSettingsStore((s) => s.tempUnitLabel)

  const airTempC         = weather?.air_temp          ?? 20
  const trackTempC       = weather?.track_temp        ?? 25
  const rainIntensity    = weather?.rain_intensity    ?? 0
  const darkCloud        = weather?.dark_cloud        ?? 0
  const avgPathWetness   = weather?.avg_path_wetness  ?? 0
  const maxPathWetness   = weather?.max_path_wetness  ?? 0
  const forecast         = weather?.forecast          ?? []

  const airTemp   = toDisplayTemp(airTempC)
  const trackTemp = toDisplayTemp(trackTempC)
  const tempLabel = tempUnitLabel()

  const { Icon: CurrentIcon, color: iconColor } = resolveWeatherIcon(rainIntensity, undefined, darkCloud)
  const wetState  = computeWetState(weatherHistory)
  const tempTrend = computeTempTrend(weatherHistory)
  const wetCfg    = WET_CONFIG[wetState]
  const tempCfg   = TEMP_CONFIG[tempTrend]
  const hasHistory = weatherHistory.length >= 3

  // Compute ETA for each forecast node.
  // Nodes are static for the session; fractions are fixed at [0.0, 0.2, 0.4, 0.6, 0.8].
  const sessionTotalSeconds = sessionMinutes * 60
  const nodeEta: NodeEta[] = NODE_FRACTIONS.map(f => {
    const minutesAway = sessionTotalSeconds > 0
      ? (f * sessionTotalSeconds - scoringSessionTime) / 60
      : 999  // session duration unknown → show all
    const laps = avgLapTime > 0
      ? Math.round(minutesAway * 60 / avgLapTime)
      : null
    return { minutes: minutesAway, laps }
  })

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      padding: '8px 12px', gap: 7,
      boxSizing: 'border-box', overflowY: 'auto',
    }}>

      {/* ── Row 1: icon + rain % + trend badge ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <CurrentIcon size={36} color={iconColor} strokeWidth={1.5} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Rain intensity bar */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                Rain
              </span>
              <span style={{ fontFamily: fonts.mono, fontSize: 18, color: rainIntensity > 0.3 ? '#60a5fa' : colors.textMuted, lineHeight: 1, fontWeight: 700 }}>
                {(rainIntensity * 100).toFixed(0)}%
              </span>
            </div>
            <div style={{ width: '100%', height: 4, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${rainIntensity * 100}%`, height: '100%',
                background: rainIntensity > 0.5 ? '#60a5fa' : rainIntensity > 0.1 ? '#93c5fd' : colors.textMuted,
                borderRadius: 2, transition: 'width 0.5s, background 0.5s',
              }} />
            </div>
          </div>
          {/* Track wetness bar — actual water on surface */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                Track wet
              </span>
              <span style={{ fontFamily: fonts.mono, fontSize: 18, color: avgPathWetness > 0.3 ? '#38bdf8' : avgPathWetness > 0.05 ? '#7dd3fc' : colors.textMuted, lineHeight: 1, fontWeight: 700 }}>
                {(avgPathWetness * 100).toFixed(0)}%
                {maxPathWetness > avgPathWetness + 0.05 && (
                  <span style={{ fontSize: 11, fontWeight: 400, color: colors.textMuted }}>
                    {' '}(max {(maxPathWetness * 100).toFixed(0)}%)
                  </span>
                )}
              </span>
            </div>
            <div style={{ width: '100%', height: 4, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${avgPathWetness * 100}%`, height: '100%',
                background: avgPathWetness > 0.5 ? '#38bdf8' : avgPathWetness > 0.1 ? '#7dd3fc' : '#475569',
                borderRadius: 2, transition: 'width 0.5s, background 0.5s',
              }} />
            </div>
          </div>
        </div>

        {/* Two stacked badges: wetness state + temperature trend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          {/* Wetness badge */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            background: `${wetCfg.color}18`, border: `1px solid ${wetCfg.color}55`,
            borderRadius: 5, padding: '3px 7px', minWidth: 60,
          }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 16, color: wetCfg.color, lineHeight: 1, fontWeight: 700 }}>
              {wetCfg.symbol}
            </span>
            <span style={{ fontFamily: fonts.body, fontSize: 8, color: wetCfg.color, letterSpacing: 1, textTransform: 'uppercase' }}>
              {wetCfg.label}
            </span>
          </div>
          {/* Temperature trend badge */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            background: `${tempCfg.color}18`, border: `1px solid ${tempCfg.color}55`,
            borderRadius: 5, padding: '3px 7px', minWidth: 60,
          }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 16, color: tempCfg.color, lineHeight: 1, fontWeight: 700 }}>
              {tempCfg.symbol}
            </span>
            <span style={{ fontFamily: fonts.body, fontSize: 8, color: tempCfg.color, letterSpacing: 1, textTransform: 'uppercase' }}>
              {tempCfg.label}
            </span>
          </div>
        </div>
      </div>

      <Divider />

      {/* ── Row 2: temperatures ── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {/* Air */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Air</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: tempColor(airTempC, false), fontWeight: 700, lineHeight: 1 }}>
            {airTemp.toFixed(1)}<span style={{ fontSize: 12, fontWeight: 400 }}>{tempLabel}</span>
          </span>
        </div>
        {/* Track */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Track</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: tempColor(trackTempC, true), fontWeight: 700, lineHeight: 1 }}>
            {trackTemp.toFixed(1)}<span style={{ fontSize: 12, fontWeight: 400 }}>{tempLabel}</span>
          </span>
        </div>
        {/* Cloud coverage */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Cloud</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: darkCloud > 0.6 ? '#9ca3af' : '#facc15', fontWeight: 700, lineHeight: 1 }}>
            {(darkCloud * 100).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span>
          </span>
        </div>
        {/* Track wetness summary */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Wet</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: avgPathWetness > 0.3 ? '#38bdf8' : avgPathWetness > 0.05 ? '#7dd3fc' : colors.textMuted, fontWeight: 700, lineHeight: 1 }}>
            {(avgPathWetness * 100).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span>
          </span>
        </div>
      </div>

      {/* ── Row 3: sparkline (only when enough history) ── */}
      {hasHistory && (
        <>
          <Divider />
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ fontFamily: fonts.body, fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                20 min trend
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontFamily: fonts.body, fontSize: 10, color: '#f97316' }}>— track</span>
                <span style={{ fontFamily: fonts.body, fontSize: 10, color: '#60a5fa' }}>— rain</span>
              </div>
            </div>
            <Sparkline history={weatherHistory} toDisplayTemp={toDisplayTemp} />
          </div>
        </>
      )}

      {/* ── Row 4: forecast ── */}
      {forecast.length > 0 && (
        <>
          <Divider />
          <ForecastPanel
            nodes={forecast}
            toDisplayTemp={toDisplayTemp}
            tempLabel={tempLabel}
            nodeEta={nodeEta}
          />
        </>
      )}
    </div>
  )
}
