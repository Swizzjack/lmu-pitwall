import { useCallback, useEffect, useState } from 'react'
import { useLayoutStore, LAYOUT_PRESETS } from '../stores/layoutStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSettingsStore } from '../stores/settingsStore'
import { WIDGET_REGISTRY } from './widgetRegistry'
import { colors, fonts } from '../styles/theme'

function NetworkBadge() {
  const { wsHost, wsPort } = useSettingsStore()
  const [address, setAddress] = useState<string | null>(null)

  useEffect(() => {
    const host = wsHost.trim() || window.location.hostname
    fetch(`http://${host}:${wsPort}/api/network-info`)
      .then((r) => r.json())
      .then((data: { ip: string; port: number }) => setAddress(`${data.ip}:${data.port}`))
      .catch(() => {})
  }, [wsHost, wsPort])

  if (!address) return null

  return (
    <span
      title="Tablet-Adresse: Diese IP im Browser des Tablets eingeben"
      style={{
        fontFamily: fonts.body,
        fontSize: 13,
        color: colors.textMuted,
        letterSpacing: 0.3,
        userSelect: 'text',
        cursor: 'text',
        whiteSpace: 'nowrap',
      }}
    >
      {address}
    </span>
  )
}

function UpdateBadge() {
  const versionInfo = useTelemetryStore((s) => s.versionInfo)
  if (!versionInfo?.update_available) return null

  return (
    <a
      href={versionInfo.download_url}
      target="_blank"
      rel="noreferrer"
      title={`Update available: v${versionInfo.latest_version}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        background: `${colors.accent}22`,
        border: `1px solid ${colors.accent}`,
        borderRadius: 3,
        color: colors.accent,
        fontFamily: fonts.body,
        fontSize: 14,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      ↑ v{versionInfo.latest_version}
    </a>
  )
}

function ConnectionBadge() {
  const status = useTelemetryStore((s) => s.connection.status)
  const gameConnected = useTelemetryStore((s) => s.connection.game_connected)

  const dotColor =
    status === 'connected' ? colors.success
    : status === 'reconnecting' ? colors.accent
    : colors.danger

  const label =
    status === 'connected' && gameConnected ? 'Live'
    : status === 'connected' ? 'Bridge'
    : status === 'reconnecting' ? '…'
    : 'Off'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor, boxShadow: `0 0 5px ${dotColor}` }} />
      <span style={{ fontFamily: fonts.body, fontSize: 18, color: dotColor }}>{label}</span>
    </div>
  )
}

export default function Toolbar({ onOpenSettings, onOpenResults, onOpenFuel, onOpenEngineer, resultsOpen, fuelOpen, engineerOpen }: {
  onOpenSettings: () => void
  onOpenResults: () => void
  onOpenFuel: () => void
  onOpenEngineer: () => void
  resultsOpen: boolean
  fuelOpen: boolean
  engineerOpen: boolean
}) {
  const { activePreset, locked, setPreset, resetToDefault, toggleLock, addWidget } = useLayoutStore()
  const fullscreen = useSettingsStore((s) => s.fullscreen)

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '7px 14px',
      background: colors.bgCard,
      borderBottom: `1px solid ${colors.border}`,
      flexShrink: 0,
      minHeight: 52,
    }}>
      {/* Title */}
      <span style={{
        fontFamily: fonts.heading,
        fontSize: 30,
        fontWeight: 700,
        color: colors.primary,
        letterSpacing: 2,
        lineHeight: 1,
        marginRight: 8,
      }}>
        LMU
      </span>

      <ConnectionBadge />

      <div style={{ width: 1, height: 27, background: colors.border, margin: '0 4px' }} />

      {/* Preset selector */}
      <select
        value={activePreset}
        onChange={(e) => setPreset(e.target.value)}
        style={{
          background: colors.bgWidget,
          border: `1px solid ${colors.border}`,
          color: colors.text,
          fontFamily: fonts.body,
          fontSize: 18,
          padding: '4px 8px',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        {Object.keys(LAYOUT_PRESETS).map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>

      {/* Reset */}
      <ToolbarBtn onClick={resetToDefault} title="Reset layout">↺</ToolbarBtn>

      <div style={{ width: 1, height: 27, background: colors.border, margin: '0 4px' }} />

      {/* Add Widget */}
      {!locked && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) addWidget(e.target.value) }}
          style={{
            background: colors.bgWidget,
            border: `1px solid ${colors.border}`,
            color: colors.textMuted,
            fontFamily: fonts.body,
            fontSize: 18,
            padding: '4px 8px',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          <option value="" disabled>+ Add widget</option>
          {Object.values(WIDGET_REGISTRY).map((meta) => (
            <option key={meta.id} value={meta.id}>{meta.name}</option>
          ))}
        </select>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Race Engineer */}
      <ToolbarBtn onClick={onOpenEngineer} title="Race Engineer" active={engineerOpen}>🎙</ToolbarBtn>

      {/* Fuel Calculator */}
      <ToolbarBtn onClick={onOpenFuel} title="Fuel Calculator" active={fuelOpen}>⛽</ToolbarBtn>

      {/* Post Race Results */}
      <ToolbarBtn onClick={onOpenResults} title="Post Race Results" active={resultsOpen}>📋</ToolbarBtn>

      {/* Lock */}
      <ToolbarBtn
        onClick={toggleLock}
        title={locked ? 'Unlock layout' : 'Lock layout'}
        active={locked}
      >
        {locked ? '🔒' : '🔓'}
      </ToolbarBtn>

      {/* Fullscreen */}
      <ToolbarBtn onClick={toggleFullscreen} title="Toggle fullscreen (F11)" active={fullscreen}>⛶</ToolbarBtn>

      {/* Settings */}
      <ToolbarBtn onClick={onOpenSettings} title="Settings">⚙</ToolbarBtn>

      <div style={{ width: 1, height: 27, background: colors.border, margin: '0 2px' }} />

      {/* Network address for tablet users */}
      <NetworkBadge />

      <div style={{ width: 1, height: 27, background: colors.border, margin: '0 2px' }} />

      {/* Version + update badge */}
      <span style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        letterSpacing: 0.5,
        userSelect: 'none',
      }}>
        v{__APP_VERSION__}
      </span>
      <UpdateBadge />
    </div>
  )
}

function ToolbarBtn({
  onClick,
  children,
  title,
  active,
}: {
  onClick: () => void
  children: React.ReactNode
  title?: string
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: active ? `${colors.primary}22` : colors.bgWidget,
        border: `1px solid ${active ? colors.primary : colors.border}`,
        color: active ? colors.primary : colors.textMuted,
        fontFamily: fonts.body,
        fontSize: 20,
        padding: '4px 10px',
        borderRadius: 3,
        cursor: 'pointer',
        lineHeight: 1.2,
      }}
    >
      {children}
    </button>
  )
}
