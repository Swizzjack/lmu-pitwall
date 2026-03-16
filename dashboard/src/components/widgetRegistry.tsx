import type { ComponentType } from 'react'
import GearIndicator from './widgets/GearIndicator'
import SpeedGauge from './widgets/SpeedGauge'
import RPMBar from './widgets/RPMBar'
import LapTiming from './widgets/LapTiming'
import TireMonitor from './widgets/TireMonitor'
import FuelManager from './widgets/FuelManager'
import InputBars from './widgets/InputBars'
import Standings from './widgets/Standings'
import SessionInfo from './widgets/SessionInfo'
import WeatherWidget from './widgets/WeatherWidget'
import ConnectionStatus from './widgets/ConnectionStatus'
import Electronics from './widgets/Electronics'
import InputDebug from './widgets/InputDebug'
import InputChart from './widgets/InputChart'
import VehicleStatus from './widgets/VehicleStatus'
import TrackMap from './widgets/TrackMap'
import LapHistory from './widgets/LapHistory'

export interface WidgetMeta {
  id: string
  name: string
  component: ComponentType
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
}

export const WIDGET_REGISTRY: Record<string, WidgetMeta> = {
  GearIndicator: {
    id: 'GearIndicator',
    name: 'Gear',
    component: GearIndicator,
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 2, h: 3 },
  },
  SpeedGauge: {
    id: 'SpeedGauge',
    name: 'Speed',
    component: SpeedGauge,
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 2, h: 3 },
  },
  RPMBar: {
    id: 'RPMBar',
    name: 'RPM',
    component: RPMBar,
    defaultSize: { w: 5, h: 2 },
    minSize: { w: 3, h: 2 },
  },
  LapTiming: {
    id: 'LapTiming',
    name: 'Lap Timing',
    component: LapTiming,
    defaultSize: { w: 5, h: 2 },
    minSize: { w: 3, h: 2 },
  },
  TireMonitor: {
    id: 'TireMonitor',
    name: 'Tires',
    component: TireMonitor,
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 2, h: 3 },
  },
  FuelManager: {
    id: 'FuelManager',
    name: 'Fuel',
    component: FuelManager,
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 2, h: 3 },
  },
  InputBars: {
    id: 'InputBars',
    name: 'Inputs',
    component: InputBars,
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 2, h: 3 },
  },
  Standings: {
    id: 'Standings',
    name: 'Standings',
    component: Standings,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 },
  },
  SessionInfo: {
    id: 'SessionInfo',
    name: 'Session Info',
    component: SessionInfo,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
  },
  WeatherWidget: {
    id: 'WeatherWidget',
    name: 'Weather',
    component: WeatherWidget,
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  ConnectionStatus: {
    id: 'ConnectionStatus',
    name: 'Connection',
    component: ConnectionStatus,
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  Electronics: {
    id: 'Electronics',
    name: 'Electronics',
    component: Electronics,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  InputDebug: {
    id: 'InputDebug',
    name: 'Input Debug',
    component: InputDebug,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  InputChart: {
    id: 'InputChart',
    name: 'Input Chart',
    component: InputChart,
    defaultSize: { w: 6, h: 6 },
    minSize: { w: 3, h: 3 },
  },
  VehicleStatus: {
    id: 'VehicleStatus',
    name: 'Vehicle Status',
    component: VehicleStatus,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  TrackMap: {
    id: 'TrackMap',
    name: 'Track Map',
    component: TrackMap,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  LapHistory: {
    id: 'LapHistory',
    name: 'Lap History',
    component: LapHistory,
    defaultSize: { w: 5, h: 4 },
    minSize: { w: 4, h: 3 },
  },
}
