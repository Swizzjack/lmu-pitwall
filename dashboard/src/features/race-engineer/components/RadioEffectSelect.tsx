import { colors, fonts } from '../../../styles/theme'
import type { RadioEffectMode } from '../audio/radioEffect'

interface Props {
  value: RadioEffectMode
  onChange: (v: RadioEffectMode) => void
  onTest: () => void
  testDisabled?: boolean
}

const OPTIONS: { value: RadioEffectMode; label: string }[] = [
  { value: 'off', label: 'Off (clean audio)' },
  { value: 'subtle', label: 'Subtle (light bandpass + compression)' },
  { value: 'medium', label: 'Medium (radio grit + background noise)' },
  { value: 'strong', label: 'Strong (heavy radio + PTT click)' },
]

export default function RadioEffectSelect({ value, onChange, onTest, testDisabled }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, width: 56, flexShrink: 0 }}>
        RADIO FX
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as RadioEffectMode)}
        style={{
          background: colors.bgWidget,
          border: `1px solid ${colors.border}`,
          color: colors.text,
          fontFamily: fonts.body,
          fontSize: 14,
          padding: '4px 8px',
          borderRadius: 3,
          cursor: 'pointer',
          flex: 1,
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <button
        onClick={onTest}
        disabled={testDisabled}
        title="Test effect with demo phrase"
        style={{
          background: colors.bgWidget,
          border: `1px solid ${colors.border}`,
          color: testDisabled ? colors.textMuted : colors.text,
          fontFamily: fonts.body,
          fontSize: 12,
          padding: '4px 10px',
          borderRadius: 3,
          cursor: testDisabled ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Test effect
      </button>
    </div>
  )
}
