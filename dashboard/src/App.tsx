import { useEffect, useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { colors } from './styles/theme'
import Toolbar from './components/Toolbar'
import WidgetGrid from './components/WidgetGrid'
import Settings from './components/Settings'
import PostRaceResults from './components/PostRaceResults'
import FuelCalculator from './components/FuelCalculator'
import RaceEngineerPage from './features/race-engineer/RaceEngineerPage'
import { engineerService } from './features/race-engineer/audio/AudioEngineerService'
import { useEngineerSettingsStore } from './features/race-engineer/state/engineerSettings'
import { useSettingsStore } from './stores/settingsStore'

export default function App() {
  useWebSocket()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [fuelOpen, setFuelOpen] = useState(false)
  const [engineerOpen, setEngineerOpen] = useState(false)
  const updateSettings = useSettingsStore((s) => s.update)

  // Initialize global audio service and sync persisted settings
  useEffect(() => {
    engineerService.init()
    const { enabled, volume, radioEffect, outputDeviceId } = useEngineerSettingsStore.getState()
    engineerService.setEnabled(enabled)
    engineerService.setVolume(volume)
    engineerService.setRadioEffect(radioEffect)
    engineerService.setOutputDevice(outputDeviceId)
    return () => engineerService.destroy()
  }, [])

  // Restore fullscreen on mount
  useEffect(() => {
    if (useSettingsStore.getState().fullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [])

  // Sync fullscreen state to store on any change
  useEffect(() => {
    const handler = () => {
      updateSettings({ fullscreen: !!document.fullscreenElement })
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [updateSettings])

  // F11 fullscreen shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {})
        } else {
          document.exitFullscreen().catch(() => {})
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: colors.bg,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenResults={() => { setFuelOpen(false); setEngineerOpen(false); setResultsOpen(v => !v) }}
        onOpenFuel={() => { setResultsOpen(false); setEngineerOpen(false); setFuelOpen(v => !v) }}
        onOpenEngineer={() => { setResultsOpen(false); setFuelOpen(false); setEngineerOpen(v => !v) }}
        resultsOpen={resultsOpen}
        fuelOpen={fuelOpen}
        engineerOpen={engineerOpen}
      />
      {resultsOpen
        ? <PostRaceResults onClose={() => setResultsOpen(false)} />
        : fuelOpen
          ? <FuelCalculator onClose={() => setFuelOpen(false)} />
          : engineerOpen
            ? <RaceEngineerPage onClose={() => setEngineerOpen(false)} />
            : <WidgetGrid />
      }
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
