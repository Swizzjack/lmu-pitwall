import { useEffect, useState } from 'react'
import { useElectronicsConfigStore } from '../stores/electronicsConfigStore'
import { colors, fonts } from '../styles/theme'

const CAPTURE_TIMEOUT_MS = 10_000

interface Props {
  label: string
  onClose: () => void
}

export default function BindingDialog({ label, onClose }: Props) {
  const { capturing, captureStartedAt, cancelCapture } = useElectronicsConfigStore()
  const [elapsed, setElapsed] = useState(0)

  // Close automatically when capture completes (capturing becomes null)
  useEffect(() => {
    if (capturing === null) {
      onClose()
    }
  }, [capturing, onClose])

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => {
      const start = captureStartedAt ?? Date.now()
      setElapsed(Date.now() - start)
    }, 100)
    return () => clearInterval(id)
  }, [captureStartedAt])

  const remaining = Math.max(0, CAPTURE_TIMEOUT_MS - elapsed)
  const progress = remaining / CAPTURE_TIMEOUT_MS  // 1 → 0

  function handleCancel() {
    cancelCapture()
    onClose()
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleCancel}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.8)',
          zIndex: 200,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Dialog */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: '#1a1a1a',
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            padding: '32px 40px',
            width: 340,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
          }}
        >
          <div style={{
            fontFamily: fonts.heading,
            fontSize: 12,
            letterSpacing: 2,
            color: colors.textMuted,
            textTransform: 'uppercase',
          }}>
            Assigning:
          </div>

          <div style={{
            fontFamily: fonts.heading,
            fontSize: 18,
            fontWeight: 700,
            color: colors.primary,
            letterSpacing: 1,
          }}>
            {label}
          </div>

          <div style={{
            fontFamily: fonts.body,
            fontSize: 13,
            color: colors.text,
            textAlign: 'center',
            lineHeight: 1.6,
          }}>
            Press the desired button on the steering wheel or key on the keyboard now…
          </div>

          {/* Countdown bar */}
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              width: '100%',
              height: 6,
              background: '#2a2a2a',
              borderRadius: 3,
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${progress * 100}%`,
                height: '100%',
                background: `linear-gradient(90deg, ${colors.primary}, ${colors.primary}aa)`,
                borderRadius: 3,
                transition: 'width 0.1s linear',
              }} />
            </div>
            <div style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.textMuted,
              textAlign: 'right',
            }}>
              {(remaining / 1000).toFixed(1)}s
            </div>
          </div>

          <button
            onClick={handleCancel}
            style={{
              fontFamily: fonts.body,
              fontSize: 12,
              padding: '6px 20px',
              background: '#1a1a1a',
              border: `1px solid ${colors.border}`,
              color: colors.textMuted,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}
