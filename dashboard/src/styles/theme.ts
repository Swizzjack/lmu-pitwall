export const colors = {
  bg: '#0f0f0f',
  bgCard: '#1a1a1a',
  bgWidget: '#141414',
  border: '#2a2a2a',
  primary: '#facc15',   // Yellow
  accent: '#f97316',    // Orange
  text: '#e5e5e5',
  textMuted: '#737373',
  danger: '#ef4444',
  success: '#22c55e',
  info: '#3b82f6',
} as const

export const fonts = {
  heading: "'Teko', sans-serif",
  body: "'Roboto Condensed', sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const

export type ColorKey = keyof typeof colors
