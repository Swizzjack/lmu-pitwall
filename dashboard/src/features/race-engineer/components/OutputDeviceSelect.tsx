import { useState, useEffect } from 'react'
import { colors, fonts } from '../../../styles/theme'

interface Props {
  value: string | null
  onChange: (deviceId: string | null) => void
}

interface AudioDevice {
  deviceId: string
  label: string
}

export default function OutputDeviceSelect({ value, onChange }: Props) {
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [permissionState, setPermissionState] = useState<'idle' | 'pending' | 'denied'>('idle')

  useEffect(() => {
    if (!navigator.mediaDevices) return
    // Check if we already have labelled devices (permission previously granted)
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const outputs = devs
        .filter((d) => d.kind === 'audiooutput' && d.deviceId !== '')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId }))
      if (outputs.some((d) => d.label && d.label !== d.deviceId)) {
        setDevices(outputs)
      }
    }).catch(() => {})
  }, [])

  const requestPermissionAndEnumerate = async () => {
    setPermissionState('pending')
    setShowDialog(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop()) // Permission acquired, stop immediately

      const devs = await navigator.mediaDevices.enumerateDevices()
      const outputs = devs
        .filter((d) => d.kind === 'audiooutput' && d.deviceId !== '')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId }))
      setDevices(outputs)
      setPermissionState('idle')
    } catch {
      setPermissionState('denied')
    }
  }

  const selectedLabel =
    devices.find((d) => d.deviceId === value)?.label ?? 'System default'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, width: 56, flexShrink: 0 }}>
          OUTPUT
        </span>
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          style={{
            background: colors.bgWidget,
            border: `1px solid ${colors.border}`,
            color: colors.text,
            fontFamily: fonts.body,
            fontSize: 14,
            padding: '4px 8px',
            borderRadius: 3,
            cursor: 'pointer',
            flex: 1,
          }}
        >
          <option value="">System default</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>

      {devices.length === 0 && (
        <div style={{ paddingLeft: 68 }}>
          {permissionState === 'denied' ? (
            <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted }}>
              Permission denied — using system default.
            </span>
          ) : (
            <button
              onClick={() => setShowDialog(true)}
              style={{
                background: 'none',
                border: 'none',
                color: colors.info,
                fontFamily: fonts.body,
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              Show all devices (requires permission)
            </button>
          )}
        </div>
      )}

      {value && (
        <div style={{ paddingLeft: 68 }}>
          <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted }}>
            Active: {selectedLabel}
          </span>
        </div>
      )}

      {showDialog && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: colors.bgCard, border: `1px solid ${colors.border}`,
            borderRadius: 6, padding: 24, maxWidth: 400, width: '90%',
          }}>
            <p style={{ margin: '0 0 12px', fontFamily: fonts.body, fontSize: 14, color: colors.text, lineHeight: 1.5 }}>
              To show device names, your browser needs microphone permission.
            </p>
            <p style={{ margin: '0 0 20px', fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, lineHeight: 1.5 }}>
              LMU Pitwall does NOT record or use your microphone — this is a browser requirement to reveal output device names. You can deny it and just use the system default.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowDialog(false)}
                style={{ background: colors.bgWidget, border: `1px solid ${colors.border}`, color: colors.textMuted, fontFamily: fonts.body, fontSize: 13, padding: '6px 14px', borderRadius: 3, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={requestPermissionAndEnumerate}
                style={{ background: `${colors.primary}22`, border: `1px solid ${colors.primary}`, color: colors.primary, fontFamily: fonts.body, fontSize: 13, padding: '6px 14px', borderRadius: 3, cursor: 'pointer' }}
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
