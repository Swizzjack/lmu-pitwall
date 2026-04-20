import { colors, fonts } from '../../../styles/theme'

type Frequency = 'low' | 'medium' | 'high'

interface Props {
  value: Frequency
  onChange: (v: Frequency) => void
}

const OPTIONS: { value: Frequency; label: string; desc: string }[] = [
  { value: 'low', label: 'Low', desc: 'Only critical calls (flags, box now, damage)' },
  { value: 'medium', label: 'Medium', desc: 'Critical + periodic gaps, pace warnings, session timers' },
  { value: 'high', label: 'High', desc: 'Everything, including continuous gap updates and tire info' },
]

export default function FrequencySelect({ value, onChange }: Props) {
  const selected = OPTIONS.find((o) => o.value === value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, width: 56, flexShrink: 0 }}>
          FREQUENCY
        </span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as Frequency)}
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
      </div>
      {selected && (
        <p style={{ margin: 0, fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, paddingLeft: 68 }}>
          {selected.desc}
        </p>
      )}
    </div>
  )
}
