import { useSettingsStore } from '../stores/settingsStore'

function resolveTarget(): string {
  const { wsHost, wsPort } = useSettingsStore.getState()
  const host = wsHost.trim() || window.location.hostname
  // Auto follows the page's port, including the default HTTP(S) port.
  const port = wsPort > 0 ? String(wsPort) : window.location.port
  return port ? `${host}:${port}` : host
}

export function bridgeWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${resolveTarget()}`
}

export function bridgeHttpBase(): string {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  return `${protocol}//${resolveTarget()}`
}
