import { useState, useEffect, useCallback } from 'react'
import { colors, fonts } from '../../../styles/theme'
import { engineerService } from '../audio/AudioEngineerService'
import type { EngineerMessage } from '../types'

interface Props {
  onInstalled: () => void
  onSkip: () => void
}

export default function WizardStepPiper({ onInstalled, onSkip }: Props) {
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handler = useCallback((msg: EngineerMessage) => {
    if (msg.type === 'EngineerInstallProgress' && msg.target === 'piper') {
      setProgress(msg.bytes_total > 0 ? msg.bytes_downloaded / msg.bytes_total : 0)
      setStage(msg.stage)
    }
    if (msg.type === 'EngineerInstallComplete' && msg.target === 'piper') {
      if (msg.success) {
        onInstalled()
      } else {
        setInstalling(false)
        setError(msg.error ?? 'Installation failed.')
      }
    }
  }, [onInstalled])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  const handleInstall = () => {
    setError(null)
    setInstalling(true)
    setProgress(0)
    engineerService.send({ command: 'engineer_install_piper' })
  }

  const stageLabel: Record<string, string> = {
    downloading: 'Downloading...',
    extracting: 'Extracting...',
    validating: 'Validating...',
  }

  return (
    <div style={{ maxWidth: 480, width: '100%' }}>
      <h2 style={{ fontFamily: fonts.heading, fontSize: 32, color: colors.primary, margin: '0 0 8px', fontWeight: 700 }}>
        Set up your Race Engineer
      </h2>
      <p style={{ fontFamily: fonts.body, fontSize: 16, color: colors.text, margin: '0 0 6px' }}>
        First, we need to install the speech engine (Piper TTS, ~25 MB)
      </p>
      <p style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, margin: '0 0 28px', lineHeight: 1.5 }}>
        This is a one-time setup. Piper runs locally on your PC — no data is sent to any server.
      </p>

      {error && (
        <div style={{
          background: `${colors.danger}18`, border: `1px solid ${colors.danger}`,
          borderRadius: 4, padding: '10px 14px', marginBottom: 16,
          fontFamily: fonts.body, fontSize: 13, color: colors.danger,
        }}>
          {error}
        </div>
      )}

      {installing && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginBottom: 6 }}>
            {stageLabel[stage] ?? stage}
          </div>
          <div style={{ background: colors.border, borderRadius: 3, height: 6, overflow: 'hidden' }}>
            <div style={{
              background: colors.primary, height: '100%',
              width: `${Math.round(progress * 100)}%`,
              transition: 'width 0.3s',
            }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          onClick={installing ? undefined : handleInstall}
          disabled={installing}
          style={{
            background: installing ? `${colors.primary}44` : `${colors.primary}22`,
            border: `1px solid ${colors.primary}`,
            color: installing ? colors.textMuted : colors.primary,
            fontFamily: fonts.body, fontSize: 16,
            padding: '10px 24px', borderRadius: 4,
            cursor: installing ? 'not-allowed' : 'pointer',
          }}
        >
          {installing ? 'Installing…' : error ? 'Retry' : 'Install Piper'}
        </button>

        <button
          onClick={onSkip}
          style={{
            background: 'none', border: 'none',
            color: colors.textMuted, fontFamily: fonts.body, fontSize: 13,
            cursor: 'pointer', padding: '4px 0', textAlign: 'left',
          }}
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}
