import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

export default function SpeedGauge() {
  const speedKmh = useTelemetryStore((s) => s.telemetry.speed_kmh)
  const toDisplaySpeed = useSettingsStore((s) => s.toDisplaySpeed)
  const speedUnitLabel = useSettingsStore((s) => s.speedUnitLabel)

  const displaySpeed = Math.round(toDisplaySpeed(speedKmh))

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        fontFamily: fonts.heading,
        fontSize: 'clamp(36px, 8vw, 96px)',
        fontWeight: 700,
        color: colors.text,
        lineHeight: 1,
        letterSpacing: -2,
      }}>
        {displaySpeed}
      </div>
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        letterSpacing: 3,
        marginTop: 4,
        textTransform: 'uppercase',
      }}>
        {speedUnitLabel()}
      </div>
    </div>
  )
}
