export type Priority = 'critical' | 'high' | 'info'

// Frontend → Bridge: uses `command` field (project-wide pattern)
export type EngineerCommand =
  | { command: 'engineer_get_status' }
  | { command: 'engineer_install_piper' }
  | { command: 'engineer_install_voice'; voice_id: string }
  | { command: 'engineer_uninstall_voice'; voice_id: string }
  | { command: 'engineer_synthesize'; voice_id: string; text: string; request_id: string }
  | { command: 'engineer_register_client_role'; role: 'audio' | 'display_only' }
  | { command: 'engineer_update_behavior'; enabled: boolean; frequency: 'low' | 'medium' | 'high'; mute_in_qualifying: boolean; debug_all_rules_in_practice: boolean; active_voice_id: string | null }

export interface VoiceStatus {
  voice_id: string
  installed: boolean
}

// Bridge → Frontend: uses `type` field (project-wide pattern, PascalCase = Rust enum variant names)
export type EngineerMessage =
  | {
      type: 'EngineerStatus'
      piper_installed: boolean
      voices: VoiceStatus[]
    }
  | {
      type: 'EngineerInstallProgress'
      target: 'piper' | 'voice'
      target_id: string | null
      bytes_downloaded: number
      bytes_total: number
      stage: 'downloading' | 'extracting' | 'validating'
    }
  | {
      type: 'EngineerInstallComplete'
      target: 'piper' | 'voice'
      target_id: string | null
      success: boolean
      error: string | null
    }
  | {
      type: 'EngineerAudio'
      request_id: string
      priority: Priority
      wav_base64: string
      sample_rate: number
      duration_ms: number
      text: string
    }
  | {
      type: 'EngineerError'
      message: string
    }
