import { useTelemetryStore } from '../../stores/telemetryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { colors, fonts } from '../../styles/theme'

// ---------------------------------------------------------------------------
// Sector classification (relative bearing in [-180, 180])
// ---------------------------------------------------------------------------

type WindSector = 'headwind' | 'crosswind' | 'tailwind' | 'calm' | 'nodata'

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 540) % 360 - 180
}

function classifySector(relDeg: number | null | undefined, speedMs: number | null | undefined): WindSector {
  if (speedMs == null || relDeg == null) return 'nodata'
  if (speedMs < 0.1) return 'calm'
  const abs = Math.abs(relDeg)
  if (abs <= 45)  return 'headwind'
  if (abs >= 135) return 'tailwind'
  return 'crosswind'
}

const SECTOR_CFG: Record<WindSector, { label: string; color: string }> = {
  headwind:  { label: 'HEADWIND',  color: colors.danger },
  crosswind: { label: 'CROSSWIND', color: colors.info },
  tailwind:  { label: 'TAILWIND',  color: colors.success },
  calm:      { label: 'CALM',      color: colors.textMuted },
  nodata:    { label: '–',         color: colors.textMuted },
}

// ---------------------------------------------------------------------------
// Compass SVG
// ---------------------------------------------------------------------------

const CX = 100
const CY = 100
const R  = 68

// Cardinal labels at their world bearings (degrees, clockwise from N).
// The entire rotating group is offset by -heading so that the label at
// bearing H lands at the top (screen 0°) when the car faces H.
const CARDINALS = [
  { label: 'N', bearing: 0 },
  { label: 'E', bearing: 90 },
  { label: 'S', bearing: 180 },
  { label: 'W', bearing: 270 },
]

function CompassRose({
  heading,
  windFromDeg,
  sector,
}: {
  heading: number
  windFromDeg: number | undefined
  sector: WindSector
}) {
  const arrowColor = SECTOR_CFG[sector].color
  const showArrow  = sector === 'headwind' || sector === 'crosswind' || sector === 'tailwind'

  // 8 tick marks at 45° increments (world-absolute; rendered inside the rotating group)
  const ticks = [0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
    const isCardinal = deg % 90 === 0
    // Place tick by trig inside the group (group itself handles world→screen rotation)
    const rad   = (deg - 90) * (Math.PI / 180)
    const inner = R - (isCardinal ? 8 : 4)
    const outer = R + (isCardinal ? 4 : 2)
    return { deg, rad, inner, outer, isCardinal }
  })

  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%' }}>

      {/* ---- Rotating world-frame group: ring, ticks, labels, wind arrow ---- */}
      <g transform={`rotate(${-heading}, ${CX}, ${CY})`}>

        {/* Outer ring */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#2a2a2a" strokeWidth="1.5" />
        <circle cx={CX} cy={CY} r={R - 1} fill="none" stroke="#374151" strokeWidth="0.5" />

        {/* Tick marks */}
        {ticks.map(({ deg, rad, inner, outer }) => (
          <line
            key={deg}
            x1={CX + inner * Math.cos(rad)} y1={CY + inner * Math.sin(rad)}
            x2={CX + outer * Math.cos(rad)} y2={CY + outer * Math.sin(rad)}
            stroke="#4b5563" strokeWidth="1"
          />
        ))}

        {/* Cardinal labels at world bearings — sit at their absolute position in the group */}
        {CARDINALS.map(({ label, bearing }) => {
          const rad = (bearing - 90) * (Math.PI / 180)
          const dist = R + 14
          return (
            <text
              key={label}
              x={CX + dist * Math.cos(rad)}
              y={CY + dist * Math.sin(rad) + 3.5}
              textAnchor="middle"
              fontSize="9"
              fontFamily={fonts.body}
              fill="#6b7280"
              letterSpacing="0.5"
            >
              {label}
            </text>
          )
        })}

        {/* Wind arrow — inner rotate(windFromDeg) places it at the correct world bearing */}
        {showArrow && windFromDeg !== undefined && (
          <g transform={`rotate(${windFromDeg}, ${CX}, ${CY})`}>
            <line
              x1={CX} y1={CY - R - 10}
              x2={CX} y2={CY - R}
              stroke={arrowColor} strokeWidth="2.5" strokeLinecap="round"
            />
            <polygon
              points={`${CX},${CY - R + 16} ${CX - 8},${CY - R + 3} ${CX + 8},${CY - R + 3}`}
              fill={arrowColor}
            />
          </g>
        )}

      </g>
      {/* ---- End rotating group ---- */}

      {/* Car silhouette — fixed, always pointing up (car front = screen top) */}
      <g>
        <rect x={CX - 11} y={CY - 18} width={22} height={36} rx="5"
          fill="#1f2937" stroke="#4b5563" strokeWidth="1.5" />
        <rect x={CX - 8} y={CY - 10} width={16} height={16} rx="3"
          fill="#111827" stroke="#374151" strokeWidth="1" />
        <rect x={CX - 8} y={CY - 21} width={16} height={4} rx="2"
          fill="#374151" />
      </g>

      {/* Calm text */}
      {sector === 'calm' && (
        <text x={CX} y={CY - 30} textAnchor="middle" fontSize="10"
          fontFamily={fonts.mono} fill="#4b5563" letterSpacing="1">
          CALM
        </text>
      )}

    </svg>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export default function WindWidget() {
  const weather  = useTelemetryStore((s) => s.session.weather)
  const heading  = useTelemetryStore((s) => s.telemetry.heading_deg)

  const toDisplaySpeed = useSettingsStore((s) => s.toDisplaySpeed)
  const speedUnitLabel = useSettingsStore((s) => s.speedUnitLabel)

  const speedMs       = weather?.wind_speed_live
  const forecastWind  = weather?.forecast?.[0]
  const windFromOctant = forecastWind?.wind_direction   // 0=N … 7=NW, or undefined
  const windFromDeg   = windFromOctant != null ? windFromOctant * 45 : undefined

  const relDeg  = windFromDeg != null ? normalizeDeg(windFromDeg - heading) : undefined
  const sector  = classifySector(relDeg, speedMs)
  const sectorCfg = SECTOR_CFG[sector]

  const windDisplaySpeed = speedMs != null ? Math.round(toDisplaySpeed(speedMs * 3.6)) : null

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      padding: '8px 10px', gap: 6,
      boxSizing: 'border-box',
    }}>

      {/* Header */}
      <div style={{
        fontFamily: fonts.body, fontSize: 11, color: colors.textMuted,
        textTransform: 'uppercase', letterSpacing: 2, flexShrink: 0,
      }}>
        Wind Direction
      </div>

      {/* Compass rose */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <CompassRose heading={heading} windFromDeg={windFromDeg} sector={sector} />
      </div>

      {/* Footer: speed + sector badge */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div>
          <span style={{
            fontFamily: fonts.mono, fontSize: 22, fontWeight: 700,
            color: sector === 'nodata' ? '#374151' : colors.text,
            lineHeight: 1,
          }}>
            {windDisplaySpeed !== null ? windDisplaySpeed : '–'}
          </span>
          <span style={{
            fontFamily: fonts.body, fontSize: 11,
            color: colors.textMuted, marginLeft: 3,
          }}>
            {speedUnitLabel()}
          </span>
        </div>

        <div style={{
          background: `${sectorCfg.color}18`,
          border: `1px solid ${sectorCfg.color}44`,
          borderRadius: 5, padding: '3px 9px',
        }}>
          <span style={{
            fontFamily: fonts.mono, fontSize: 10,
            color: sectorCfg.color, letterSpacing: 1,
          }}>
            {sectorCfg.label}
          </span>
        </div>
      </div>

    </div>
  )
}
