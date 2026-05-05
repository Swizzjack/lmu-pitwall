import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ResponsiveLayouts } from 'react-grid-layout'

export interface WidgetConfig {
  id: string
  widgetType: string
}

export const SCALE_MIN = 0.5
export const SCALE_MAX = 3.0
export const SCALE_STEP = 0.1
export const SCALE_DEFAULT = 1.0

export interface LayoutPreset {
  name: string
  layouts: ResponsiveLayouts
  widgets: WidgetConfig[]
}

// ---------------------------------------------------------------------------
// Default presets
// ---------------------------------------------------------------------------

const RACE_WIDGETS: WidgetConfig[] = [
  { id: 'gear-1',       widgetType: 'GearIndicator' },
  { id: 'speed-1',      widgetType: 'SpeedGauge' },
  { id: 'rpm-1',        widgetType: 'RPMBar' },
  { id: 'lap-1',        widgetType: 'LapTiming' },
  { id: 'tire-1',       widgetType: 'TireMonitor' },
  { id: 'fuel-1',       widgetType: 'FuelManager' },
  { id: 'input-1',      widgetType: 'InputBars' },
  { id: 'standings-1',  widgetType: 'Standings' },
  { id: 'session-1',    widgetType: 'SessionInfo' },
  { id: 'weather-1',    widgetType: 'WeatherWidget' },
  { id: 'connection-1', widgetType: 'ConnectionStatus' },
]

const RACE_LG = [
  { i: 'gear-1',       x: 0,  y: 0, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'speed-1',      x: 2,  y: 0, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'rpm-1',        x: 5,  y: 0, w: 5, h: 2, minW: 3, minH: 2 },
  { i: 'lap-1',        x: 5,  y: 2, w: 5, h: 2, minW: 3, minH: 2 },
  { i: 'tire-1',       x: 10, y: 0, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'fuel-1',       x: 0,  y: 4, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'input-1',      x: 3,  y: 4, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'standings-1',  x: 6,  y: 4, w: 6, h: 4, minW: 4, minH: 3 },
  { i: 'session-1',    x: 0,  y: 8, w: 4, h: 3, minW: 3, minH: 2 },
  { i: 'weather-1',    x: 4,  y: 8, w: 3, h: 3, minW: 2, minH: 2 },
  { i: 'connection-1', x: 7,  y: 8, w: 3, h: 3, minW: 2, minH: 2 },
]

const QUALIFYING_WIDGETS: WidgetConfig[] = [
  { id: 'gear-1',    widgetType: 'GearIndicator' },
  { id: 'speed-1',   widgetType: 'SpeedGauge' },
  { id: 'rpm-1',     widgetType: 'RPMBar' },
  { id: 'lap-1',     widgetType: 'LapTiming' },
  { id: 'input-1',   widgetType: 'InputBars' },
  { id: 'session-1', widgetType: 'SessionInfo' },
  { id: 'weather-1', widgetType: 'WeatherWidget' },
]

const QUALIFYING_LG = [
  { i: 'gear-1',    x: 0,  y: 0, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'speed-1',   x: 2,  y: 0, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'rpm-1',     x: 5,  y: 0, w: 7, h: 2, minW: 3, minH: 2 },
  { i: 'lap-1',     x: 5,  y: 2, w: 4, h: 4, minW: 3, minH: 2 },
  { i: 'input-1',   x: 9,  y: 2, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'session-1', x: 0,  y: 4, w: 4, h: 3, minW: 3, minH: 2 },
  { i: 'weather-1', x: 4,  y: 4, w: 3, h: 3, minW: 2, minH: 2 },
]

const COMPACT_WIDGETS: WidgetConfig[] = [
  { id: 'gear-1', widgetType: 'GearIndicator' },
  { id: 'speed-1', widgetType: 'SpeedGauge' },
  { id: 'rpm-1', widgetType: 'RPMBar' },
  { id: 'lap-1', widgetType: 'LapTiming' },
]

const COMPACT_LG = [
  { i: 'gear-1',  x: 0,  y: 0, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'speed-1', x: 2,  y: 0, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'rpm-1',   x: 5,  y: 0, w: 7, h: 2, minW: 3, minH: 2 },
  { i: 'lap-1',   x: 5,  y: 2, w: 7, h: 4, minW: 3, minH: 2 },
]

// Endurance: Fuel + Tires + Standings + Weather + Session info focus
const ENDURANCE_WIDGETS: WidgetConfig[] = [
  { id: 'gear-1',       widgetType: 'GearIndicator' },
  { id: 'speed-1',      widgetType: 'SpeedGauge' },
  { id: 'rpm-1',        widgetType: 'RPMBar' },
  { id: 'fuel-1',       widgetType: 'FuelManager' },
  { id: 'tire-1',       widgetType: 'TireMonitor' },
  { id: 'standings-1',  widgetType: 'Standings' },
  { id: 'weather-1',    widgetType: 'WeatherWidget' },
  { id: 'session-1',    widgetType: 'SessionInfo' },
  { id: 'lap-1',        widgetType: 'LapTiming' },
]

const ENDURANCE_LG = [
  { i: 'gear-1',       x: 0,  y: 0, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'speed-1',      x: 2,  y: 0, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'rpm-1',        x: 5,  y: 0, w: 7, h: 2, minW: 3, minH: 2 },
  { i: 'lap-1',        x: 5,  y: 2, w: 7, h: 2, minW: 3, minH: 2 },
  { i: 'fuel-1',       x: 0,  y: 4, w: 3, h: 5, minW: 2, minH: 3 },
  { i: 'tire-1',       x: 3,  y: 4, w: 3, h: 5, minW: 2, minH: 3 },
  { i: 'standings-1',  x: 6,  y: 4, w: 6, h: 5, minW: 4, minH: 3 },
  { i: 'session-1',    x: 0,  y: 9, w: 5, h: 3, minW: 3, minH: 2 },
  { i: 'weather-1',    x: 5,  y: 9, w: 3, h: 3, minW: 2, minH: 2 },
]

// Stream: minimal — Gear, Speed, RPM, Lap for overlay/stream use
const STREAM_WIDGETS: WidgetConfig[] = [
  { id: 'gear-1',  widgetType: 'GearIndicator' },
  { id: 'speed-1', widgetType: 'SpeedGauge' },
  { id: 'rpm-1',   widgetType: 'RPMBar' },
  { id: 'input-1', widgetType: 'InputBars' },
]

const STREAM_LG = [
  { i: 'gear-1',  x: 0, y: 0, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'speed-1', x: 2, y: 0, w: 3, h: 4, minW: 2, minH: 3 },
  { i: 'rpm-1',   x: 5, y: 0, w: 4, h: 2, minW: 3, minH: 2 },
  { i: 'input-1', x: 5, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
]

export const LAYOUT_PRESETS: Record<string, LayoutPreset> = {
  Race: {
    name: 'Race',
    widgets: RACE_WIDGETS,
    layouts: { lg: RACE_LG },
  },
  Qualifying: {
    name: 'Qualifying',
    widgets: QUALIFYING_WIDGETS,
    layouts: { lg: QUALIFYING_LG },
  },
  Endurance: {
    name: 'Endurance',
    widgets: ENDURANCE_WIDGETS,
    layouts: { lg: ENDURANCE_LG },
  },
  Compact: {
    name: 'Compact',
    widgets: COMPACT_WIDGETS,
    layouts: { lg: COMPACT_LG },
  },
  Stream: {
    name: 'Stream',
    widgets: STREAM_WIDGETS,
    layouts: { lg: STREAM_LG },
  },
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface LayoutStore {
  activePreset: string
  layouts: ResponsiveLayouts
  widgets: WidgetConfig[]
  scales: Record<string, number>
  presetScales: Record<string, Record<string, number>>
  presetLayouts: Record<string, ResponsiveLayouts>
  presetWidgets: Record<string, WidgetConfig[]>
  locked: boolean

  setLayouts: (layouts: ResponsiveLayouts) => void
  setPreset: (presetName: string) => void
  resetToDefault: () => void
  toggleLock: () => void
  addWidget: (widgetType: string) => void
  removeWidget: (id: string) => void
  setScale: (id: string, scale: number) => void
  exportLayout: () => string
  importLayout: (json: string) => void
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      activePreset: 'Race',
      layouts: LAYOUT_PRESETS.Race.layouts,
      widgets: LAYOUT_PRESETS.Race.widgets,
      scales: {},
      presetScales: {},
      presetLayouts: {},
      presetWidgets: {},
      locked: false,

      setLayouts: (layouts) => set({ layouts }),

      setPreset: (presetName) => {
        const preset = LAYOUT_PRESETS[presetName]
        if (!preset) return
        set((s) => ({
          activePreset: presetName,
          layouts: s.presetLayouts[presetName] ?? preset.layouts,
          widgets: s.presetWidgets[presetName] ?? preset.widgets,
          scales: s.presetScales[presetName] ?? {},
          presetScales: { ...s.presetScales, [s.activePreset]: s.scales },
          presetLayouts: { ...s.presetLayouts, [s.activePreset]: s.layouts },
          presetWidgets: { ...s.presetWidgets, [s.activePreset]: s.widgets },
        }))
      },

      resetToDefault: () => {
        const preset = LAYOUT_PRESETS[get().activePreset] ?? LAYOUT_PRESETS.Race
        set((s) => ({
          layouts: preset.layouts,
          widgets: preset.widgets,
          scales: {},
          presetScales: { ...s.presetScales, [s.activePreset]: {} },
          presetLayouts: { ...s.presetLayouts, [s.activePreset]: preset.layouts },
          presetWidgets: { ...s.presetWidgets, [s.activePreset]: preset.widgets },
        }))
      },

      toggleLock: () => set((s) => ({ locked: !s.locked })),

      addWidget: (widgetType) => {
        const id = `${widgetType.toLowerCase()}-${Date.now()}`
        const newItem = { i: id, x: 0, y: Infinity, w: 3, h: 4, minW: 2, minH: 2 }
        set((s) => ({
          widgets: [...s.widgets, { id, widgetType }],
          layouts: {
            ...s.layouts,
            lg: [...(s.layouts.lg ?? []), newItem],
          },
        }))
      },

      removeWidget: (id) => {
        set((s) => {
          const { [id]: _removed, ...remainingScales } = s.scales
          return {
            widgets: s.widgets.filter((w) => w.id !== id),
            scales: remainingScales,
            layouts: Object.fromEntries(
              Object.entries(s.layouts).map(([bp, items]) => [bp, (items ?? []).filter((item) => item.i !== id)])
            ) as unknown as ResponsiveLayouts,
          }
        })
      },

      setScale: (id, scale) => {
        const clamped = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)) * 10) / 10
        set((s) => {
          const newScales = { ...s.scales, [id]: clamped }
          return {
            scales: newScales,
            presetScales: { ...s.presetScales, [s.activePreset]: newScales },
          }
        })
      },

      exportLayout: () => {
        const { layouts, widgets, scales, activePreset } = get()
        return JSON.stringify({ layouts, widgets, scales, activePreset }, null, 2)
      },

      importLayout: (json) => {
        try {
          const data = JSON.parse(json)
          if (data.layouts && data.widgets) {
            set({
              layouts: data.layouts,
              widgets: data.widgets,
              scales: data.scales ?? {},
              activePreset: data.activePreset ?? 'Custom',
            })
          }
        } catch {
          // invalid JSON, ignore
        }
      },
    }),
    { name: 'lmu-layout-store' }
  )
)
