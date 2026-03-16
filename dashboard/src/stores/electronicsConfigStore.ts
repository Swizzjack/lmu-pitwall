import { create } from 'zustand'
import { sendWsCommand } from '../hooks/useWebSocket'
import type {
  ServerMessage,
  InputBinding,
  ElectronicsDefaults,
} from '../types/telemetry'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ElectronicsConfigState {
  bindings: Record<string, InputBinding | null>
  defaults: ElectronicsDefaults
  // Capture mode: which binding_id is currently waiting for a button press
  capturing: string | null
  captureStartedAt: number | null
  // Save status feedback
  saveStatus: 'idle' | 'saved' | 'error'

  // Store actions
  applyMessage: (msg: ServerMessage) => void
  startCapture: (bindingId: string) => void
  cancelCapture: () => void
  clearBinding: (bindingId: string) => void
  updateAndSaveConfig: (defaults: ElectronicsDefaults) => void
  saveConfig: () => void
  resetSaveStatus: () => void
}

const DEFAULT_DEFAULTS: ElectronicsDefaults = {
  tc: 5,
  tc_cut: 5,
  tc_slip: 3,
  abs: 3,
  engine_map: 3,
  front_arb: 3,
  rear_arb: 3,
  brake_bias: 56.0,
  regen: 0,
  brake_migration: 0,
}

export const useElectronicsConfigStore = create<ElectronicsConfigState>((set, get) => ({
  bindings: {},
  defaults: { ...DEFAULT_DEFAULTS },
  capturing: null,
  captureStartedAt: null,
  saveStatus: 'idle',

  applyMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'ConfigState':
        set({
          bindings: msg.bindings,
          defaults: msg.defaults,
        })
        break

      case 'BindingCaptured':
        set((s) => ({
          bindings: { ...s.bindings, [msg.binding_id]: msg.binding },
          capturing: null,
          captureStartedAt: null,
        }))
        break

      case 'BindingTimeout':
        if (get().capturing === msg.binding_id) {
          set({ capturing: null, captureStartedAt: null })
        }
        break

      case 'ConfigSaved':
        set({ saveStatus: msg.success ? 'saved' : 'error' })
        // Auto-clear after 3 seconds
        setTimeout(() => set({ saveStatus: 'idle' }), 3000)
        break

      default:
        break
    }
  },

  startCapture(bindingId: string) {
    set({ capturing: bindingId, captureStartedAt: Date.now() })
    sendWsCommand({ command: 'start_binding_capture', binding_id: bindingId })
  },

  cancelCapture() {
    set({ capturing: null, captureStartedAt: null })
    sendWsCommand({ command: 'cancel_binding_capture' })
  },

  clearBinding(bindingId: string) {
    sendWsCommand({ command: 'clear_binding', binding_id: bindingId })
  },

  updateAndSaveConfig(defaults: ElectronicsDefaults) {
    sendWsCommand({ command: 'update_defaults', defaults })
    sendWsCommand({ command: 'save_config' })
  },

  saveConfig() {
    sendWsCommand({ command: 'save_config' })
  },

  resetSaveStatus() {
    set({ saveStatus: 'idle' })
  },
}))
