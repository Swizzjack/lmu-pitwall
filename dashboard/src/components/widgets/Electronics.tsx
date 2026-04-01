import React, { useRef, useState, useEffect } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'

// ---------------------------------------------------------------------------
// Flash-on-change hook
// ---------------------------------------------------------------------------

function useFlash(value: number | boolean, durationMs = 300) {
  const [flashing, setFlashing] = useState(false)
  const prev = useRef(value)

  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      setFlashing(true)
      const t = setTimeout(() => setFlashing(false), durationMs)
      return () => clearTimeout(t)
    }
  }, [value, durationMs])

  return flashing
}

// ---------------------------------------------------------------------------
// Section divider with label
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="h-px flex-1 bg-neutral-700/50" />
      <span className="text-[8px] font-semibold uppercase tracking-[0.15em] text-neutral-600">
        {children}
      </span>
      <div className="h-px flex-1 bg-neutral-700/50" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Individual cell — large value, small label, de-emphasised /max
// ---------------------------------------------------------------------------

interface CellProps {
  label: string
  value: number
  max?: number
  unit?: string
  highlight?: boolean
  precision?: number
}

function Cell({ label, value, max, unit, highlight, precision = 0 }: CellProps) {
  const flash = useFlash(value)
  const bg = highlight
    ? 'bg-yellow-500/20 border-yellow-400/60'
    : flash
      ? 'bg-yellow-400/15 border-neutral-700'
      : 'bg-neutral-800/60 border-neutral-700'

  const formatted = precision > 0 ? value.toFixed(precision) : String(value)

  return (
    <div
      className={`flex flex-col items-center justify-center rounded border px-3 py-2 min-w-[52px] transition-colors duration-150 ${bg}`}
    >
      <span className="text-[9px] font-medium uppercase tracking-widest text-neutral-500 mb-0.5">
        {label}
      </span>
      <div className="flex items-baseline tabular-nums leading-none">
        <span className={`text-2xl font-bold ${highlight ? 'text-yellow-300' : 'text-yellow-400'}`}>
          {formatted}
        </span>
        {max != null && max > 0 && (
          <span className="text-xs font-medium text-neutral-600 ml-0.5">/{max}</span>
        )}
        {unit && (
          <span className="text-xs font-medium text-neutral-400 ml-0.5">{unit}</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export default function Electronics() {
  const elec = useTelemetryStore((s) => s.electronics)

  const {
    tc, tc_max, tc_cut, tc_cut_max, tc_slip, tc_slip_max,
    abs, abs_max, engine_map, engine_map_max,
    front_arb, front_arb_max, rear_arb, rear_arb_max,
    brake_bias, brake_migration, brake_migration_max,
    virtual_energy,
    tc_active, abs_active,
  } = elec

  const brakeBiasFlash = useFlash(brake_bias)

  const hasTc     = tc_max > 0 || tc_cut_max > 0 || tc_slip_max > 0
  const hasAbs    = abs_max > 0
  const hasMap    = engine_map_max > 0
  const hasArb    = front_arb_max > 0 || rear_arb_max > 0
  const hasMig    = brake_migration_max > 0
  const hasHybrid = virtual_energy > 0

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-neutral-900 p-4">

      {/* Row 1: TC / ABS (left) + MAP (right) */}
      {(hasTc || hasAbs || hasMap) && (
        <div className="flex items-start gap-4">
          {(hasTc || hasAbs) && (
            <div className="flex flex-col gap-2 flex-1">
              <SectionLabel>Traction Control</SectionLabel>
              <div className="flex gap-2">
                {tc_max > 0      && <Cell label="TC"   value={tc}      max={tc_max}      highlight={tc_active} />}
                {tc_cut_max > 0  && <Cell label="CUT"  value={tc_cut}  max={tc_cut_max} />}
                {tc_slip_max > 0 && <Cell label="SLIP" value={tc_slip} max={tc_slip_max} />}
                {abs_max > 0     && <Cell label="ABS"  value={abs}     max={abs_max}     highlight={abs_active} />}
              </div>
            </div>
          )}
          {hasMap && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Engine</SectionLabel>
              <Cell label="MAP" value={engine_map} max={engine_map_max} />
            </div>
          )}
        </div>
      )}

      {/* Row 2: Anti-Roll Bar (left) + Energy (right) */}
      {(hasArb || hasMig || hasHybrid) && (
        <div className="flex items-start gap-4">
          {hasArb && (
            <div className="flex flex-col gap-2 flex-1">
              <SectionLabel>Anti-Roll Bar</SectionLabel>
              <div className="flex gap-2">
                {front_arb_max > 0 && <Cell label="FRONT" value={front_arb} max={front_arb_max} />}
                {rear_arb_max  > 0 && <Cell label="REAR"  value={rear_arb}  max={rear_arb_max} />}
              </div>
            </div>
          )}
          {(hasMig || hasHybrid) && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Energy</SectionLabel>
              <div className="flex gap-2">
                {hasMig    && <Cell label="BMIG" value={brake_migration} max={brake_migration_max} />}
                {hasHybrid && <Cell label="VE" value={Math.round(virtual_energy * 100)} unit="%" />}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Row 4: Brake Bias — full width, most prominent item */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Brake Bias</SectionLabel>
        <div
          className={`w-full rounded border px-4 py-3 text-center transition-colors duration-150 ${
            brakeBiasFlash
              ? 'border-yellow-400/60 bg-yellow-400/10'
              : 'border-neutral-700 bg-neutral-800/60'
          }`}
        >
          <div className="flex items-baseline justify-center tabular-nums leading-none">
            <span className="text-3xl font-bold text-yellow-400">
              {brake_bias.toFixed(1)}
            </span>
            <span className="text-sm font-medium text-neutral-400 ml-1">% F</span>
          </div>
        </div>
      </div>

    </div>
  )
}
