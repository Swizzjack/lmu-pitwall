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
  pilotName: string
  muteNameInCallouts: boolean
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
  setPilotName: (v: string) => void
  setMuteNameInCallouts: (v: boolean) => void
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
  pilotName: '',
  muteNameInCallouts: false,
}

function sendBehavior(s: Pick<EngineerSettings, 'enabled' | 'frequency' | 'muteInQualifying' | 'debugAllRulesInPractice' | 'activeVoiceId' | 'pilotName' | 'muteNameInCallouts'>) {
  engineerService.sendBehaviorUpdate({
    enabled: s.enabled,
    frequency: s.frequency,
    muteInQualifying: s.muteInQualifying,
    debugAllRulesInPractice: s.debugAllRulesInPractice,
    activeVoiceId: s.activeVoiceId,
    pilotName: s.pilotName,
    muteNameInCallouts: s.muteNameInCallouts,
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
        sendBehavior(get())
      },

      setActiveVoiceId(activeVoiceId) {
        set({ activeVoiceId })
        sendBehavior(get())
      },

      setFrequency(frequency) {
        set({ frequency })
        sendBehavior(get())
      },

      setMuteInQualifying(muteInQualifying) {
        set({ muteInQualifying })
        sendBehavior(get())
      },

      setDebugAllRulesInPractice(debugAllRulesInPractice) {
        set({ debugAllRulesInPractice })
        sendBehavior(get())
      },

      setPilotName(pilotName) {
        set({ pilotName })
        sendBehavior(get())
      },

      setMuteNameInCallouts(muteNameInCallouts) {
        set({ muteNameInCallouts })
        sendBehavior(get())
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
        sendBehavior(state)
      },
    },
  ),
)
