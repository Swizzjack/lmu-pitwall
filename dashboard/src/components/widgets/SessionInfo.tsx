import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function sessionTypeLabel(raw: string): string {
  const t = raw.toLowerCase()
  if (t.includes('race')) return 'RACE'
  if (t.includes('qual')) return 'QUALIFYING'
  if (t.includes('warm')) return 'WARMUP'
  if (t.includes('prac')) return 'PRACTICE'
  if (raw.length > 0) return raw.toUpperCase()
  return '—'
}

function sessionTypeColor(raw: string): string {
  const t = raw.toLowerCase()
  if (t.includes('race')) return colors.danger
  if (t.includes('qual')) return colors.primary
  if (t.includes('warm')) return colors.accent
  return colors.info
}

export default function SessionInfo() {
  const sessionType = useTelemetryStore((s) => s.scoring.session_type)
  const sessionTime = useTelemetryStore((s) => s.scoring.session_time)
  const trackName = useTelemetryStore((s) => s.session.track_name)
  const sessionMinutes = useTelemetryStore((s) => s.session.session_minutes)

  const label = sessionTypeLabel(sessionType)
  const typeColor = sessionTypeColor(sessionType)

  let remainingDisplay = '—'
  if (sessionMinutes > 0) {
    const totalSec = sessionMinutes * 60
    const remaining = Math.max(0, totalSec - sessionTime)
    remainingDisplay = formatTime(remaining)
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '10px 12px',
      gap: 4,
      boxSizing: 'border-box',
    }}>
      {/* Session type badge */}
      <div style={{
        fontFamily: fonts.heading,
        fontSize: 26,
        color: typeColor,
        lineHeight: 1,
        letterSpacing: 1,
      }}>
        {label}
      </div>

      {/* Track name */}
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.text,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {trackName || 'No Track'}
      </div>

      {/* Remaining time */}
      <div style={{
        marginTop: 'auto',
        borderTop: `1px solid ${colors.border}`,
        paddingTop: 6,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.textMuted,
          letterSpacing: 2,
          textTransform: 'uppercase',
        }}>
          Remaining
        </span>
        <span style={{
          fontFamily: fonts.mono,
          fontSize: 15,
          color: colors.text,
        }}>
          {remainingDisplay}
        </span>
      </div>
    </div>
  )
}
