import { useState, useEffect, useCallback, useRef } from 'react'
import { colors, fonts } from '../../../styles/theme'
import { engineerService } from '../audio/AudioEngineerService'
import type { EngineerMessage } from '../types'
import { RADIO_CHECK_PHRASE } from '../constants'

interface Props {
  voiceId: string
  onComplete: () => void
  onChooseDifferent: () => void
}

export default function WizardStepRadioCheck({ voiceId, onComplete, onChooseDifferent }: Props) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'done'>('idle')
  const [spokenText, setSpokenText] = useState('')
  const requestIdRef = useRef<string | null>(null)
  const sendingRef = useRef(false)

  const handler = useCallback((msg: EngineerMessage) => {
    if (msg.type === 'EngineerAudio' && msg.request_id === requestIdRef.current) {
      setSpokenText(msg.text)
      setStatus('done')
    }
  }, [])

  useEffect(() => {
    engineerService.addMessageHandler(handler)
    return () => engineerService.removeMessageHandler(handler)
  }, [handler])

  const handleRadioCheck = () => {
    if (sendingRef.current) return
    sendingRef.current = true
    const id = crypto.randomUUID()
    requestIdRef.current = id
    setStatus('pending')
    setSpokenText('')
    engineerService.setEnabled(true)
    engineerService.send({
      command: 'engineer_synthesize',
      voice_id: voiceId,
      text: RADIO_CHECK_PHRASE,
      request_id: id,
    })
  }

  return (
    <div style={{ maxWidth: 480, width: '100%' }}>
      <h2 style={{ fontFamily: fonts.heading, fontSize: 32, color: colors.primary, margin: '0 0 8px', fontWeight: 700 }}>
        Radio check
      </h2>
      <p style={{ fontFamily: fonts.body, fontSize: 15, color: colors.text, margin: '0 0 28px' }}>
        Let's test your engineer. Click below to hear them speak.
      </p>

      {status === 'idle' && (
        <button
          onClick={handleRadioCheck}
          style={{
            background: `${colors.primary}22`, border: `1px solid ${colors.primary}`,
            color: colors.primary, fontFamily: fonts.body, fontSize: 16,
            padding: '12px 28px', borderRadius: 4, cursor: 'pointer',
          }}
        >
          ▶ Start Radio Check
        </button>
      )}

      {status === 'pending' && (
        <div>
          <button disabled style={{
            background: `${colors.primary}44`, border: `1px solid ${colors.primary}44`,
            color: colors.textMuted, fontFamily: fonts.body, fontSize: 16,
            padding: '12px 28px', borderRadius: 4, cursor: 'not-allowed',
          }}>
            Synthesizing…
          </button>
          <p style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 12 }}>
            Requesting audio from bridge…
          </p>
        </div>
      )}

      {status === 'done' && (
        <div>
          <div style={{
            fontFamily: fonts.body, fontSize: 15, color: colors.text,
            padding: '14px 16px', background: colors.bgWidget,
            border: `1px solid ${colors.border}`,
            borderRadius: 4, marginBottom: 20, lineHeight: 1.5,
          }}>
            "{spokenText || RADIO_CHECK_PHRASE}"
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={onComplete}
              style={{
                background: `${colors.primary}22`, border: `1px solid ${colors.primary}`,
                color: colors.primary, fontFamily: fonts.body, fontSize: 14,
                padding: '8px 18px', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Sounds good, continue
            </button>
            <button
              onClick={onChooseDifferent}
              style={{
                background: colors.bgWidget, border: `1px solid ${colors.border}`,
                color: colors.textMuted, fontFamily: fonts.body, fontSize: 14,
                padding: '8px 18px', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Choose a different voice
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
