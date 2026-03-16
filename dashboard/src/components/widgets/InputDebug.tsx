import { useMemo } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'
import type { ControllerDiag, InputEventDiag } from '../../types/telemetry'

function ControllerRow({ ctrl }: { ctrl: ControllerDiag }) {
  const dotColor = ctrl.connected ? colors.success : colors.danger
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15 }}>
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: dotColor,
        boxShadow: `0 0 4px ${dotColor}`,
        flexShrink: 0,
      }} />
      <span style={{ fontFamily: fonts.mono, color: colors.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        [{ctrl.index}] {ctrl.name}
      </span>
      {ctrl.button_count > 0 && (
        <span style={{ fontFamily: fonts.mono, color: colors.textMuted, fontSize: 13 }}>
          {ctrl.button_count}btn
        </span>
      )}
    </div>
  )
}

function EventRow({ ev, nowMs }: { ev: InputEventDiag; nowMs: number }) {
  const agoMs = nowMs - ev.timestamp_ms
  const agoStr = agoMs < 1000
    ? `${(agoMs / 1000).toFixed(1)}s ago`
    : `${(agoMs / 1000).toFixed(1)}s ago`
  const mappedColor = colors.primary
  return (
    <div style={{ borderBottom: `1px solid ${colors.border}`, paddingBottom: 3, marginBottom: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ fontFamily: fonts.mono, color: colors.textMuted }}>{agoStr}</span>
        <span style={{ fontFamily: fonts.mono, color: colors.textMuted }}>{ev.source}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
        <span style={{ fontFamily: fonts.mono, color: colors.text }}>{ev.input}</span>
        <span style={{ fontFamily: fonts.mono, color: mappedColor, fontSize: 13 }}>→ {ev.mapped_to}</span>
      </div>
    </div>
  )
}

export default function InputDebug() {
  const diag = useTelemetryStore((s) => s.inputDiagnostics)

  // Use bridge_start-relative timestamps; compute current bridge time from latest event
  // We use Date.now() as the "now" reference and events have bridge-relative timestamps.
  // Since we don't know bridge start time, we show timestamps relative to the most recent event.
  const nowMs = useMemo(() => {
    if (diag.recent_events.length === 0) return 0
    return diag.recent_events[diag.recent_events.length - 1].timestamp_ms
  }, [diag.recent_events])

  const noControllers = diag.controllers.length === 0

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '8px 10px',
      boxSizing: 'border-box',
      gap: 4,
      overflow: 'hidden',
    }}>
      {/* Title */}
      <div style={{
        fontFamily: fonts.heading,
        fontSize: 15,
        color: colors.primary,
        letterSpacing: 1,
        borderBottom: `1px solid ${colors.border}`,
        paddingBottom: 4,
        marginBottom: 2,
        textTransform: 'uppercase',
        flexShrink: 0,
      }}>
        Input Diagnostics
        {diag.capture_mode && (
          <span style={{ fontSize: 13, color: colors.accent, marginLeft: 8, fontFamily: fonts.body }}>
            [CAPTURE MODE]
          </span>
        )}
      </div>

      {/* Controllers */}
      <div style={{ flexShrink: 0 }}>
        <div style={{
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 3,
        }}>
          Controllers
        </div>
        {noControllers ? (
          <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted }}>
            Waiting for data…
          </div>
        ) : (
          diag.controllers.map((ctrl) => (
            <ControllerRow key={ctrl.index} ctrl={ctrl} />
          ))
        )}
      </div>

      <div style={{ borderBottom: `1px solid ${colors.border}`, margin: '3px 0', flexShrink: 0 }} />

      {/* Events */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 4,
          flexShrink: 0,
        }}>
          Live Events
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {diag.recent_events.length === 0 ? (
            <div style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted }}>
              No button presses detected yet
            </div>
          ) : (
            [...diag.recent_events].reverse().map((ev, i) => (
              <EventRow key={i} ev={ev} nowMs={nowMs} />
            ))
          )}
        </div>
      </div>

      {/* Help text */}
      {noControllers && (
        <div style={{
          flexShrink: 0,
          borderTop: `1px solid ${colors.border}`,
          paddingTop: 4,
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.textMuted,
          lineHeight: 1.4,
        }}>
          No controllers found → Check USB + config.json device_index
        </div>
      )}
      {!noControllers && diag.recent_events.length === 0 && (
        <div style={{
          flexShrink: 0,
          borderTop: `1px solid ${colors.border}`,
          paddingTop: 4,
          fontFamily: fonts.body,
          fontSize: 15,
          color: colors.textMuted,
          lineHeight: 1.4,
        }}>
          Controller found but no presses detected → Check config.json button numbers
        </div>
      )}
    </div>
  )
}
