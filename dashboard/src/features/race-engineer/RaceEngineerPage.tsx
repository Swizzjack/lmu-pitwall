import { colors, fonts } from '../../styles/theme'
import { useEngineerStatus } from './state/useEngineerStatus'
import { useEngineerSettingsStore, isSetupCompleted, markSetupCompleted } from './state/engineerSettings'
import SetupWizard from './components/SetupWizard'
import SettingsPanel from './components/SettingsPanel'

interface Props {
  onClose: () => void
}

export default function RaceEngineerPage({ onClose }: Props) {
  const { piperInstalled, voices, loading } = useEngineerStatus()
  const { update, setEnabled } = useEngineerSettingsStore()
  const setupCompleted = isSetupCompleted()

  // Determine which view to show
  const installedVoices = voices.filter((v) => v.installed)
  const firstInstalledVoice = installedVoices[0]?.voice_id ?? null

  let initialStep: 'piper' | 'voice' | 'radio-check' = 'piper'
  if (piperInstalled && installedVoices.length === 0) initialStep = 'voice'
  if (piperInstalled && installedVoices.length > 0 && !setupCompleted) initialStep = 'radio-check'

  const showSettings = !loading && piperInstalled && installedVoices.length > 0 && setupCompleted
  const showWizard = !loading && !showSettings

  const handleWizardComplete = (voiceId: string) => {
    markSetupCompleted()
    update({ activeVoiceId: voiceId })
    setEnabled(true)
  }

  return (
    <div style={{
      flex: 1,
      background: colors.bg,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Page header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '14px 24px',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.bgCard, flexShrink: 0,
      }}>
        <span style={{ fontFamily: fonts.heading, fontSize: 26, color: colors.primary, fontWeight: 700, letterSpacing: 1 }}>
          Race Engineer
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{
            background: colors.bgWidget, border: `1px solid ${colors.border}`,
            color: colors.textMuted, fontFamily: fonts.body, fontSize: 14,
            padding: '4px 14px', borderRadius: 3, cursor: 'pointer',
          }}
        >
          ✕ Close
        </button>
      </div>

      {loading && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: fonts.body, fontSize: 14, color: colors.textMuted,
        }}>
          Connecting to bridge…
        </div>
      )}

      {showWizard && (
        <SetupWizard
          initialStep={initialStep}
          voices={voices}
          initialVoiceId={firstInstalledVoice}
          onComplete={handleWizardComplete}
          onSkip={onClose}
        />
      )}

      {showSettings && (
        <SettingsPanel voices={voices} />
      )}
    </div>
  )
}
