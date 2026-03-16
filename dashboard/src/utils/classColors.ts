export const CLASS_COLORS = {
  Hypercar: '#ef4444',
  LMGT3:    '#22c55e',
  LMP2:     '#3b82f6',
  LMP3:     '#a855f7',
} as const

export const DEFAULT_CLASS_COLOR = '#6b7280'

export function getClassColor(vc: string): string {
  const n = vc.toUpperCase().replace(/[_\s-]/g, '')
  if (n.includes('HYPER')) return CLASS_COLORS.Hypercar
  if (n.includes('GT3'))   return CLASS_COLORS.LMGT3
  if (n.includes('LMP2'))  return CLASS_COLORS.LMP2
  if (n.includes('LMP3'))  return CLASS_COLORS.LMP3
  return DEFAULT_CLASS_COLOR
}
