import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

// ---------------------------------------------------------------------------
// Body damage zone labels (rF2 mDentSeverity[8] — approx. front→rear)
// ---------------------------------------------------------------------------

const DENT_ZONES = ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'F/L', 'F/R', 'R/L', 'R/R']

function dentColor(severity: number): string {
  if (severity === 2) return colors.danger
  if (severity === 1) return colors.accent
  return '#2a2a2a'
}

function dentTextColor(severity: number): string {
  if (severity >= 1) return '#fff'
  return colors.textMuted
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DamagePanel({
  overheating,
  anyDetached,
  dentSeverity,
  lastImpact,
}: {
  overheating: boolean
  anyDetached: boolean
  dentSeverity: number[]
  lastImpact: number
}) {
  const hasDents = dentSeverity.some((d) => d > 0)
  const showImpact = lastImpact > 10

  return (
    <div>
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: 4,
      }}>
        Vehicle Damage
      </div>

      {/* Warning badges */}
      {(overheating || anyDetached) && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          {overheating && (
            <div style={{
              padding: '2px 8px',
              borderRadius: 3,
              background: colors.danger,
              fontFamily: fonts.body,
              fontSize: 13,
              color: '#fff',
              fontWeight: 700,
              letterSpacing: 1,
            }}>
              OVERHEAT
            </div>
          )}
          {anyDetached && (
            <div style={{
              padding: '2px 8px',
              borderRadius: 3,
              background: '#7c3aed',
              fontFamily: fonts.body,
              fontSize: 13,
              color: '#fff',
              fontWeight: 700,
              letterSpacing: 1,
            }}>
              DETACHED
            </div>
          )}
        </div>
      )}

      {/* Dent grid */}
      {hasDents ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3 }}>
          {dentSeverity.map((sev, i) => (
            <div key={i} style={{
              borderRadius: 3,
              background: dentColor(sev),
              border: `1px solid ${sev > 0 ? 'transparent' : colors.border}`,
              padding: '3px 2px',
              textAlign: 'center',
              fontFamily: fonts.body,
              fontSize: 13,
              color: dentTextColor(sev),
              letterSpacing: 0.5,
            }}>
              {DENT_ZONES[i]}
            </div>
          ))}
        </div>
      ) : (
        <div style={{
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.success,
          letterSpacing: 0.5,
        }}>
          No body damage
        </div>
      )}

      {/* Last impact */}
      {showImpact && (
        <div style={{
          marginTop: 4,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: fonts.mono,
          fontSize: 15,
          color: lastImpact > 500 ? colors.danger : colors.accent,
        }}>
          <span style={{ color: colors.textMuted, fontFamily: fonts.body }}>LAST IMPACT</span>
          <span>{Math.round(lastImpact)}</span>
        </div>
      )}
    </div>
  )
}

function TireStatusPanel({
  flat,
  detached,
}: {
  flat: boolean[]
  detached: boolean[]
}) {
  const labels = ['FL', 'FR', 'RL', 'RR']
  const anyDamage = flat.some(Boolean) || detached.some(Boolean)

  if (!anyDamage) return null

  return (
    <div>
      <div style={{
        fontFamily: fonts.body,
        fontSize: 15,
        color: colors.textMuted,
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: 4,
      }}>
        Tyre Damage
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {labels.map((lbl, i) => {
          const isFlat = flat[i]
          const isDet = detached[i]
          if (!isFlat && !isDet) return null
          return (
            <div key={i} style={{
              flex: '0 0 auto',
              padding: '3px 8px',
              borderRadius: 3,
              background: isDet ? '#7c3aed' : colors.danger,
              fontFamily: fonts.body,
              fontSize: 13,
              color: '#fff',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
            }}>
              <span style={{ fontWeight: 700, letterSpacing: 1 }}>{lbl}</span>
              <span style={{ fontSize: 11, opacity: 0.85 }}>{isDet ? 'DETACH' : 'FLAT'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export default function VehicleStatus() {
  const vs = useTelemetryStore((s) => s.vehicleStatus)

  const anyTireDamage = vs.tire_flat.some(Boolean) || vs.tire_detached.some(Boolean)

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '10px 12px',
      gap: 8,
      boxSizing: 'border-box',
      overflowY: 'auto',
    }}>
      <DamagePanel
        overheating={vs.overheating}
        anyDetached={vs.any_detached}
        dentSeverity={Array.from(vs.dent_severity)}
        lastImpact={vs.last_impact_magnitude}
      />

      {anyTireDamage && (
        <>
          <div style={{ height: 1, background: colors.border }} />
          <TireStatusPanel flat={Array.from(vs.tire_flat)} detached={Array.from(vs.tire_detached)} />
        </>
      )}
    </div>
  )
}
