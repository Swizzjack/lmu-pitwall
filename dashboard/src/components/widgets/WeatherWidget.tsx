import { Sun, CloudSun, Cloud, CloudRain, CloudLightning, CloudFog, CloudDrizzle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  ComposedChart, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
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
      case 4:  return { Icon: CloudFog,       color: '#9ca3af' }
      case 5:  return { Icon: CloudDrizzle,   color: '#93c5fd' }
      case 6:  return { Icon: CloudDrizzle,   color: '#60a5fa' }
      case 7:  return { Icon: CloudRain,      color: '#60a5fa' }
      case 8:  return { Icon: CloudRain,      color: '#3b82f6' }
      case 9:  return { Icon: CloudLightning, color: '#f97316' }
      case 10: return { Icon: CloudLightning, color: '#ef4444' }
    }
  }
  if (rainValue > 0.6)  return { Icon: CloudLightning, color: '#f97316' }
  if (rainValue > 0.25) return { Icon: CloudRain,      color: '#60a5fa' }
  if (rainValue > 0.10) return { Icon: CloudDrizzle,   color: '#60a5fa' }
  if (rainValue > 0)    return { Icon: CloudDrizzle,   color: '#93c5fd' }

  const dc = darkCloud ?? 0
  if (dc > 0.70) return { Icon: Cloud,    color: '#6b7280' }  // overcast
  if (dc > 0.40) return { Icon: Cloud,    color: '#9ca3af' }  // mostly cloudy
  if (dc > 0.20) return { Icon: CloudSun, color: '#6b7280' }  // partly cloudy
  if (dc > 0.05) return { Icon: CloudSun, color: '#94a3b8' }  // light cloud
  return                 { Icon: Sun,     color: '#facc15' }  // clear
}


// ---------------------------------------------------------------------------
// Wetness state — actual water on track (mAvgPathWetness)
// WET = static threshold (≥40%), DAMP = stable moderate moisture.
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
// Temperature trend — track temp over 90s (grip / rubber / evaporation)
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
// Trend chart — dual Y-axis (track temp + rain %), Recharts
// ---------------------------------------------------------------------------

interface ChartPoint {
  minutesAgo: number
  trackTemp: number | null
  rainPct: number | null
}

function WeatherTrendChart({ history, toDisplayTemp }: {
  history: WeatherSnapshot[]
  toDisplayTemp: (c: number) => number
}) {
  if (history.length < 3) {
    return (
      <div style={{
        height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#4b5563', fontSize: 11, fontFamily: fonts.body,
      }}>
        No data yet
      </div>
    )
  }

  const nowTs = history[history.length - 1].ts
  const data: ChartPoint[] = history.map(snap => ({
    minutesAgo: Math.round((snap.ts - nowTs) / 60000),
    trackTemp: toDisplayTemp(snap.track_temp),
    rainPct: snap.rain_intensity * 100,
  }))

  const trackTemps = data.map(d => d.trackTemp as number)
  const domainMin = Math.floor(Math.min(...trackTemps)) - 2
  const domainMax = Math.ceil(Math.max(...trackTemps))  + 2

  const xTickFormatter = (val: number) => val === 0 ? 'now' : `${val}m`

  // Generate sensible X ticks across the available history window
  const oldestMinute = data[0].minutesAgo  // negative number, e.g. -20
  const tickStep = oldestMinute <= -15 ? 5 : oldestMinute <= -8 ? 4 : 2
  const xTicks: number[] = []
  for (let t = oldestMinute; t <= 0; t++) {
    if (t % tickStep === 0) xTicks.push(t)
  }
  if (!xTicks.includes(0)) xTicks.push(0)

  return (
    <ResponsiveContainer width="100%" height={90}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="minutesAgo"
          type="number"
          domain={[oldestMinute, 0]}
          ticks={xTicks}
          tickFormatter={xTickFormatter}
          tick={{ fill: '#6b7280', fontSize: 9, fontFamily: fonts.mono }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis yAxisId="temp" hide domain={[domainMin, domainMax]} width={0} />
        <YAxis yAxisId="rain" orientation="right" hide domain={[0, 100]} width={0} />
        <Tooltip
          contentStyle={{
            background: '#0f0f0f', border: '1px solid #374151',
            fontFamily: fonts.mono, fontSize: 11, borderRadius: 4,
          }}
          labelFormatter={(val) => val === 0 ? 'now' : `${val}m`}
          formatter={(value, name) => {
            const n = Number(value)
            if (name === 'trackTemp') return [`${n.toFixed(1)}°`, 'Track']
            if (name === 'rainPct')   return [`${n.toFixed(0)}%`, 'Rain']
            return [String(value), String(name)]
          }}
        />
        {/* Rain fill + line (rendered first so track line sits on top) */}
        <Area
          yAxisId="rain"
          type="monotone"
          dataKey="rainPct"
          stroke="#60a5fa"
          strokeWidth={2}
          fill="#60a5fa"
          fillOpacity={0.15}
          dot={false}
          connectNulls={false}
        />
        {/* Track temp line */}
        <Line
          yAxisId="temp"
          type="monotone"
          dataKey="trackTemp"
          stroke="#f97316"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// Forecast panel
// ---------------------------------------------------------------------------

// Correct session fractions: START=0%, NODE_25=25%, NODE_50=50%, NODE_75=75%, FINISH=100%
const NODE_FRACTIONS = [0.0, 0.25, 0.5, 0.75, 1.0]

interface NodeEta {
  minutes: number       // minutes until this node; negative = already passed
  laps: number | null   // estimated laps remaining; null = no avg lap time yet
}

function formatEta(eta: NodeEta): string {
  const { minutes, laps } = eta
  if (minutes < 1) return '< 1 min'
  const lapStr = laps !== null && laps > 0 ? `\n${laps}L` : ''
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h${lapStr}`
  return `${Math.round(minutes)}m${lapStr}`
}

function formatAgo(minutes: number): string {
  const abs = Math.abs(minutes)
  if (abs < 1) return 'just now'
  if (abs >= 60) return `${(abs / 60).toFixed(1)}h ago`
  return `${Math.round(abs)}m ago`
}

function ForecastPanel({ nodes, toDisplayTemp, tempLabel, nodeEta, liveRain, liveDarkCloud }: {
  nodes: WeatherForecastNode[]
  toDisplayTemp: (c: number) => number
  tempLabel: string
  nodeEta: NodeEta[]
  liveRain: number
  liveDarkCloud: number
}) {
  if (nodes.length === 0) return null

  // Identify the "current" node: last node whose session time has passed.
  // If no node has been reached yet (very start of session), it's index 0.
  let nowIdx = 0
  for (let i = 0; i < nodeEta.length; i++) {
    if (nodeEta[i].minutes <= 0) nowIdx = i
  }

  return (
    <div>
      <div style={{
        fontFamily: fonts.body, fontSize: 11, color: colors.textMuted,
        textTransform: 'uppercase', letterSpacing: 2, marginBottom: 5,
      }}>Forecast</div>
      <div style={{ display: 'flex', gap: 3 }}>
        {nodes.map((node, i) => {
          const eta    = nodeEta[i]
          const isNow  = i === nowIdx
          const isPast = i < nowIdx

          // NOW: live mRaining; future: blend live→forecast over 30 min; past: REST data
          let displayRain: number
          let resolvedIcon: WeatherIconDef
          if (isNow) {
            displayRain = liveRain
            resolvedIcon = resolveWeatherIcon(liveRain, undefined, liveDarkCloud)
          } else if (!isPast) {
            const liveWeight = Math.max(0, 1 - eta.minutes / 30)
            displayRain = liveRain * liveWeight + node.rain_chance * (1 - liveWeight)
            resolvedIcon = liveWeight > 0.1
              ? resolveWeatherIcon(displayRain)
              : resolveWeatherIcon(node.rain_chance, node.sky_type)
          } else {
            displayRain = node.rain_chance
            resolvedIcon = resolveWeatherIcon(node.rain_chance, node.sky_type)
          }
          const { Icon, color } = resolvedIcon
          const rainColor = displayRain > 0.5 ? '#60a5fa' : displayRain > 0.2 ? '#93c5fd' : colors.textMuted

          const label = isNow
            ? 'NOW'
            : isPast
              ? formatAgo(eta.minutes)
              : formatEta(eta)

          return (
            <div key={i} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              background: isNow ? '#1a1a2e' : isPast ? '#0a0a0a' : '#111',
              borderRadius: 4, padding: '6px 4px',
              border: `1px solid ${isNow ? colors.accent + '66' : colors.border}`,
              minWidth: 0,
              opacity: isPast ? 0.45 : 1,
            }}>
              <span style={{
                fontFamily: fonts.mono, fontSize: 10,
                color: isNow ? colors.accent : colors.textMuted,
                letterSpacing: 0.3, textAlign: 'center', lineHeight: 1.3,
                whiteSpace: 'pre-line',
              }}>
                {label}
              </span>
              <Icon size={28} color={isPast ? '#4b5563' : color} strokeWidth={1.6} />
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: '#9ca3af', fontWeight: 600 }}>
                  {toDisplayTemp(node.temperature).toFixed(0)}{tempLabel}
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 13, color: rainColor, fontWeight: 700 }}>
                  {(displayRain * 100).toFixed(0)}%
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
  const weatherDetail      = useSettingsStore((s) => s.weatherDetail)

  const airTempC       = weather?.air_temp          ?? 20
  const trackTempC     = weather?.track_temp        ?? 25
  const rainIntensity  = weather?.rain_intensity    ?? 0
  const darkCloud      = weather?.dark_cloud        ?? 0
  const avgPathWetness = weather?.avg_path_wetness  ?? 0
  const forecast       = weather?.forecast          ?? []

  const airTemp   = toDisplayTemp(airTempC)
  const trackTemp = toDisplayTemp(trackTempC)
  const tempLabel = tempUnitLabel()

  const { Icon: CurrentIcon, color: iconColor } = resolveWeatherIcon(rainIntensity, undefined, darkCloud)
  const hasHistory = weatherHistory.length >= 3

  const wetState  = computeWetState(weatherHistory)
  const tempTrend = computeTempTrend(weatherHistory)
  const wetCfg    = WET_CONFIG[wetState]
  const tempCfg   = TEMP_CONFIG[tempTrend]

  // Compute ETA for each forecast node based on actual session fractions
  const sessionTotalSeconds = sessionMinutes * 60
  const nodeEta: NodeEta[] = NODE_FRACTIONS.map(f => {
    const minutesAway = sessionTotalSeconds > 0
      ? (f * sessionTotalSeconds - scoringSessionTime) / 60
      : 999  // session duration unknown → show all as future
    const laps = avgLapTime > 0
      ? Math.round(minutesAway * 60 / avgLapTime)
      : null
    return { minutes: minutesAway, laps }
  })

  // Derive cloudiness from the current forecast node's sky_type (0–10 → 0.0–1.0).
  // The backend always sends the START node value which reflects session-begin conditions,
  // not current conditions. Fall back to the backend value only when no forecast exists.
  const nowForecastIdx = nodeEta.reduce((idx, eta, i) => eta.minutes <= 0 ? i : idx, 0)
  const cloudiness = forecast.length > 0
    ? (forecast[nowForecastIdx]?.sky_type ?? 0) / 10
    : (weather?.cloudiness ?? 0)

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      padding: '8px 12px', gap: 7,
      boxSizing: 'border-box', overflowY: 'auto',
    }}>

      {/* ── Row 1: icon + rain % + track wet % + wetness badge ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <CurrentIcon size={32} color={iconColor} strokeWidth={1.5} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Rain</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: rainIntensity > 0.3 ? '#60a5fa' : colors.textMuted, fontWeight: 700, lineHeight: 1 }}>
            {(rainIntensity * 100).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span>
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Track wet</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: avgPathWetness > 0.3 ? '#38bdf8' : avgPathWetness > 0.05 ? '#7dd3fc' : colors.textMuted, fontWeight: 700, lineHeight: 1 }}>
            {(avgPathWetness * 100).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span>
          </span>
        </div>
        {/* Wetness state badge */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flexShrink: 0,
          background: `${wetCfg.color}18`, border: `1px solid ${wetCfg.color}55`,
          borderRadius: 6, padding: '4px 8px', minWidth: 58,
        }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: wetCfg.color, lineHeight: 1, fontWeight: 700 }}>{wetCfg.symbol}</span>
          <span style={{ fontFamily: fonts.body, fontSize: 9, color: wetCfg.color, letterSpacing: 1, textTransform: 'uppercase' }}>{wetCfg.label}</span>
        </div>
      </div>

      <Divider />

      {/* ── Row 2: temperatures + cloud + temp trend badge ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Air</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: tempColor(airTempC, false), fontWeight: 700, lineHeight: 1 }}>
            {airTemp.toFixed(1)}<span style={{ fontSize: 12, fontWeight: 400 }}>{tempLabel}</span>
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Track</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: tempColor(trackTempC, true), fontWeight: 700, lineHeight: 1 }}>
            {trackTemp.toFixed(1)}<span style={{ fontSize: 12, fontWeight: 400 }}>{tempLabel}</span>
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Cloud</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: cloudiness > 0.6 ? '#9ca3af' : '#facc15', fontWeight: 700, lineHeight: 1 }}>
            {(cloudiness * 100).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span>
          </span>
        </div>
        {/* Temperature trend badge */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flexShrink: 0,
          background: `${tempCfg.color}18`, border: `1px solid ${tempCfg.color}55`,
          borderRadius: 6, padding: '4px 8px', minWidth: 58,
        }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: tempCfg.color, lineHeight: 1, fontWeight: 700 }}>{tempCfg.symbol}</span>
          <span style={{ fontFamily: fonts.body, fontSize: 9, color: tempCfg.color, letterSpacing: 1, textTransform: 'uppercase' }}>{tempCfg.label}</span>
        </div>
      </div>

      {/* ── Row 3: forecast ── */}
      {weatherDetail !== 'compact' && forecast.length > 0 && (
        <>
          <Divider />
          <ForecastPanel
            nodes={forecast}
            toDisplayTemp={toDisplayTemp}
            tempLabel={tempLabel}
            nodeEta={nodeEta}
            liveRain={rainIntensity}
            liveDarkCloud={darkCloud}
          />
        </>
      )}

      {/* ── Row 4: 20 min trend chart ── */}
      {weatherDetail === 'full' && hasHistory && (
        <>
          <Divider />
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
              <span style={{ fontFamily: fonts.body, fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
                20 min trend
              </span>
              <div style={{ display: 'flex', gap: 10 }}>
                <span style={{ fontFamily: fonts.body, fontSize: 10, color: '#f97316' }}>— track temp</span>
                <span style={{ fontFamily: fonts.body, fontSize: 10, color: '#60a5fa' }}>— rain</span>
              </div>
            </div>
            <WeatherTrendChart history={weatherHistory} toDisplayTemp={toDisplayTemp} />
          </div>
        </>
      )}
    </div>
  )
}
