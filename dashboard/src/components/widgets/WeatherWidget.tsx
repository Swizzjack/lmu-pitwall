import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

function tempColor(temp: number, isTrack: boolean): string {
  const cold = isTrack ? 20 : 12
  const hot = isTrack ? 50 : 35
  if (temp <= cold) return '#60a5fa'      // blue — cold
  if (temp >= hot) return colors.accent   // orange — hot
  return colors.success                   // green — comfortable
}

function SunIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
      <circle cx="19" cy="19" r="7" fill="#facc15" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
        const r = (deg * Math.PI) / 180
        const x1 = 19 + 10 * Math.cos(r)
        const y1 = 19 + 10 * Math.sin(r)
        const x2 = 19 + 13 * Math.cos(r)
        const y2 = 19 + 13 * Math.sin(r)
        return (
          <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="#facc15" strokeWidth="2" strokeLinecap="round" />
        )
      })}
    </svg>
  )
}

function CloudRainIcon({ light }: { light?: boolean }) {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
      {!light && <circle cx="28" cy="10" r="5" fill="#facc15" opacity="0.6" />}
      <ellipse cx="21" cy="16" rx="10" ry="7" fill="#6b7280" />
      <ellipse cx="12" cy="18" rx="7" ry="5" fill="#9ca3af" />
      <line x1="11" y1="26" x2="9" y2="34" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
      <line x1="18" y1="26" x2="16" y2="34" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
      {!light && (
        <>
          <line x1="25" y1="26" x2="23" y2="34" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
          <line x1="32" y1="26" x2="30" y2="34" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

function WeatherIcon({ rainIntensity }: { rainIntensity: number }) {
  if (rainIntensity > 0.5) return <CloudRainIcon />
  if (rainIntensity > 0.1) return <CloudRainIcon light />
  return <SunIcon />
}

function RainBar({ value }: { value: number }) {
  const color = value > 0.5 ? '#60a5fa' : value > 0.1 ? '#93c5fd' : colors.textMuted
  return (
    <div style={{
      width: '100%',
      height: 4,
      background: '#222',
      borderRadius: 2,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${value * 100}%`,
        height: '100%',
        background: color,
        borderRadius: 2,
        transition: 'width 0.5s, background 0.5s',
      }} />
    </div>
  )
}

export default function WeatherWidget() {
  const weather = useTelemetryStore((s) => s.session.weather)
  const toDisplayTemp = useSettingsStore((s) => s.toDisplayTemp)
  const tempUnitLabel = useSettingsStore((s) => s.tempUnitLabel)

  const airTempC = weather?.air_temp ?? 20
  const trackTempC = weather?.track_temp ?? 25
  const rainIntensity = weather?.rain_intensity ?? 0

  const airTemp = toDisplayTemp(airTempC)
  const trackTemp = toDisplayTemp(trackTempC)
  const tempLabel = tempUnitLabel()

  const rainColor = rainIntensity > 0.3 ? '#60a5fa' : colors.textMuted

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '10px 12px',
      gap: 6,
      boxSizing: 'border-box',
    }}>
      {/* Icon row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <WeatherIcon rainIntensity={rainIntensity} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
              Rain
            </span>
            <span style={{ fontFamily: fonts.heading, fontSize: 22, color: rainColor, lineHeight: 1 }}>
              {(rainIntensity * 100).toFixed(0)}%
            </span>
          </div>
          <RainBar value={rainIntensity} />
        </div>
      </div>

      {/* Temperature rows */}
      <div style={{
        marginTop: 'auto',
        borderTop: `1px solid ${colors.border}`,
        paddingTop: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {/* Air temp */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
            Air
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: tempColor(airTempC, false),
              display: 'inline-block',
            }} />
            <span style={{ fontFamily: fonts.mono, fontSize: 15, color: tempColor(airTempC, false), fontWeight: 600 }}>
              {airTemp.toFixed(1)}{tempLabel}
            </span>
          </div>
        </div>

        {/* Track temp */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>
            Track
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: tempColor(trackTempC, true),
              display: 'inline-block',
            }} />
            <span style={{ fontFamily: fonts.mono, fontSize: 15, color: tempColor(trackTempC, true), fontWeight: 600 }}>
              {trackTemp.toFixed(1)}{tempLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
