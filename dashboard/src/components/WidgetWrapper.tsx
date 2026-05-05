import { useState, type ReactNode } from 'react'
import { colors, fonts } from '../styles/theme'
import { SCALE_MIN, SCALE_MAX, SCALE_STEP, SCALE_DEFAULT } from '../stores/layoutStore'

interface Props {
  title: string
  onRemove?: () => void
  locked: boolean
  scale?: number
  onScaleChange?: (scale: number) => void
  children: ReactNode
}

export default function WidgetWrapper({ title, onRemove, locked, scale = SCALE_DEFAULT, onScaleChange, children }: Props) {
  const [hovered, setHovered] = useState(false)

  const canScale = !locked && onScaleChange !== undefined

  const adjustScale = (delta: number) => {
    if (!onScaleChange) return
    const next = Math.round((scale + delta) * 10) / 10
    if (next >= SCALE_MIN && next <= SCALE_MAX) onScaleChange(next)
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        height: '100%',
        background: colors.bgCard,
        border: `1px solid ${hovered && !locked ? colors.primary : colors.border}`,
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'border-color 0.15s',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px',
          borderBottom: `1px solid ${colors.border}`,
          background: colors.bgWidget,
          cursor: locked ? 'default' : 'grab',
          userSelect: 'none',
          flexShrink: 0,
          minHeight: 24,
          gap: 4,
        }}
        className="widget-drag-handle"
      >
        <span style={{
          fontFamily: fonts.heading,
          fontSize: 15,
          color: colors.textMuted,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          lineHeight: 1,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {title}
        </span>

        {/* Scale controls — shown when unlocked and hovered */}
        {canScale && hovered && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => { e.stopPropagation(); adjustScale(-SCALE_STEP) }}
              disabled={scale <= SCALE_MIN}
              title="Scale down"
              style={scaleBtn(scale <= SCALE_MIN)}
            >
              −
            </button>
            <span style={{ fontSize: 10, color: colors.textMuted, minWidth: 30, textAlign: 'center' }}>
              {scale.toFixed(1)}×
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); adjustScale(SCALE_STEP) }}
              disabled={scale >= SCALE_MAX}
              title="Scale up"
              style={scaleBtn(scale >= SCALE_MAX)}
            >
              +
            </button>
          </div>
        )}

        {!locked && hovered && onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            style={{
              background: 'none',
              border: 'none',
              color: colors.textMuted,
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: '0 2px',
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
            title="Remove widget"
          >
            ×
          </button>
        )}
      </div>

      {/* Content — scaled via transform */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${100 / scale}%`,
          height: `${100 / scale}%`,
          padding: 10,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          boxSizing: 'border-box',
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function scaleBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'none',
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    color: disabled ? colors.border : colors.textMuted,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 12,
    lineHeight: 1,
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
  }
}
