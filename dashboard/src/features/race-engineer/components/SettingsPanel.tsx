import { useState, useEffect, useCallback, useRef } from 'react'
import { colors, fonts } from '../../../styles/theme'
import { useEngineerSettingsStore, resetSetup } from '../state/engineerSettings'
import { engineerService } from '../audio/AudioEngineerService'
import type { EngineerMessage, VoiceStatus } from '../types'
import { VOICES, RADIO_CHECK_PHRASE } from '../constants'
import VoiceCard from './VoiceCard'
import VolumeSlider from './VolumeSlider'
import FrequencySelect from './FrequencySelect'
import RadioEffectSelect from './RadioEffectSelect'
import OutputDeviceSelect from './OutputDeviceSelect'

interface Props {
  voices: VoiceStatus[]
}

export default function SettingsPanel({ voices: initialVoices }: Props) {
  const {
    enabled, activeVoiceId, volume, frequency, radioEffect, outputDeviceId,
    audioOnThisDevice, muteInQualifying, debugAllRulesInPractice,
  } = useEngineerSettingsStore()
  const {
    setEnabled, setActiveVoiceId, setVolume, setRadioEffect, setOutputDevice, setAudioOnThisDevice,
    setFrequency, setMuteInQualifying, setDebugAllRulesInPractice,
  } = useEngineerSettingsStore()

  const [voices, setVoices] = useState<VoiceStatus[]>(initialVoices)
  const [testPending, setTestPending] = useState(false)
  const testReqIdRef = useRef<string | null>(null)

  const handler = useCallback((msg: EngineerMessage) => {
    if (msg.type === 'EngineerStatus') {
      setVoices(msg.voices)
    }
    if (msg.type === 'EngineerAudio' && msg.request_id === testReqIdRef.current) {
      setTestPending(false)
    }
    if (msg.type === 'EngineerInstallComplete' && msg.success) {
      engineerService.send({ command: 'engineer_get_status' })
    }
  }, [])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  // Clear active voice if it gets uninstalled
  useEffect(() => {
    if (!activeVoiceId) return
    const activeStillInstalled = voices.find(
      (v) => v.voice_id === activeVoiceId && v.installed,
    )
    if (!activeStillInstalled) {
      setActiveVoiceId(null)
      setEnabled(false)
    }
  }, [voices, activeVoiceId, setActiveVoiceId, setEnabled])

  const activeVoice = VOICES.find((v) => v.id === activeVoiceId)
  const hasInstalledVoice = voices.some((v) => v.installed)
  const canToggleOn = hasInstalledVoice && activeVoiceId !== null

  const handleTestEffect = () => {
    if (!activeVoiceId || testPending) return
    const id = crypto.randomUUID()
    testReqIdRef.current = id
    setTestPending(true)
    const wasEnabled = useEngineerSettingsStore.getState().enabled
    engineerService.setEnabled(true)
    engineerService.send({
      command: 'engineer_synthesize',
      voice_id: activeVoiceId,
      text: RADIO_CHECK_PHRASE,
      request_id: id,
    })
    if (!wasEnabled) {
      // Restore disabled state once audio arrives
      const restoreHandler = (msg: EngineerMessage) => {
        if (msg.type === 'EngineerAudio' && msg.request_id === id) {
          if (!useEngineerSettingsStore.getState().enabled) {
            engineerService.setEnabled(false)
          }
          engineerService.removeMessageHandler(restoreHandler)
        }
      }
      engineerService.addMessageHandler(restoreHandler)
    }
  }

  const handleRerunSetup = () => {
    resetSetup()
    window.location.reload()
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 24 }}>

        <Section title="Engineer Status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <ToggleSwitch
              value={enabled && canToggleOn}
              disabled={!canToggleOn}
              onChange={(v) => setEnabled(v)}
            />
            <div>
              <div style={{ fontFamily: fonts.heading, fontSize: 18, color: colors.text, fontWeight: 700 }}>
                Race Engineer
              </div>
              <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                {activeVoice
                  ? `Active voice: ${activeVoice.displayName} (${activeVoice.languageTag})`
                  : 'No voice selected'}
                {!canToggleOn && !activeVoiceId && (
                  <span style={{ color: colors.accent }}> — install and select a voice first</span>
                )}
              </div>
            </div>
          </div>
        </Section>

        <Section title="Voices">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {VOICES.map((v) => {
              const status = voices.find((s) => s.voice_id === v.id)
              return (
                <VoiceCard
                  key={v.id}
                  voice={v}
                  installed={status?.installed ?? false}
                  active={activeVoiceId === v.id}
                  onActivate={() => setActiveVoiceId(v.id)}
                />
              )
            })}
          </div>
        </Section>

        <Section title="Audio">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ToggleRow
              label="Play audio on this device"
              value={audioOnThisDevice}
              onChange={setAudioOnThisDevice}
              helpText="If you open this dashboard on multiple devices (e.g., PC and tablet), only the device with this option enabled will play engineer audio. Turn off on tablet or secondary displays to prevent echo."
            />
            <VolumeSlider value={volume} onChange={setVolume} />
            <OutputDeviceSelect value={outputDeviceId} onChange={setOutputDevice} />
            <RadioEffectSelect
              value={radioEffect}
              onChange={(v) => setRadioEffect(v)}
              onTest={handleTestEffect}
              testDisabled={!activeVoiceId || testPending}
            />
          </div>
        </Section>

        <Section title="Behavior">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FrequencySelect value={frequency} onChange={setFrequency} />
            <ToggleRow
              label="Mute during qualifying"
              value={muteInQualifying}
              onChange={setMuteInQualifying}
              helpText="Turn off the engineer during qualifying sessions for maximum concentration."
            />
            <DebugToggleRow
              label="Debug: enable all rules in practice"
              value={debugAllRulesInPractice}
              onChange={setDebugAllRulesInPractice}
              helpText="For testing — in practice sessions, normally only pace and tire calls are active. Turn this on to hear every rule including fuel, pit strategy, and race-only callouts."
            />
          </div>
        </Section>

        <div style={{ paddingTop: 8, borderTop: `1px solid ${colors.border}` }}>
          <button
            onClick={handleRerunSetup}
            style={{
              background: 'none', border: 'none',
              color: colors.textMuted, fontFamily: fonts.body, fontSize: 12,
              cursor: 'pointer', padding: 0, textDecoration: 'underline',
            }}
          >
            Re-run setup wizard
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontFamily: fonts.body, fontSize: 11, color: colors.textMuted,
        letterSpacing: 2, textTransform: 'uppercase',
        paddingBottom: 8, borderBottom: `1px solid ${colors.border}`, marginBottom: 14,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function ToggleSwitch({ value, onChange, disabled }: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => { if (!disabled) onChange(!value) }}
      title={disabled ? 'Install and select a voice first' : value ? 'Disable' : 'Enable'}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none',
        background: value ? colors.primary : colors.border,
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', flexShrink: 0, transition: 'background 0.2s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{
        position: 'absolute', top: 3, borderRadius: '50%',
        width: 18, height: 18, background: '#fff',
        left: value ? 23 : 3, transition: 'left 0.2s',
      }} />
    </button>
  )
}

function ToggleRow({ label, value, onChange, helpText }: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  helpText?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ToggleSwitch value={value} onChange={onChange} />
        <span style={{ fontFamily: fonts.body, fontSize: 14, color: colors.text }}>
          {label}
        </span>
      </div>
      {helpText && (
        <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 1.5, paddingLeft: 56 }}>
          {helpText}
        </div>
      )}
    </div>
  )
}

function DebugToggleRow({ label, value, onChange, helpText }: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  helpText?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ToggleSwitch value={value} onChange={onChange} />
        <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted }}>
          {label}
        </span>
      </div>
      {helpText && (
        <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 1.5, paddingLeft: 56 }}>
          {helpText}
        </div>
      )}
    </div>
  )
}
