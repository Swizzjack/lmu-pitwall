// ---------------------------------------------------------------------------
// Shared damage constants and helpers
// rF2/LMU mDentSeverity[8] zone order:
// 0=front, 1=front-left, 2=left, 3=right, 4=rear-left, 5=rear-right, 6=rear, 7=front-right
// ---------------------------------------------------------------------------

/** Maps severity code (0, 1, 2) to percentage contribution */
export const SEV_PCT = [0, 50, 100] as const

/** Zone layout for a 3×3 CSS grid (top-down car view) */
export const DAMAGE_ZONES = [
  { idx: 1, label: 'F-L',   col: 1, row: 1 },
  { idx: 0, label: 'FRONT', col: 2, row: 1 },
  { idx: 7, label: 'F-R',   col: 3, row: 1 },
  { idx: 2, label: 'LEFT',  col: 1, row: 2 },
  { idx: 3, label: 'RIGHT', col: 3, row: 2 },
  { idx: 4, label: 'R-L',   col: 1, row: 3 },
  { idx: 6, label: 'REAR',  col: 2, row: 3 },
  { idx: 5, label: 'R-R',   col: 3, row: 3 },
] as const

/** Returns overall damage percentage (0–100) from a dent severity array */
export function dentPct(dent: readonly number[]): number {
  const sum = dent.reduce((s, v) => s + (SEV_PCT[v] ?? 0), 0)
  return Math.round(sum / (dent.length * 100) * 100)
}
