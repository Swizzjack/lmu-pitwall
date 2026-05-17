import { Sun, CloudSun, Cloud, CloudRain, CloudLightning, CloudFog, CloudDrizzle } from 'lucide-react'
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

function resolveWeatherIcon(rainValue: number, skyType?: number): WeatherIconDef {
  if (skyType !== undefined && skyType >= 0 && skyType <= 10) {
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
  // Fallback: derive from rain intensity when sky_type is absent or out of range
  if (rainValue > 0.6)  return { Icon: CloudLightning, color: '#f97316' }
  if (rainValue > 0.25) return { Icon: CloudRain,      color: '#60a5fa' }
  if (rainValue > 0.05) return { Icon: Cloud,          color: '#9ca3af' }
  if (rainValue > 0.01) return { Icon: CloudSun,       color: '#94a3b8' }
  return                       { Icon: Sun,             color: '#facc15' }
}

// ---------------------------------------------------------------------------
// Trend computation from history
// ---------------------------------------------------------------------------

type Trend = 'drying' | 'stable' | 'wetting'

interface TrendResult {
  track: Trend
  rain: Trend
  dominant: Trend
}

function computeTrend(history: WeatherSnapshot[]): TrendResult {
  const COMPARE_WINDOW = 6   // compare last entry vs ~3 min ago (6 × 30s)
  const stable: TrendResult = { track: 'stable', rain: 'stable', dominant: 'stable' }

  if (history.length < 3) return stable

  const recent = history[history.length - 1]
  const old    = history[Math.max(0, history.length - COMPARE_WINDOW)]

  const trackDelta = recent.track_temp - old.track_temp
  const rainDelta  = recent.rain_intensity - old.rain_intensity

  const track: Trend = trackDelta > 0.8 ? 'drying' : trackDelta < -0.8 ? 'wetting' : 'stable'
  const rain:  Trend = rainDelta  > 0.04 ? 'wetting' : rainDelta < -0.04 ? 'drying'  : 'stable'

  // Rain trend dominates track temp (rain is more critical for driver)
  const dominant: Trend = rain !== 'stable' ? rain : track !== 'stable' ? track : 'stable'

  return { track, rain, dominant }
}

const TREND_CONFIG: Record<Trend, { label: string; arrow: string; color: string }> = {
  drying:  { label: 'DRYING',  arrow: '↑', color: '#22c55e' },
  stable:  { label: 'STABLE',  arrow: '→', color: '#6b7280' },
  wetting: { label: 'WETTING', arrow: '↓', color: '#60a5fa' },
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
  const H = 28
  const PAD = 2

  function buildPath(values: number[]): string {
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1
    return values.map((v, i) => {
      const x = PAD + (i / (values.length - 1)) * (W - PAD * 2)
      const y = PAD + (1 - (v - min) / range) * (H - PAD * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  const trackVals = history.map(s => toDisplayTemp(s.track_temp))
  const rainVals  = history.map(s => s.rain_intensity)

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', height: H }}>
      {/* Rain (blue, filled area) */}
      <path
        d={buildPath(rainVals) + ` L${W - PAD},${H} L${PAD},${H} Z`}
        fill="#60a5fa18" stroke="none"
      />
      <path d={buildPath(rainVals)} fill="none" stroke="#60a5fa" strokeWidth="1.2" strokeLinejoin="round" />
      {/* Track temp (orange line) */}
      <path d={buildPath(trackVals)} fill="none" stroke="#f97316" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
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

  const airTempC      = weather?.air_temp      ?? 20
  const trackTempC    = weather?.track_temp    ?? 25
  const rainIntensity = weather?.rain_intensity ?? 0
  const darkCloud     = weather?.dark_cloud    ?? 0
  const forecast      = weather?.forecast      ?? []

  const airTemp   = toDisplayTemp(airTempC)
  const trackTemp = toDisplayTemp(trackTempC)
  const tempLabel = tempUnitLabel()

  const { Icon: CurrentIcon, color: iconColor } = resolveWeatherIcon(rainIntensity)
  const trend      = computeTrend(weatherHistory)
  const trendCfg   = TREND_CONFIG[trend.dominant]
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

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Rain bar + % */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
              Rain
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 20, color: rainIntensity > 0.3 ? '#60a5fa' : colors.textMuted, lineHeight: 1, fontWeight: 700 }}>
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

        {/* Trend badge — large, readable at a glance */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
          background: `${trendCfg.color}18`,
          border: `1px solid ${trendCfg.color}55`,
          borderRadius: 6, padding: '4px 8px', minWidth: 58, flexShrink: 0,
        }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: trendCfg.color, lineHeight: 1, fontWeight: 700 }}>
            {trendCfg.arrow}
          </span>
          <span style={{ fontFamily: fonts.body, fontSize: 9, color: trendCfg.color, letterSpacing: 1, textTransform: 'uppercase' }}>
            {trendCfg.label}
          </span>
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
        {/* Cloud */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Cloud</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: darkCloud > 0.6 ? '#9ca3af' : '#facc15', fontWeight: 700, lineHeight: 1 }}>
            {(darkCloud * 100).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span>
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
