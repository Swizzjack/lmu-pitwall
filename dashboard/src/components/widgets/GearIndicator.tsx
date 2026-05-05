import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

export default function GearIndicator() {
  const gear = useTelemetryStore((s) => s.telemetry.gear)
  const label = useTelemetryStore((s) => s.telemetry.gear_label)

  const gearColor =
    gear === -1 ? colors.danger
    : gear === 0 ? colors.primary
    : colors.text

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
        fontSize: 'clamp(48px, 10vw, 120px)',
        fontWeight: 700,
        color: gearColor,
        lineHeight: 1,
        textShadow: gear > 0 ? 'none' : `0 0 24px ${gearColor}55`,
        transition: 'color 0.1s',
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        letterSpacing: 2,
        marginTop: 4,
        textTransform: 'uppercase',
      }}>
        Gear
      </div>
    </div>
  )
}
