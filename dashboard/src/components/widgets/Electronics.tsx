import { useRef, useEffect, useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useElectronicsConfigStore } from '../../stores/electronicsConfigStore'
import { colors, fonts } from '../../styles/theme'

// ---------------------------------------------------------------------------
// Flash-on-change hook
// Returns true for 300 ms whenever `value` changes, then false.
// ---------------------------------------------------------------------------
function useFlash(value: unknown) {
  const [flashing, setFlashing] = useState(false)
  const prev = useRef(value)
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      setFlashing(true)
      const t = setTimeout(() => setFlashing(false), 300)
      return () => clearTimeout(t)
    }
  }, [value])
  return flashing
}

// ---------------------------------------------------------------------------
// Single "cell" — label + big value, flashes yellow on change
// ---------------------------------------------------------------------------
function Cell({ label, value }: { label: string; value: string | number }) {
  const flashing = useFlash(value)
  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 4,
      padding: '5px 6px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 2,
    }}>
      <span style={{
        fontFamily: fonts.heading,
        fontSize: 20,
        lineHeight: 1,
        color: flashing ? '#facc15' : colors.text,
        transition: 'color 0.3s',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      }}>
        {value}
      </span>
      <span style={{
        fontFamily: fonts.body,
        fontSize: 13,
        color: colors.textMuted,
        textTransform: 'uppercase' as const,
        letterSpacing: 1,
        lineHeight: 1,
      }}>
        {label}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Brake Bias text row (button-counted %)
// ---------------------------------------------------------------------------
function BrakeBiasRow({ biasPct }: { biasPct: number }) {
  const flashing = useFlash(biasPct.toFixed(1))
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, textTransform: 'uppercase' as const, letterSpacing: 1 }}>
        Brake Bias
      </span>
      <span style={{
        fontFamily: fonts.heading,
        fontSize: 15,
        color: flashing ? '#facc15' : colors.text,
        transition: 'color 0.3s',
      }}>
        {biasPct.toFixed(1)}% F
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------
export default function Electronics() {
  const elec = useTelemetryStore((s) => s.electronics)
  const cfgBindings = useElectronicsConfigStore((s) => s.bindings)

  const hasAnyBinding = Object.values(cfgBindings).some((b) => b !== null)
  const hasBmig   = elec.brake_migration_max > 0
  const hasRegen  = elec.regen > 0

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '8px 10px',
      gap: 6,
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <span style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
        flexShrink: 0,
      }}>
        Electronics
      </span>

      {!elec.buttons_configured ? (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          textAlign: 'center',
        }}>
          {hasAnyBinding ? (
            /* Bindings saved but LMU not running yet */
            <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, lineHeight: 1.6 }}>
              Waiting for session…
            </span>
          ) : (
            /* No bindings configured at all */
            <span style={{ fontFamily: fonts.body, fontSize: 15, color: colors.textMuted, lineHeight: 1.6 }}>
              No buttons configured.{'\n'}
              Please go to{' '}
              <span style={{ color: '#facc15' }}>⚙ Settings</span>{' '}
              → Electronics Setup{'\n'}
              to assign buttons.
            </span>
          )}
        </div>
      ) : (
        <>
          {/* Row 1: TC / TC CUT / TC SLIP / ABS / MAP */}
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <Cell label="TC"      value={elec.tc} />
            <Cell label="TC CUT"  value={elec.tc_cut} />
            <Cell label="TC SLIP" value={elec.tc_slip} />
            <Cell label="ABS"     value={elec.abs} />
            <Cell label="MAP"     value={elec.engine_map} />
          </div>

          {/* Row 2: FARB / RARB / REGEN (optional) / BMIG (optional) */}
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <Cell label="FARB" value={elec.front_arb} />
            <Cell label="RARB" value={elec.rear_arb} />
            {hasRegen && <Cell label="REGEN" value={elec.regen} />}
            {hasBmig  && <Cell label="BMIG"  value={elec.brake_migration} />}
          </div>

          {/* Brake Bias text */}
          <BrakeBiasRow biasPct={elec.brake_bias} />
        </>
      )}

      {/* Info note + Settings hint */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexShrink: 0,
        marginTop: 'auto',
      }}>
        <span
          title="Values are counted from configured defaults or garage API on session start. Button presses increment/decrement the counter."
          style={{
            fontFamily: fonts.body,
            fontSize: 13,
            color: '#737373',
            cursor: 'default',
            userSelect: 'none',
          }}
        >
          ⓘ Button-counted from session start
        </span>
        {elec.buttons_configured && (
          <span style={{
            fontFamily: fonts.body,
            fontSize: 13,
            color: '#737373',
            flexShrink: 0,
          }}>
            Bindings: ⚙ Settings
          </span>
        )}
      </div>
    </div>
  )
}
