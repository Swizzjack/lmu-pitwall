import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { engineerService } from '../audio/AudioEngineerService'
import type { RadioEffectMode } from '../audio/radioEffect'

export interface EngineerSettings {
  enabled: boolean
  activeVoiceId: string | null
  volume: number
  frequency: 'low' | 'medium' | 'high'
  radioEffect: RadioEffectMode
  outputDeviceId: string | null
  audioOnThisDevice: boolean
  muteInQualifying: boolean
  debugAllRulesInPractice: boolean
}

interface EngineerSettingsStore extends EngineerSettings {
  update: (partial: Partial<EngineerSettings>) => void
  setEnabled: (enabled: boolean) => void
  setActiveVoiceId: (voiceId: string | null) => void
  setVolume: (volume: number) => void
  setRadioEffect: (effect: RadioEffectMode) => void
  setOutputDevice: (deviceId: string | null) => void
  setAudioOnThisDevice: (v: boolean) => void
  setFrequency: (v: 'low' | 'medium' | 'high') => void
  setMuteInQualifying: (v: boolean) => void
  setDebugAllRulesInPractice: (v: boolean) => void
}

const SETUP_KEY = 'lmu-pitwall:engineer-setup-completed:v1'

export function isSetupCompleted(): boolean {
  return localStorage.getItem(SETUP_KEY) === 'true'
}

export function markSetupCompleted() {
  localStorage.setItem(SETUP_KEY, 'true')
}

export function resetSetup() {
  localStorage.removeItem(SETUP_KEY)
}

const defaults: EngineerSettings = {
  enabled: false,
  activeVoiceId: null,
  volume: 0.7,
  frequency: 'medium',
  radioEffect: 'subtle',
  outputDeviceId: null,
  audioOnThisDevice: true,
  muteInQualifying: false,
  debugAllRulesInPractice: false,
}

function sendBehavior(s: Pick<EngineerSettings, 'enabled' | 'frequency' | 'muteInQualifying' | 'debugAllRulesInPractice' | 'activeVoiceId'>) {
  engineerService.sendBehaviorUpdate({
    enabled: s.enabled,
    frequency: s.frequency,
    muteInQualifying: s.muteInQualifying,
    debugAllRulesInPractice: s.debugAllRulesInPractice,
    activeVoiceId: s.activeVoiceId,
  })
}

export const useEngineerSettingsStore = create<EngineerSettingsStore>()(
  persist(
    (set, get) => ({
      ...defaults,

      update(partial) {
        set(partial)
      },

      setEnabled(enabled) {
        engineerService.setEnabled(enabled)
        set({ enabled })
        const s = get()
        sendBehavior({ enabled, frequency: s.frequency, muteInQualifying: s.muteInQualifying, debugAllRulesInPractice: s.debugAllRulesInPractice, activeVoiceId: s.activeVoiceId })
      },

      setActiveVoiceId(activeVoiceId) {
        set({ activeVoiceId })
        const s = get()
        sendBehavior({ enabled: s.enabled, frequency: s.frequency, muteInQualifying: s.muteInQualifying, debugAllRulesInPractice: s.debugAllRulesInPractice, activeVoiceId })
      },

      setFrequency(frequency) {
        set({ frequency })
        const s = get()
        sendBehavior({ enabled: s.enabled, frequency, muteInQualifying: s.muteInQualifying, debugAllRulesInPractice: s.debugAllRulesInPractice, activeVoiceId: s.activeVoiceId })
      },

      setMuteInQualifying(muteInQualifying) {
        set({ muteInQualifying })
        const s = get()
        sendBehavior({ enabled: s.enabled, frequency: s.frequency, muteInQualifying, debugAllRulesInPractice: s.debugAllRulesInPractice, activeVoiceId: s.activeVoiceId })
      },

      setDebugAllRulesInPractice(debugAllRulesInPractice) {
        set({ debugAllRulesInPractice })
        const s = get()
        sendBehavior({ enabled: s.enabled, frequency: s.frequency, muteInQualifying: s.muteInQualifying, debugAllRulesInPractice, activeVoiceId: s.activeVoiceId })
      },

      setVolume(volume) {
        engineerService.setVolume(volume)
        set({ volume })
      },

      setRadioEffect(radioEffect) {
        engineerService.setRadioEffect(radioEffect)
        set({ radioEffect })
      },

      setOutputDevice(outputDeviceId) {
        engineerService.setOutputDevice(outputDeviceId)
        set({ outputDeviceId })
      },

      setAudioOnThisDevice(audioOnThisDevice) {
        engineerService.setAudioOnThisDevice(audioOnThisDevice)
        set({ audioOnThisDevice })
      },
    }),
    {
      name: 'lmu-pitwall:engineer-settings:v1',
      onRehydrateStorage: () => (state) => {
        if (!state) return
        engineerService.setEnabled(state.enabled)
        engineerService.setVolume(state.volume)
        engineerService.setRadioEffect(state.radioEffect)
        engineerService.setOutputDevice(state.outputDeviceId)
        engineerService.setAudioOnThisDevice(state.audioOnThisDevice)
        sendBehavior({ enabled: state.enabled, frequency: state.frequency, muteInQualifying: state.muteInQualifying, debugAllRulesInPractice: state.debugAllRulesInPractice, activeVoiceId: state.activeVoiceId })
      },
    },
  ),
)
