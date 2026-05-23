import { useSettingsStore } from '../stores/settingsStore'

function resolveTarget(): { host: string; port: string } {
  const { wsHost, wsPort } = useSettingsStore.getState()
  const host = wsHost.trim() || window.location.hostname
  const port = wsPort > 0 ? String(wsPort) : (window.location.port || '9000')
  return { host, port }
}

export function bridgeWsUrl(): string {
  const { host, port } = resolveTarget()
  return `ws://${host}:${port}`
}

export function bridgeHttpBase(): string {
  const { host, port } = resolveTarget()
  return `http://${host}:${port}`
}
