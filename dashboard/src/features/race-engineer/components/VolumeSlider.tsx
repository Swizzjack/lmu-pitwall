import { colors, fonts } from '../../../styles/theme'

interface Props {
  value: number // 0.0–1.0
  onChange: (v: number) => void
}

export default function VolumeSlider({ value, onChange }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, width: 56, flexShrink: 0 }}>
        VOLUME
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ flex: 1, accentColor: colors.primary, cursor: 'pointer' }}
      />
      <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text, width: 36, textAlign: 'right' }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}
