import { useState, useEffect, useCallback } from 'react'
import { colors, fonts } from '../../../styles/theme'
import { engineerService } from '../audio/AudioEngineerService'
import type { EngineerMessage, VoiceStatus } from '../types'
import { VOICES } from '../constants'

interface Props {
  voices: VoiceStatus[]
  onInstalled: (voiceId: string) => void
  onSkip: () => void
}

export default function WizardStepVoice({ voices, onInstalled, onSkip }: Props) {
  const handler = useCallback((msg: EngineerMessage) => {
    if (
      msg.type === 'EngineerInstallComplete' &&
      msg.target === 'voice' &&
      msg.success &&
      msg.target_id
    ) {
      onInstalled(msg.target_id)
    }
  }, [onInstalled])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  return (
    <div style={{ maxWidth: 700, width: '100%' }}>
      <h2 style={{ fontFamily: fonts.heading, fontSize: 32, color: colors.primary, margin: '0 0 8px', fontWeight: 700 }}>
        Choose your engineer
      </h2>
      <p style={{ fontFamily: fonts.body, fontSize: 15, color: colors.text, margin: '0 0 24px' }}>
        Preview each voice, then install one to get started. You can add more later.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        {VOICES.map((v) => {
          const installed = voices.find((s) => s.voice_id === v.id)?.installed ?? false
          return <WizardVoiceCard key={v.id} voice={v} installed={installed} />
        })}
      </div>

      <button
        onClick={onSkip}
        style={{
          background: 'none', border: 'none',
          color: colors.textMuted, fontFamily: fonts.body, fontSize: 13,
          cursor: 'pointer', padding: '4px 0',
        }}
      >
        Skip
      </button>
    </div>
  )
}

function WizardVoiceCard({ voice, installed }: {
  voice: typeof VOICES[number]
  installed: boolean
}) {
  const [progress, setProgress] = useState<number | null>(null)
  const [stage, setStage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handler = useCallback((msg: EngineerMessage) => {
    if (msg.type === 'EngineerInstallProgress' && msg.target === 'voice' && msg.target_id === voice.id) {
      setProgress(msg.bytes_total > 0 ? msg.bytes_downloaded / msg.bytes_total : 0)
      setStage(msg.stage)
    }
    if (
      msg.type === 'EngineerInstallComplete' &&
      msg.target === 'voice' &&
      msg.target_id === voice.id &&
      !msg.success
    ) {
      setProgress(null)
      setError(msg.error ?? 'Install failed')
    }
  }, [voice.id])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  const handleInstall = () => {
    setError(null)
    setProgress(0)
    engineerService.send({ command: 'engineer_install_voice', voice_id: voice.id })
  }

  const handlePreview = () => {
    new Audio(voice.sampleFile).play().catch(() => { /* user gesture may be needed */ })
  }

  const stageLabel: Record<string, string> = {
    downloading: 'Downloading…',
    extracting: 'Extracting…',
    validating: 'Validating…',
  }

  return (
    <div style={{
      background: colors.bgWidget,
      border: `1px solid ${installed ? colors.success : colors.border}`,
      borderRadius: 6, padding: '14px 16px',
      flex: '1 1 180px', minWidth: 180,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div>
        <div style={{ fontFamily: fonts.heading, fontSize: 20, color: colors.text, fontWeight: 700 }}>
          {voice.displayName}
        </div>
        <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted }}>{voice.description}</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted }}>~{voice.approxSizeMB} MB</div>
      </div>

      {progress !== null && (
        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginBottom: 3 }}>
            {stageLabel[stage] ?? stage}
          </div>
          <div style={{ background: colors.border, borderRadius: 2, height: 4, overflow: 'hidden' }}>
            <div style={{
              background: colors.primary, height: '100%',
              width: `${Math.round(progress * 100)}%`, transition: 'width 0.2s',
            }} />
          </div>
        </div>
      )}

      {error && <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.danger }}>{error}</div>}
      {installed && <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.success }}>Installed ✓</div>}

      <div style={{ display: 'flex', gap: 6, marginTop: 'auto', flexWrap: 'wrap' }}>
        <CardBtn onClick={handlePreview}>Preview</CardBtn>
        {!installed && progress === null && (
          <CardBtn onClick={handleInstall} primary>{error ? 'Retry' : 'Install'}</CardBtn>
        )}
      </div>
    </div>
  )
}

function CardBtn({ onClick, children, primary }: {
  onClick: () => void
  children: React.ReactNode
  primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: primary ? `${colors.primary}22` : colors.bgCard,
        border: `1px solid ${primary ? colors.primary : colors.border}`,
        color: primary ? colors.primary : colors.text,
        fontFamily: fonts.body, fontSize: 12,
        padding: '4px 10px', borderRadius: 3, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
