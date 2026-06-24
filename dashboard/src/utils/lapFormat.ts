import { colors } from '../styles/theme'
import type { VehicleScoring } from '../types/telemetry'

// Append an alpha channel to a 6-digit hex colour, e.g. hexAlpha('#facc15', 0.15)
export function hexAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0')
  return `${hex}${a}`
}

// Sector / short time formatting — "88.888" or "---" for invalid (< 0)
export function fmtSec(s: number): string {
  return s < 0 ? '---' : s.toFixed(3)
}

// Lap time formatting — "1:28.888" or "--:--.---" for invalid (<= 0)
export function fmtLap(s: number): string {
  if (s <= 0) return '--:--.---'
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(3).padStart(6, '0')}`
}

// Signed time difference — "+1.234" or "+1:23.456" for larger gaps
export function fmtTimeDiff(diff: number): string {
  const sign = diff < 0 ? '-' : '+'
  const abs = Math.abs(diff)
  if (abs >= 60) {
    const m = Math.floor(abs / 60)
    return `${sign}${m}:${(abs - m * 60).toFixed(3).padStart(6, '0')}`
  }
  return `${sign}${abs.toFixed(3)}`
}

export const SECTOR_PB = '#22c55e'   // green — personal best in this sector
export const SECTOR_SB = '#a855f7'   // purple — session best in this sector

// Colour a sector value: purple if it matches the session best, green if it
// matches the personal best, otherwise the default text colour.
export function sectorColor(val: number, sessionBest: number, personalBest: number): string {
  if (val < 0) return colors.text
  if (isFinite(sessionBest) && Math.abs(val - sessionBest) < 0.001) return SECTOR_SB
  if (personalBest > 0 && Math.abs(val - personalBest) < 0.001) return SECTOR_PB
  return colors.text
}

// Derive individual best S2 from the cumulative best S1+S2 (-1 = invalid)
export function bestS2(v: VehicleScoring): number {
  return v.best_sector1 > 0 && v.best_sector2 > 0 ? v.best_sector2 - v.best_sector1 : -1
}

// Derive individual last S2 from the cumulative last S1+S2 (-1 = invalid)
export function lastS2(v: VehicleScoring): number {
  return v.last_sector1 > 0 && v.last_sector2 > 0 ? v.last_sector2 - v.last_sector1 : -1
}
