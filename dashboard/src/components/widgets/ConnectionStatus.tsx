import { useEffect, useRef, useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

interface RowProps {
  label: string
  value: string
  color: string
  dot?: boolean
}

function Row({ label, value, color, dot }: RowProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 1,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 15,
        color,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}>
        {dot && (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: color,
            display: 'inline-block',
            boxShadow: `0 0 4px ${color}`,
          }} />
        )}
        {value}
      </span>
    </div>
  )
}

export default function ConnectionStatus() {
  const status = useTelemetryStore((s) => s.connection.status)
  const gameConnected = useTelemetryStore((s) => s.connection.game_connected)
  const pluginVersion = useTelemetryStore((s) => s.connection.plugin_version)

  // Count telemetry messages to derive update rate
  const currentEt = useTelemetryStore((s) => s.telemetry.current_et)
  const msgCountRef = useRef(0)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    msgCountRef.current++
  }, [currentEt])

  useEffect(() => {
    const interval = setInterval(() => {
      setFps(msgCountRef.current)
      msgCountRef.current = 0
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const wsColor =
    status === 'connected' ? colors.success
    : status === 'reconnecting' ? colors.primary
    : colors.danger

  const wsLabel =
    status === 'connected' ? 'Connected'
    : status === 'reconnecting' ? 'Reconnecting…'
    : 'Disconnected'

  const gameColor = gameConnected ? colors.success : colors.textMuted
  const fpsColor = fps > 20 ? colors.success : fps > 5 ? colors.primary : colors.danger

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '8px 10px',
      gap: 6,
      boxSizing: 'border-box',
    }}>
      {/* Title */}
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 2,
        borderBottom: `1px solid ${colors.border}`,
        paddingBottom: 4,
        marginBottom: 2,
      }}>
        Connection
      </div>

      <Row label="Bridge" value={wsLabel} color={wsColor} dot />
      <Row label="Game" value={gameConnected ? 'Connected' : 'Waiting'} color={gameColor} dot />
      <Row label="Updates/s" value={`${fps}`} color={fpsColor} />

      {pluginVersion ? (
        <div style={{
          marginTop: 'auto',
          fontFamily: fonts.mono,
          fontSize: 13,
          color: colors.textMuted,
          borderTop: `1px solid ${colors.border}`,
          paddingTop: 4,
        }}>
          Plugin v{pluginVersion}
        </div>
      ) : null}
    </div>
  )
}
