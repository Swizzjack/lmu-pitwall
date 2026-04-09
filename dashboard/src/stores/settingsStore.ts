import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SpeedUnit = 'kmh' | 'mph'
export type TempUnit = 'celsius' | 'fahrenheit'
export type PressureUnit = 'bar' | 'psi'
export type FuelUnit = 'liters' | 'gallons'
export type FpsLimit = 0 | 30 | 60
export type ClockFormat = '12h' | '24h'

export interface SettingsState {
  speedUnit: SpeedUnit
  tempUnit: TempUnit
  pressureUnit: PressureUnit
  fuelUnit: FuelUnit
  lapReserve: number   // extra laps of fuel added to refuel estimate (e.g. 0.5)
  wsHost: string       // empty = auto (window.location.hostname)
  wsPort: number
  primaryColor: string
  accentColor: string
  fpsLimit: FpsLimit
  fullscreen: boolean
  // Time Widget
  timeWidgetShowComputerTime: boolean
  timeWidgetClockFormat: ClockFormat
  timeWidgetShowSessionElapsed: boolean
  timeWidgetShowTimeRemaining: boolean
  timeWidgetShowCurrentLap: boolean
  // Standings Widget
  standingsShowCompound: boolean
  standingsShowCarType: boolean
  standingsShowVE: boolean
  // Post Race Results
  resultsPath: string
}

interface SettingsStore extends SettingsState {
  update: (partial: Partial<SettingsState>) => void
  reset: () => void
  exportSettings: () => string
  importSettings: (json: string) => boolean
  // Unit helpers
  toDisplaySpeed: (kmh: number) => number
  speedUnitLabel: () => string
  toDisplayTemp: (celsius: number) => number
  tempUnitLabel: () => string
  toDisplayPressure: (bar: number) => number
  pressureUnitLabel: () => string
  toDisplayFuel: (liters: number) => number
  fuelUnitLabel: () => string
}

export const SETTINGS_DEFAULTS: SettingsState = {
  speedUnit: 'kmh',
  tempUnit: 'celsius',
  pressureUnit: 'bar',
  fuelUnit: 'liters',
  lapReserve: 0.5,
  wsHost: '',
  wsPort: 9000,
  primaryColor: '#facc15',
  accentColor: '#f97316',
  fpsLimit: 0,
  fullscreen: false,
  // Time Widget
  timeWidgetShowComputerTime: true,
  timeWidgetClockFormat: '24h',
  timeWidgetShowSessionElapsed: true,
  timeWidgetShowTimeRemaining: true,
  timeWidgetShowCurrentLap: false,
  // Standings Widget
  standingsShowCompound: true,
  standingsShowCarType: true,
  standingsShowVE: true,
  // Post Race Results
  resultsPath: '',
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...SETTINGS_DEFAULTS,

      update: (partial) => set(partial),

      reset: () => set(SETTINGS_DEFAULTS),

      exportSettings: () => {
        const { speedUnit, tempUnit, pressureUnit, fuelUnit, lapReserve, wsHost, wsPort, primaryColor, accentColor, fpsLimit,
          timeWidgetShowComputerTime, timeWidgetClockFormat, timeWidgetShowSessionElapsed, timeWidgetShowTimeRemaining, timeWidgetShowCurrentLap,
          standingsShowCompound, standingsShowCarType, standingsShowVE, resultsPath } = get()
        return JSON.stringify({ speedUnit, tempUnit, pressureUnit, fuelUnit, lapReserve, wsHost, wsPort, primaryColor, accentColor, fpsLimit,
          timeWidgetShowComputerTime, timeWidgetClockFormat, timeWidgetShowSessionElapsed, timeWidgetShowTimeRemaining, timeWidgetShowCurrentLap,
          standingsShowCompound, standingsShowCarType, standingsShowVE, resultsPath }, null, 2)
      },

      importSettings: (json) => {
        try {
          const data = JSON.parse(json) as Partial<SettingsState>
          const valid: Partial<SettingsState> = {}
          if (data.speedUnit === 'kmh' || data.speedUnit === 'mph') valid.speedUnit = data.speedUnit
          if (data.tempUnit === 'celsius' || data.tempUnit === 'fahrenheit') valid.tempUnit = data.tempUnit
          if (data.pressureUnit === 'bar' || data.pressureUnit === 'psi') valid.pressureUnit = data.pressureUnit
          if (data.fuelUnit === 'liters' || data.fuelUnit === 'gallons') valid.fuelUnit = data.fuelUnit
          if (typeof data.lapReserve === 'number' && data.lapReserve >= 0 && data.lapReserve <= 5) valid.lapReserve = data.lapReserve
          if (typeof data.wsHost === 'string') valid.wsHost = data.wsHost
          if (typeof data.wsPort === 'number' && data.wsPort > 0 && data.wsPort < 65536) valid.wsPort = data.wsPort
          if (typeof data.primaryColor === 'string') valid.primaryColor = data.primaryColor
          if (typeof data.accentColor === 'string') valid.accentColor = data.accentColor
          if (data.fpsLimit === 0 || data.fpsLimit === 30 || data.fpsLimit === 60) valid.fpsLimit = data.fpsLimit
          if (typeof data.timeWidgetShowComputerTime === 'boolean') valid.timeWidgetShowComputerTime = data.timeWidgetShowComputerTime
          if (data.timeWidgetClockFormat === '12h' || data.timeWidgetClockFormat === '24h') valid.timeWidgetClockFormat = data.timeWidgetClockFormat
          if (typeof data.timeWidgetShowSessionElapsed === 'boolean') valid.timeWidgetShowSessionElapsed = data.timeWidgetShowSessionElapsed
          if (typeof data.timeWidgetShowTimeRemaining === 'boolean') valid.timeWidgetShowTimeRemaining = data.timeWidgetShowTimeRemaining
          if (typeof data.timeWidgetShowCurrentLap === 'boolean') valid.timeWidgetShowCurrentLap = data.timeWidgetShowCurrentLap
          if (typeof data.standingsShowCompound === 'boolean') valid.standingsShowCompound = data.standingsShowCompound
          if (typeof data.standingsShowCarType === 'boolean') valid.standingsShowCarType = data.standingsShowCarType
          if (typeof data.standingsShowVE === 'boolean') valid.standingsShowVE = data.standingsShowVE
          if (typeof data.resultsPath === 'string') valid.resultsPath = data.resultsPath
          set(valid)
          return true
        } catch {
          return false
        }
      },

      toDisplaySpeed: (kmh) => get().speedUnit === 'mph' ? kmh * 0.621371 : kmh,
      speedUnitLabel: () => get().speedUnit === 'mph' ? 'mph' : 'km/h',
      toDisplayTemp: (celsius) => get().tempUnit === 'fahrenheit' ? celsius * 9 / 5 + 32 : celsius,
      tempUnitLabel: () => get().tempUnit === 'fahrenheit' ? '°F' : '°C',
      toDisplayPressure: (bar) => get().pressureUnit === 'psi' ? bar * 14.5038 : bar,
      pressureUnitLabel: () => get().pressureUnit === 'psi' ? 'psi' : 'bar',
      toDisplayFuel: (liters) => get().fuelUnit === 'gallons' ? liters * 0.264172 : liters,
      fuelUnitLabel: () => get().fuelUnit === 'gallons' ? 'gal' : 'L',
    }),
    { name: 'lmu-settings-store' }
  )
)
