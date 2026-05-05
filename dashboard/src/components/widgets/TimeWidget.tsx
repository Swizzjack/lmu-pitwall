import { useState, useEffect } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatClock(date: Date, format: '12h' | '24h'): string {
  const h24 = date.getHours()
  const min = date.getMinutes().toString().padStart(2, '0')
  const sec = date.getSeconds().toString().padStart(2, '0')
  if (format === '24h') return `${h24.toString().padStart(2, '0')}:${min}:${sec}`
  const h12 = h24 % 12 || 12
  const ampm = h24 < 12 ? 'AM' : 'PM'
  return `${h12}:${min}:${sec} ${ampm}`
}

function TimeRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingBottom: 6,
      borderBottom: `1px solid ${colors.border}`,
    }}>
      <span style={{
        fontFamily: fonts.body,
        fontSize: 14,
        color: colors.textMuted,
        letterSpacing: 1.5,
        textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 18,
        color: colors.text,
      }}>
        {value}
      </span>
    </div>
  )
}

export default function TimeWidget() {
  const [now, setNow] = useState(() => new Date())

  const currentEt = useTelemetryStore((s) => s.telemetry.current_et)
  const lapStartEt = useTelemetryStore((s) => s.telemetry.lap_start_et)
  const sessionTime = useTelemetryStore((s) => s.scoring.session_time)
  const sessionMinutes = useTelemetryStore((s) => s.session.session_minutes)

  const showComputerTime = useSettingsStore((s) => s.timeWidgetShowComputerTime)
  const clockFormat = useSettingsStore((s) => s.timeWidgetClockFormat)
  const showSessionElapsed = useSettingsStore((s) => s.timeWidgetShowSessionElapsed)
  const showTimeRemaining = useSettingsStore((s) => s.timeWidgetShowTimeRemaining)
  const showCurrentLap = useSettingsStore((s) => s.timeWidgetShowCurrentLap)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const currentLapTime = currentEt > 0 && lapStartEt >= 0 ? currentEt - lapStartEt : -1

  let remainingDisplay = '—'
  if (sessionMinutes > 0) {
    const remaining = Math.max(0, sessionMinutes * 60 - sessionTime)
    remainingDisplay = formatDuration(remaining)
  }

  const rows: Array<{ label: string; value: string }> = []
  if (showComputerTime) rows.push({ label: 'Computer', value: formatClock(now, clockFormat) })
  if (showSessionElapsed) rows.push({ label: 'Session', value: sessionTime > 0 ? formatDuration(sessionTime) : '—' })
  if (showTimeRemaining) rows.push({ label: 'Remaining', value: remainingDisplay })
  if (showCurrentLap) rows.push({ label: 'Lap Time', value: currentLapTime >= 0 ? formatDuration(currentLapTime) : '—' })

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '10px 12px',
      gap: 8,
      boxSizing: 'border-box',
    }}>
      {rows.length === 0 ? (
        <span style={{
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.textMuted,
          margin: 'auto',
        }}>
          No items enabled
        </span>
      ) : (
        rows.map((r) => <TimeRow key={r.label} label={r.label} value={r.value} />)
      )}
    </div>
  )
}
