import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

const purple = '#a855f7'

function fmtLap(s: number): string {
  if (s < 0) return '--:--.---'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`
}

function fmtSec(s: number): string {
  if (s < 0) return '-.---'
  if (s >= 60) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toFixed(3).padStart(6, '0')}`
  }
  return s.toFixed(3)
}

export default function LapHistory() {
  const lapHistory = useTelemetryStore((s) => s.lapHistory)

  // Find personal best lap time index
  let bestIdx = -1
  let bestTime = Infinity
  for (let i = 0; i < lapHistory.length; i++) {
    const t = lapHistory[i].lapTime
    if (t > 0 && t < bestTime) {
      bestTime = t
      bestIdx = i
    }
  }

  // Show newest first
  const rows = [...lapHistory].reverse()

  const colStyle: React.CSSProperties = {
    fontFamily: fonts.mono,
    fontSize: 15,
    textAlign: 'right' as const,
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '28px 1fr 1fr 1fr 1fr',
        gap: '0 4px',
        padding: '0 4px 4px',
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
      }}>
        {['Lap', 'Time', 'S1', 'S2', 'S3'].map((h) => (
          <span key={h} style={{
            fontFamily: fonts.body,
            fontSize: 13,
            color: colors.textMuted,
            letterSpacing: 1,
            textTransform: 'uppercase',
            textAlign: h === 'Lap' ? 'left' : 'right',
          }}>
            {h}
          </span>
        ))}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            fontFamily: fonts.body,
            fontSize: 15,
            color: colors.textMuted,
            letterSpacing: 1,
          }}>
            No laps yet
          </div>
        ) : (
          rows.map((entry) => {
            const origIdx = lapHistory.indexOf(entry)
            const isBest = origIdx === bestIdx
            const isOutlap = entry.lapNumber === 0
            const timeColor = isBest ? purple : colors.text

            return (
              <div
                key={entry.lapNumber}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px 1fr 1fr 1fr 1fr',
                  gap: '0 4px',
                  padding: '3px 4px',
                  borderBottom: `1px solid ${colors.border}22`,
                  background: isBest ? `${purple}10` : 'transparent',
                  alignItems: 'center',
                }}
              >
                {/* Lap number */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted }}>
                    {entry.lapNumber}
                  </span>
                  {isOutlap && (
                    <span style={{
                      fontFamily: fonts.body,
                      fontSize: 9,
                      color: colors.primary,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      background: `${colors.primary}20`,
                      borderRadius: 2,
                      padding: '0 2px',
                    }}>
                      OUT
                    </span>
                  )}
                </div>

                {/* Lap time */}
                <span style={{ ...colStyle, color: timeColor, fontWeight: isBest ? 700 : 400 }}>
                  {fmtLap(entry.lapTime)}
                </span>

                {/* S1 */}
                <span style={{ ...colStyle, color: entry.s1 > 0 ? colors.text : colors.textMuted }}>
                  {fmtSec(entry.s1)}
                </span>

                {/* S2 */}
                <span style={{ ...colStyle, color: entry.s2 > 0 ? colors.text : colors.textMuted }}>
                  {fmtSec(entry.s2)}
                </span>

                {/* S3 */}
                <span style={{ ...colStyle, color: entry.s3 > 0 ? colors.text : colors.textMuted }}>
                  {fmtSec(entry.s3)}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
