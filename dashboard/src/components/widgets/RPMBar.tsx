import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

export default function RPMBar() {
  const rpm = useTelemetryStore((s) => s.telemetry.rpm)
  const maxRpm = useTelemetryStore((s) => s.telemetry.max_rpm)
  const rpmPct = useTelemetryStore((s) => s.telemetry.rpm_pct)

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 8,
      padding: '4px 0',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: fonts.heading, fontSize: 22, color: colors.text, letterSpacing: 1 }}>
          {Math.round(rpm).toLocaleString()}
        </span>
        <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted }}>
          / {Math.round(maxRpm).toLocaleString()} RPM
        </span>
      </div>

      {/* Bar track */}
      <div style={{
        width: '100%',
        height: 12,
        background: '#111',
        borderRadius: 2,
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Filled portion */}
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.min(rpmPct * 100, 100)}%`,
          background: `linear-gradient(to right, ${colors.success}, ${colors.primary} 65%, ${colors.accent} 85%, ${colors.danger})`,
          backgroundSize: '100% 100%',
          backgroundClip: `inset(0 ${(1 - Math.min(rpmPct, 1)) * 100}% 0 0)`,
          WebkitBackgroundClip: `inset(0 ${(1 - Math.min(rpmPct, 1)) * 100}% 0 0)`,
          transition: 'width 0.05s linear',
        }} />
        {/* Shift light overlay */}
        {rpmPct > 0.95 && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: colors.danger,
            opacity: 0.3,
            animation: 'rpm-blink 0.15s step-end infinite',
          }} />
        )}
      </div>

      {/* Segment markers */}
      <div style={{ position: 'relative', height: 4 }}>
        {[0.25, 0.5, 0.75, 0.85, 0.95].map((mark) => (
          <div key={mark} style={{
            position: 'absolute',
            left: `${mark * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: '#333',
          }} />
        ))}
      </div>

      <div style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, textAlign: 'center', letterSpacing: 1 }}>
        RPM
      </div>
    </div>
  )
}
