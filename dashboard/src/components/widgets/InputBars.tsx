import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

function VerticalBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(1, value))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
      <span style={{ fontFamily: fonts.mono, fontSize: 15, color }}>
        {(pct * 100).toFixed(0)}%
      </span>
      <div style={{
        width: '100%',
        flex: 1,
        background: '#111',
        borderRadius: 3,
        overflow: 'hidden',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: `${pct * 100}%`,
          background: color,
          opacity: 0.85,
          transition: 'height 0.05s linear',
        }} />
      </div>
      <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, letterSpacing: 1 }}>
        {label}
      </span>
    </div>
  )
}

export default function InputBars() {
  const throttle = useTelemetryStore((s) => s.telemetry.throttle)
  const brake = useTelemetryStore((s) => s.telemetry.brake)
  const clutch = useTelemetryStore((s) => s.telemetry.clutch)
  const steering = useTelemetryStore((s) => s.telemetry.steering)

  const steerPct = (steering + 1) / 2  // map -1..1 to 0..1

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '4px 0',
    }}>
      {/* Bars */}
      <div style={{ display: 'flex', gap: 8, flex: 1 }}>
        <VerticalBar label="THR" value={throttle} color={colors.success} />
        <VerticalBar label="BRK" value={brake} color={colors.danger} />
        <VerticalBar label="CLT" value={clutch} color={colors.info} />
      </div>

      {/* Steering bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted }}>STEER</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.text }}>
            {(steering * 100).toFixed(0)}%
          </span>
        </div>
        <div style={{ height: 8, background: '#111', borderRadius: 2, position: 'relative', overflow: 'hidden' }}>
          {/* Center marker */}
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#333' }} />
          {/* Steer indicator */}
          <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: steering <= 0 ? `${steerPct * 100}%` : '50%',
            width: `${Math.abs(steering) * 50}%`,
            background: colors.primary,
            opacity: 0.8,
            transition: 'left 0.05s linear, width 0.05s linear',
          }} />
        </div>
      </div>
    </div>
  )
}
