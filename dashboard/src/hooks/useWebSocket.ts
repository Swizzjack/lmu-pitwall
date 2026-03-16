import { useEffect, useRef, useCallback } from 'react'
import { decode } from '@msgpack/msgpack'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useElectronicsConfigStore } from '../stores/electronicsConfigStore'
import type { ServerMessage, ClientCommand } from '../types/telemetry'

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting'

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000
const JITTER_MS = 500

function buildWsUrl(): string {
  const { wsHost, wsPort } = useSettingsStore.getState()
  const host = wsHost.trim() || window.location.hostname
  return `ws://${host}:${wsPort}`
}

// Module-level WebSocket reference for sendWsCommand (used by stores/components
// that cannot use hooks). Set when connected, cleared on close.
let _globalWs: WebSocket | null = null

export function sendWsCommand(cmd: ClientCommand): void {
  if (_globalWs?.readyState === WebSocket.OPEN) {
    _globalWs.send(JSON.stringify(cmd))
  }
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const setConnection = useTelemetryStore((s) => s.setConnection)
  const applyMessage = useTelemetryStore((s) => s.applyMessage)
  const applyConfigMessage = useElectronicsConfigStore((s) => s.applyMessage)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const url = buildWsUrl()
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return }
      _globalWs = ws
      reconnectAttemptRef.current = 0
      setConnection('connected')
    }

    ws.onmessage = (event) => {
      if (!mountedRef.current) return
      try {
        let msg: ServerMessage
        if (event.data instanceof ArrayBuffer) {
          // Binary frame → MessagePack
          msg = decode(new Uint8Array(event.data)) as ServerMessage
        } else {
          // Text frame → JSON fallback (debug mode)
          msg = JSON.parse(event.data as string) as ServerMessage
        }
        applyMessage(msg)
        applyConfigMessage(msg)
      } catch {
        // Malformed message — ignore
      }
    }

    ws.onerror = () => {
      // onclose will fire immediately after, handle reconnect there
    }

    ws.onclose = () => {
      if (wsRef.current === ws) _globalWs = null
      if (!mountedRef.current) return
      wsRef.current = null
      reconnectAttemptRef.current += 1
      const attempt = reconnectAttemptRef.current

      // Exponential backoff: 1s, 2s, 4s, 8s, …, max 30s + jitter
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
        + Math.random() * JITTER_MS

      setConnection(attempt === 1 ? 'disconnected' : 'reconnecting')

      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return
        setConnection('reconnecting')
        connect()
      }, delay)
    }
  }, [setConnection, applyMessage, applyConfigMessage])

  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null  // prevent reconnect on unmount
        wsRef.current.close()
      }
    }
  }, [connect])
}
