import { useState, useEffect, useCallback, useRef } from 'react'
import { colors, fonts } from '../../../styles/theme'
import { engineerService } from '../audio/AudioEngineerService'
import type { EngineerMessage } from '../types'
import { RADIO_CHECK_PHRASE, LANGUAGE_FLAG } from '../constants'

interface VoiceDef {
  id: string
  displayName: string
  languageTag: string
  description: string
  approxSizeMB: number
  sampleFile: string
}

interface Props {
  voice: VoiceDef
  installed: boolean
  active: boolean
  onActivate: () => void
}

export default function VoiceCard({ voice, installed, active, onActivate }: Props) {
  const [installProgress, setInstallProgress] = useState<number | null>(null)
  const [installStage, setInstallStage] = useState<string>('')
  const [installError, setInstallError] = useState<string | null>(null)
  const [synthPending, setSynthPending] = useState(false)
  const requestIdRef = useRef<string | null>(null)

  const handler = useCallback((msg: EngineerMessage) => {
    if (msg.type === 'EngineerInstallProgress' && msg.target === 'voice' && msg.target_id === voice.id) {
      const pct = msg.bytes_total > 0 ? msg.bytes_downloaded / msg.bytes_total : 0
      setInstallProgress(pct)
      setInstallStage(msg.stage)
    }
    if (msg.type === 'EngineerInstallComplete' && msg.target === 'voice' && msg.target_id === voice.id) {
      setInstallProgress(null)
      if (!msg.success) setInstallError(msg.error ?? 'Install failed')
    }
    if (msg.type === 'EngineerAudio' && msg.request_id === requestIdRef.current) {
      setSynthPending(false)
    }
  }, [voice.id])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  const handleInstall = () => {
    setInstallError(null)
    setInstallProgress(0)
    engineerService.send({ command: 'engineer_install_voice', voice_id: voice.id })
  }

  const handleUninstall = () => {
    engineerService.send({ command: 'engineer_uninstall_voice', voice_id: voice.id })
  }

  const handlePreview = () => {
    new Audio(voice.sampleFile).play().catch(() => { /* user gesture may be needed */ })
  }

  const handleRadioCheck = () => {
    const id = crypto.randomUUID()
    requestIdRef.current = id
    setSynthPending(true)
    engineerService.send({
      command: 'engineer_synthesize',
      voice_id: voice.id,
      text: RADIO_CHECK_PHRASE,
      request_id: id,
    })
  }

  const stageLabel: Record<string, string> = {
    downloading: 'Downloading...',
    extracting: 'Extracting...',
    validating: 'Validating...',
  }

  return (
    <div style={{
      background: colors.bgWidget,
      border: `1px solid ${active ? colors.primary : colors.border}`,
      borderRadius: 6, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 10,
      minWidth: 200, flex: '1 1 200px',
      position: 'relative',
    }}>
      {active && (
        <div style={{
          position: 'absolute', top: 8, right: 10,
          fontFamily: fonts.body, fontSize: 11, color: colors.primary,
          letterSpacing: 1, textTransform: 'uppercase',
        }}>
          Active
        </div>
      )}

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontFamily: fonts.heading, fontSize: 20, color: colors.text, fontWeight: 700 }}>
            {voice.displayName}
          </span>
          <span style={{ fontSize: 16 }}>{LANGUAGE_FLAG[voice.languageTag] ?? ''}</span>
        </div>
        <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted }}>{voice.description}</div>
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
          ~{voice.approxSizeMB} MB
        </div>
      </div>

      {installProgress !== null && (
        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>
            {stageLabel[installStage] ?? installStage}
          </div>
          <div style={{ background: colors.border, borderRadius: 2, height: 4, overflow: 'hidden' }}>
            <div style={{
              background: colors.primary, height: '100%',
              width: `${Math.round(installProgress * 100)}%`,
              transition: 'width 0.2s',
            }} />
          </div>
        </div>
      )}

      {installError && (
        <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.danger }}>{installError}</div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto' }}>
        <SmallBtn onClick={handlePreview} title="Play sample MP3">Preview</SmallBtn>

        {!installed && installProgress === null && (
          <SmallBtn onClick={handleInstall} primary>
            {installError ? 'Retry' : `Install (${voice.approxSizeMB} MB)`}
          </SmallBtn>
        )}

        {installed && (
          <>
            <SmallBtn onClick={handleRadioCheck} disabled={synthPending}>
              {synthPending ? 'Speaking...' : 'Radio check'}
            </SmallBtn>
            {!active && (
              <SmallBtn onClick={onActivate} primary>Use this voice</SmallBtn>
            )}
            <SmallBtn onClick={handleUninstall} danger>Uninstall</SmallBtn>
          </>
        )}
      </div>
    </div>
  )
}

function SmallBtn({ onClick, children, primary, danger, disabled, title }: {
  onClick: () => void
  children: React.ReactNode
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: primary ? `${colors.primary}22` : danger ? `${colors.danger}22` : colors.bgCard,
        border: `1px solid ${primary ? colors.primary : danger ? colors.danger : colors.border}`,
        color: primary ? colors.primary : danger ? colors.danger : disabled ? colors.textMuted : colors.text,
        fontFamily: fonts.body, fontSize: 12,
        padding: '4px 10px', borderRadius: 3,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}
