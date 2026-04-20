import { useState } from 'react'
import { colors } from '../../../styles/theme'
import WizardStepPiper from './WizardStepPiper'
import WizardStepVoice from './WizardStepVoice'
import WizardStepRadioCheck from './WizardStepRadioCheck'
import type { VoiceStatus } from '../types'

type WizardStep = 'piper' | 'voice' | 'radio-check'

interface Props {
  initialStep: WizardStep
  voices: VoiceStatus[]
  initialVoiceId: string | null
  onComplete: (voiceId: string) => void
  onSkip: () => void
}

export default function SetupWizard({ initialStep, voices, initialVoiceId, onComplete, onSkip }: Props) {
  const [step, setStep] = useState<WizardStep>(initialStep)
  const [currentVoices, setCurrentVoices] = useState<VoiceStatus[]>(voices)
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(initialVoiceId)

  const handleVoiceInstalled = (voiceId: string) => {
    setSelectedVoiceId(voiceId)
    setCurrentVoices((prev) => prev.map((v) =>
      v.voice_id === voiceId ? { ...v, installed: true } : v
    ))
    setStep('radio-check')
  }

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 32, overflow: 'auto',
    }}>
      <div style={{ width: '100%', maxWidth: 720 }}>
        <StepIndicator current={step} />
        <div style={{ marginTop: 32 }}>
          {step === 'piper' && (
            <WizardStepPiper
              onInstalled={() => setStep('voice')}
              onSkip={onSkip}
            />
          )}
          {step === 'voice' && (
            <WizardStepVoice
              voices={currentVoices}
              onInstalled={handleVoiceInstalled}
              onSkip={onSkip}
            />
          )}
          {step === 'radio-check' && selectedVoiceId && (
            <WizardStepRadioCheck
              voiceId={selectedVoiceId}
              onComplete={() => onComplete(selectedVoiceId)}
              onChooseDifferent={() => setStep('voice')}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function StepIndicator({ current }: { current: WizardStep }) {
  const steps: { key: WizardStep; label: string }[] = [
    { key: 'piper', label: '1. Install Piper' },
    { key: 'voice', label: '2. Choose Voice' },
    { key: 'radio-check', label: '3. Radio Check' },
  ]

  return (
    <div style={{ display: 'flex', gap: 0, alignItems: 'center' }}>
      {steps.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{
            padding: '4px 14px',
            fontFamily: 'var(--font-body, sans-serif)',
            fontSize: 13,
            color: s.key === current ? colors.primary : colors.textMuted,
            borderBottom: `2px solid ${s.key === current ? colors.primary : 'transparent'}`,
          }}>
            {s.label}
          </div>
          {i < steps.length - 1 && (
            <div style={{ color: colors.border, margin: '0 4px' }}>›</div>
          )}
        </div>
      ))}
    </div>
  )
}
