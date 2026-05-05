import { useState, useEffect, useCallback } from 'react'
import { engineerService } from '../audio/AudioEngineerService'
import type { EngineerMessage, VoiceStatus } from '../types'

export interface EngineerInstallStatus {
  piperInstalled: boolean
  voices: VoiceStatus[]
  loading: boolean
}

export function useEngineerStatus(): EngineerInstallStatus {
  const [status, setStatus] = useState<EngineerInstallStatus>({
    piperInstalled: false,
    voices: [],
    loading: true,
  })

  const handler = useCallback((msg: EngineerMessage) => {
    if (msg.type === 'EngineerStatus') {
      setStatus({
        piperInstalled: msg.piper_installed,
        voices: msg.voices,
        loading: false,
      })
    } else if (msg.type === 'EngineerInstallComplete' && msg.success) {
      engineerService.send({ command: 'engineer_get_status' })
    }
  }, [])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    engineerService.send({ command: 'engineer_get_status' })
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  return status
}
