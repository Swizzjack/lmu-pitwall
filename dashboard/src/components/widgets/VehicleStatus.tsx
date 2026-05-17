import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'
import { SEV_PCT, DAMAGE_ZONES } from '../../utils/damage'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WHEEL_LABELS = ['FL', 'FR', 'RL', 'RR']

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function barColor(pct: number): string {
  if (pct >= 75) return colors.danger
  if (pct >= 40) return colors.accent
  return colors.success
}

function SectionTitle({ label, value }: { label: string; value?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
      <div style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
        {label}
      </div>
      {value !== undefined && (
        <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted, fontWeight: 700 }}>
          {value}
        </div>
      )}
    </div>
  )
}

function BarRow({ label, pct, labelWidth = 36 }: { label: string; pct: number; labelWidth?: number }) {
  const color = barColor(pct)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, letterSpacing: 0.5, width: labelWidth, flexShrink: 0, textAlign: 'right' }}>
        {label}
      </div>
      <div style={{ flex: 1, height: 9, borderRadius: 2, background: '#1e1e1e', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ fontFamily: fonts.mono, fontSize: 11, color: pct === 0 ? colors.textMuted : color, width: 34, flexShrink: 0, textAlign: 'right' }}>
        {pct.toFixed(pct < 1 && pct > 0 ? 1 : 0)}%
      </div>
    </div>
  )
}

function Divider() {
  return <div style={{ height: 1, background: colors.border }} />
}

// ---------------------------------------------------------------------------
// ZoneTile — one panel of the car diagram
// ---------------------------------------------------------------------------

function ZoneTile({ label, severity }: { label: string; severity: number }) {
  const bg     = severity === 2 ? `${colors.danger}28`  : severity === 1 ? `${colors.accent}28`  : '#161616'
  const border = severity === 2 ? colors.danger          : severity === 1 ? colors.accent          : colors.border
  const text   = severity === 2 ? colors.danger          : severity === 1 ? colors.accent          : colors.textMuted
  return (
    <div style={{
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: 4,
      padding: '5px 4px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      minHeight: 36,
    }}>
      <span style={{ fontFamily: fonts.body, fontSize: 9, color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        {label}
      </span>
      {severity > 0 && (
        <span style={{ fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, color: text, letterSpacing: 0.5 }}>
          {severity === 2 ? 'HEAVY' : 'LIGHT'}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CarDiagram — top-down 3×3 grid with zones + center silhouette
// ---------------------------------------------------------------------------

function CarDiagram({ dentSeverity, aeroPct, lastImpact, overheating, anyDetached }: {
  dentSeverity: number[]
  aeroPct: number | null
  lastImpact: number
  overheating: boolean
  anyDetached: boolean
}) {
  const totalPct  = dentSeverity.reduce((sum, s) => sum + (SEV_PCT[s] ?? 0), 0)
  const overallPct = Math.round(totalPct / (dentSeverity.length * 100) * 100)
  const displayPct = aeroPct !== null ? Math.round(aeroPct) : overallPct
  const showImpact = lastImpact > 10

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, letterSpacing: 2, textTransform: 'uppercase' }}>
          Body Damage
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 13, color: barColor(displayPct), fontWeight: 700 }}>
          {displayPct}%
        </div>
      </div>

      {/* Warning badges */}
      {(overheating || anyDetached) && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          {overheating && (
            <div style={{ padding: '2px 7px', borderRadius: 3, background: colors.danger, fontFamily: fonts.body, fontSize: 11, color: '#fff', fontWeight: 700, letterSpacing: 1 }}>
              OVERHEAT
            </div>
          )}
          {anyDetached && (
            <div style={{ padding: '2px 7px', borderRadius: 3, background: '#7c3aed', fontFamily: fonts.body, fontSize: 11, color: '#fff', fontWeight: 700, letterSpacing: 1 }}>
              DETACHED
            </div>
          )}
        </div>
      )}

      {/* 3×3 car diagram */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1.5fr 1fr',
        gridTemplateRows: 'repeat(3, auto)',
        gap: 3,
      }}>
        {DAMAGE_ZONES.map(({ idx, label, col, row }) => (
          <div key={idx} style={{ gridColumn: col, gridRow: row }}>
            <ZoneTile label={label} severity={dentSeverity[idx] ?? 0} />
          </div>
        ))}

        {/* Center — car body silhouette */}
        <div style={{
          gridColumn: 2,
          gridRow: 2,
          background: '#111',
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 36,
        }}>
          <svg width="18" height="26" viewBox="0 0 18 26" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="16" height="24" rx="5" fill="#1e1e1e" stroke={colors.border} />
            <rect x="3" y="3" width="12" height="7" rx="2" fill="#2a2a2a" />
            <rect x="3" y="16" width="12" height="7" rx="2" fill="#2a2a2a" />
          </svg>
        </div>
      </div>

      {/* Precise aero % from REST API */}
      {aeroPct !== null && (
        <div style={{ marginTop: 6 }}>
          <BarRow label="AERO" pct={aeroPct} />
        </div>
      )}

      {showImpact && (
        <div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between', fontFamily: fonts.mono, fontSize: 12, color: lastImpact > 500 ? colors.danger : colors.accent }}>
          <span style={{ color: colors.textMuted, fontFamily: fonts.body, fontSize: 12 }}>LAST IMPACT</span>
          <span>{Math.round(lastImpact)}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WheelBarsPanel — 4 wheels with float percentages
// ---------------------------------------------------------------------------

function WheelBarsPanel({ title, values }: { title: string; values: number[] }) {
  const available = values.some(v => v >= 0)
  if (!available) return null

  const valid = values.filter(v => v >= 0)
  const avgPct = Math.round(valid.reduce((s, v) => s + v, 0) / valid.length * 100)

  return (
    <div>
      <SectionTitle label={title} value={`avg ${avgPct}%`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {WHEEL_LABELS.map((lbl, i) => {
          const val = values[i]
          if (val < 0) return null
          return <BarRow key={i} label={lbl} pct={Math.round(val * 100)} />
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TireStatusPanel — flat / detached alerts
// ---------------------------------------------------------------------------

function TireStatusPanel({ flat, detached }: { flat: boolean[]; detached: boolean[] }) {
  const anyDamage = flat.some(Boolean) || detached.some(Boolean)
  if (!anyDamage) return null

  return (
    <div>
      <SectionTitle label="Tyre Damage" />
      <div style={{ display: 'flex', gap: 4 }}>
        {WHEEL_LABELS.map((lbl, i) => {
          const isFlat = flat[i]
          const isDet  = detached[i]
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
// SectionAvgRow — single averaged bar for medium mode
// ---------------------------------------------------------------------------

function SectionAvgRow({ title, values }: { title: string; values: number[] }) {
  const valid = values.filter(v => v >= 0)
  if (valid.length === 0) return null
  const avgPct = Math.round(valid.reduce((s, v) => s + v, 0) / valid.length * 100)
  return <BarRow label={title} pct={avgPct} labelWidth={52} />
}

// ---------------------------------------------------------------------------
// CompactStats — worst tire stat row for compact mode
// ---------------------------------------------------------------------------

function CompactStats({ brakeWear }: { brakeWear: number[] }) {
  const valid = brakeWear.filter(v => v >= 0)
  if (valid.length === 0) return null
  const worstPct = Math.round(Math.max(...valid) * 100)
  const color = barColor(worstPct)
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' }}>
        Worst Tire
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 13, color: worstPct === 0 ? colors.textMuted : color, fontWeight: 700 }}>
        {worstPct}%
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export default function VehicleStatus() {
  const vs           = useTelemetryStore((s) => s.vehicleStatus)
  const damageDetail = useSettingsStore((s) => s.damageDetail)

  const anyTireDamage = vs.tire_flat.some(Boolean) || vs.tire_detached.some(Boolean)
  const aeroPct       = vs.aero_damage >= 0 ? vs.aero_damage * 100 : null
  const hasBrakeData  = vs.brake_wear.some(v => v >= 0)
  const hasSuspData   = vs.suspension_damage.some(v => v >= 0)

  const diagram = (
    <CarDiagram
      dentSeverity={Array.from(vs.dent_severity)}
      aeroPct={aeroPct}
      lastImpact={vs.last_impact_magnitude}
      overheating={vs.overheating}
      anyDetached={vs.any_detached}
    />
  )

  const tireAlerts = anyTireDamage && (
    <>
      <Divider />
      <TireStatusPanel flat={Array.from(vs.tire_flat)} detached={Array.from(vs.tire_detached)} />
    </>
  )

  let body: React.ReactNode

  if (damageDetail === 'compact') {
    body = (
      <>
        {diagram}
        {hasBrakeData && (
          <>
            <Divider />
            <CompactStats brakeWear={Array.from(vs.brake_wear)} />
          </>
        )}
        {tireAlerts}
      </>
    )
  } else if (damageDetail === 'medium') {
    body = (
      <>
        {diagram}
        {(hasBrakeData || hasSuspData) && (
          <>
            <Divider />
            <SectionTitle label="Averages" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {hasBrakeData && <SectionAvgRow title="Brakes" values={Array.from(vs.brake_wear)} />}
              {hasSuspData && <SectionAvgRow title="Susp" values={Array.from(vs.suspension_damage)} />}
            </div>
          </>
        )}
        {tireAlerts}
      </>
    )
  } else {
    body = (
      <>
        {diagram}
        {hasBrakeData && (
          <>
            <Divider />
            <WheelBarsPanel title="Brake Wear" values={Array.from(vs.brake_wear)} />
          </>
        )}
        {hasSuspData && (
          <>
            <Divider />
            <WheelBarsPanel title="Suspension" values={Array.from(vs.suspension_damage)} />
          </>
        )}
        {tireAlerts}
      </>
    )
  }

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
      {body}
    </div>
  )
}
