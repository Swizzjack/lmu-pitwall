import { useEffect, useRef, useCallback } from 'react'
import { decode } from '@msgpack/msgpack'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { ServerMessage } from '../types/telemetry'

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting'

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000
const JITTER_MS = 500

function buildWsUrl(): string {
  const { wsHost, wsPort } = useSettingsStore.getState()
  const host = wsHost.trim() || window.location.hostname
  return `ws://${host}:${wsPort}`
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const setConnection = useTelemetryStore((s) => s.setConnection)
  const applyMessage = useTelemetryStore((s) => s.applyMessage)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const url = buildWsUrl()
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return }
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
      } catch {
        // Malformed message — ignore
      }
    }

    ws.onerror = () => {
      // onclose will fire immediately after, handle reconnect there
    }

    ws.onclose = () => {
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
  }, [setConnection, applyMessage])

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
