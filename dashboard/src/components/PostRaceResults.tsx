import React, { useState, useRef, useMemo, memo, useEffect, useCallback } from 'react'
import { decode } from '@msgpack/msgpack'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { colors, fonts } from '../styles/theme'
import { useSettingsStore } from '../stores/settingsStore'
import { getClassColor } from '../utils/classColors'

// ── Server-side types (matching bridge/src/protocol/messages.rs) ──────────────

interface PostRaceSessionMeta {
  id: number
  track_venue: string | null
  track_course: string | null
  track_event: string | null
  date_time: string | null
  session_type: string
  game_version: string | null
  race_laps: number | null
  driver_count: number
  total_laps: number
}

interface PostRaceDriverSummary {
  id: number
  name: string
  car_type: string | null
  car_class: string | null
  car_number: number | null
  team_name: string | null
  is_player: boolean
  position: number | null
  class_position: number | null
  best_lap_time: number | null
  total_laps: number | null
  pitstops: number | null
  finish_status: string | null
  gap_to_leader: number | null
  laps_behind: number | null
}

interface PostRaceEvent {
  id: number
  event_type: string
  elapsed_time: number
  elapsed_time_formatted: string
  driver_name: string | null
  target_name: string | null
  severity: number | null
  message: string | null
}

interface PostRaceEventsSummary {
  total_incidents: number
  vehicle_contacts: number
  object_contacts: number
  penalties: number
  track_limit_warnings: number
  damage_reports: number
}

interface PostRaceDriverEventSummary {
  driver_name: string
  incidents_total: number
  incidents_vehicle: number
  incidents_object: number
  avg_severity: number | null
  max_severity: number | null
  penalties: number
  track_limit_warnings: number
  track_limit_points: number | null
}

interface PostRaceLapData {
  lap_num: number
  position: number | null
  lap_time: number | null
  s1: number | null
  s2: number | null
  s3: number | null
  top_speed: number | null
  fuel_level: number | null
  fuel_used: number | null
  tw_fl: number | null
  tw_fr: number | null
  tw_rl: number | null
  tw_rr: number | null
  compound_fl: string | null
  compound_fr: string | null
  compound_rl: string | null
  compound_rr: string | null
  is_pit: boolean
  stint_number: number
  ve_level: number | null
  ve_used: number | null
  incidents: PostRaceEvent[]
}

interface PostRaceStintData {
  stint_number: number
  lap_count: number
  avg_pace: number | null
  best_lap: number | null
  worst_lap: number | null
  fuel_start: number | null
  fuel_end: number | null
  fuel_consumed: number | null
  tw_fl_start: number | null
  tw_fr_start: number | null
  tw_rl_start: number | null
  tw_rr_start: number | null
  tw_fl_end: number | null
  tw_fr_end: number | null
  tw_rl_end: number | null
  tw_rr_end: number | null
  compound: string | null
  ve_start: number | null
  ve_end: number | null
  ve_consumed: number | null
  avg_ve_per_lap: number | null
}

interface PostRaceDriverLapEntry {
  driver_id: number
  lap_time: number | null
  delta: number | null
  s1: number | null
  s2: number | null
  s3: number | null
}

interface PostRaceComparedLap {
  lap_num: number
  drivers: PostRaceDriverLapEntry[]
}

type PostRaceMsg =
  | { type: 'PostRaceSessions'; sessions: PostRaceSessionMeta[]; total_sessions: number; new_imported: number; files_found: number; import_errors: number }
  | { type: 'PostRaceSessionDetail'; session_id: number; drivers: PostRaceDriverSummary[]; has_events: boolean }
  | { type: 'PostRaceDriverLaps'; driver_id: number; laps: PostRaceLapData[] }
  | { type: 'PostRaceStintSummary'; driver_id: number; stints: PostRaceStintData[] }
  | { type: 'PostRaceCompare'; reference_driver_id: number; laps: PostRaceComparedLap[] }
  | { type: 'PostRaceEvents'; session_id: number; summary: PostRaceEventsSummary; driver_summaries: PostRaceDriverEventSummary[]; events: PostRaceEvent[] }
  | { type: 'PostRaceError'; message: string }
  | { type: 'PostRaceFunFacts'; facts: string[]; player_name: string | null }

// ── Pure helpers ───────────────────────────────────────────────────────────────

function fmtLap(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || secs <= 0 || !isFinite(secs)) return '--:--.---'
  const m = Math.floor(secs / 60)
  const s = secs - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

function fmtGap(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return '–'
  if (!isFinite(secs)) return '–'
  return `+${Math.abs(secs).toFixed(3)}s`
}

function fmtSec(v?: number | null): string {
  if (!v || v <= 0) return '–'
  return v.toFixed(3)
}

function wearColor(w: number): string {
  if (w >= 0.90) return '#22c55e'
  if (w >= 0.80) return '#facc15'
  if (w >= 0.70) return '#f97316'
  return '#ef4444'
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function parseCompound(raw: string | null | undefined): string {
  if (!raw) return '?'
  const idx = raw.indexOf(',')
  return idx >= 0 ? raw.slice(idx + 1).trim() : raw
}

// Compare driver palette — distinct, vibrant
const DRIVER_COMPARE_COLORS = [
  '#38bdf8', // sky
  '#fb7185', // rose
  '#a3e635', // lime
  '#fb923c', // orange
  '#c084fc', // purple
  '#34d399', // emerald
  '#fcd34d', // amber
  '#67e8f9', // cyan
]

function driverColor(idx: number): string {
  return DRIVER_COMPARE_COLORS[idx % DRIVER_COMPARE_COLORS.length]
}

function fmtDelta(d: number | null | undefined): string {
  if (d === null || d === undefined || !isFinite(d)) return '–'
  const sign = d > 0 ? '+' : ''
  return `${sign}${d.toFixed(3)}`
}

function deltaColor(d: number | null | undefined): string {
  if (d === null || d === undefined || !isFinite(d) || Math.abs(d) < 0.001) return colors.textMuted
  return d < 0 ? '#22c55e' : '#ef4444'
}

function finishLabel(status: string | null): { text: string; color: string } {
  if (!status || status === 'None')        return { text: '–',    color: colors.textMuted }
  if (status === 'Finished Normally')      return { text: 'FIN',  color: colors.success }
  if (status === 'DNF')                    return { text: 'DNF',  color: colors.danger }
  if (status === 'DQ')                     return { text: 'DQ',   color: colors.danger }
  return { text: status.slice(0, 4).toUpperCase(), color: colors.textMuted }
}

type SessionKind = 'Race' | 'Qualifying' | 'Practice' | 'Warmup' | string

const SESSION_COLORS: Record<string, { bg: string; text: string }> = {
  Race:        { bg: '#e11d48', text: '#fff' },
  Qualifying:  { bg: '#2563eb', text: '#fff' },
  Practice:    { bg: '#16a34a', text: '#fff' },
  Warmup:      { bg: '#d97706', text: '#fff' },
}

function sessionColors(kind: SessionKind) {
  return SESSION_COLORS[kind] ?? { bg: '#555', text: '#fff' }
}

function parseDateTime(raw: string | null): Date | null {
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    return new Date(parseInt(raw, 10) * 1000)
  }
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return d
  return null
}

function formatDateTime(raw: string | null): string {
  if (!raw) return '—'
  const d = parseDateTime(raw)
  if (!d) return raw
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`
}

function severityColor(severity: number | null): string {
  if (severity === null) return '#eab308'
  if (severity > 500) return '#ef4444'
  if (severity > 200) return '#f97316'
  return '#eab308'
}

function eventTypeIcon(type: string): string {
  switch (type) {
    case 'incident':    return '⚠'
    case 'penalty':     return '🏁'
    case 'track_limit': return '⚡'
    case 'damage':      return '🔧'
    case 'chat':        return '💬'
    default:            return '•'
  }
}

function eventRowColor(type: string, severity: number | null): string {
  if (type === 'incident')    return severityColor(severity)
  if (type === 'penalty')     return '#ef4444'
  if (type === 'track_limit') return '#eab308'
  if (type === 'damage')      return '#f97316'
  return '#555'
}

function normalizeSessionType(raw: string): string {
  const v = raw.toLowerCase()
  if (v.includes('race'))  return 'Race'
  if (v.includes('qual'))  return 'Qualifying'
  if (v.includes('prac'))  return 'Practice'
  if (v.includes('warm'))  return 'Warmup'
  return raw || 'Session'
}

// ── Visual components ──────────────────────────────────────────────────────────

function TireWearNumeric({ tires }: { tires: [number, number, number, number] }) {
  const [fl, fr, rl, rr] = tires
  const cell = (label: string, w: number): React.ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 11, color: '#555', fontFamily: 'monospace', lineHeight: 1 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: wearColor(w), fontFamily: 'monospace', lineHeight: 1 }}>
        {Math.round(w * 100)}%
      </span>
    </div>
  )
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
      {cell('FL', fl)}{cell('FR', fr)}{cell('RL', rl)}{cell('RR', rr)}
    </div>
  )
}

const COMPOUND_COLORS: Record<string, string> = {
  Soft:       '#ef4444',
  Medium:     '#facc15',
  Hard:       '#e5e7eb',
  Inter:      '#22c55e',
  Wet:        '#3b82f6',
  Hypersoft:  '#f0abfc',
  Supersoft:  '#f87171',
  Ultrasoft:  '#a78bfa',
}

function CompoundBadge({ name }: { name: string }) {
  const bg = COMPOUND_COLORS[name] ?? '#555'
  return (
    <span style={{
      background: bg + '22',
      border: `1px solid ${bg}`,
      color: bg,
      borderRadius: 3,
      padding: '1px 5px',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.3,
      whiteSpace: 'nowrap',
    }}>
      {name}
    </span>
  )
}

function SessionTypeBadge({ type }: { type: string }) {
  const { bg, text } = sessionColors(type)
  return (
    <span style={{
      background: bg,
      color: text,
      borderRadius: 4,
      padding: '2px 10px',
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: 'uppercase' as const,
      fontFamily: fonts.heading,
    }}>
      {type}
    </span>
  )
}

function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 14, color: colors.text }}>{value || '—'}</span>
    </div>
  )
}

// ── Lap detail (server data) ──────────────────────────────────────────────────

const ServerLapDetail = memo(function ServerLapDetail({
  laps,
  overallBest,
}: {
  laps: PostRaceLapData[]
  overallBest: number
}) {
  const thStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderBottom: `1px solid ${colors.border}`,
    color: colors.primary,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: 0.5,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    background: '#0e0e0e',
    position: 'sticky',
    top: 0,
  }
  const tdBase: React.CSSProperties = {
    padding: '2px 6px',
    borderBottom: `1px solid #1a1a1a`,
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  }

  const personalBest = laps.reduce((best, l) => {
    if (l.lap_time === null || l.lap_time <= 0 || l.is_pit) return best
    return best === null || l.lap_time < best ? l.lap_time : best
  }, null as number | null)

  const hasVE = laps.some(l => l.ve_level !== null)

  return (
    <div style={{ overflowX: 'auto', background: '#0e0e0e', borderTop: `1px solid ${colors.border}` }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 780 }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'right' }}>LAP</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>POS</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>TIME</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>S1</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>S2</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>S3</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>TOP km/h</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>FUEL%</th>
            {hasVE && <th style={{ ...thStyle, textAlign: 'right', color: '#a855f7' }}>VE%</th>}
            <th style={{ ...thStyle, textAlign: 'center' }}>TIRE WEAR</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>CPND</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>STINT</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>EVT</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap, idx) => {
            const isOBest = overallBest > 0 && lap.lap_time !== null && lap.lap_time === overallBest
            const isPBest = personalBest !== null && lap.lap_time !== null && lap.lap_time === personalBest && !isOBest
            const timeColor = isOBest ? '#c026d3' : isPBest ? '#22c55e' : colors.text
            const rowBg = lap.is_pit ? '#1b1a10' : idx % 2 === 0 ? '#111' : '#0e0e0e'

            const twfl = lap.tw_fl ?? 1
            const twfr = lap.tw_fr ?? 1
            const twrl = lap.tw_rl ?? 1
            const twrr = lap.tw_rr ?? 1
            const fcompound = parseCompound(lap.compound_fl)
            const fuelPct = lap.fuel_level !== null ? Math.round(lap.fuel_level * 100) : null
            const vePct = lap.ve_level !== null ? Math.round(lap.ve_level * 100) : null

            return (
              <tr key={lap.lap_num} style={{ background: rowBg }}>
                <td style={{ ...tdBase, color: colors.textMuted }}>{lap.lap_num}</td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{lap.position ?? '–'}</td>
                <td style={{ ...tdBase, color: timeColor, fontWeight: isOBest || isPBest ? 700 : 400 }}>
                  {fmtLap(lap.lap_time)}
                </td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(lap.s1)}</td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(lap.s2)}</td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(lap.s3)}</td>
                <td style={{ ...tdBase }}>
                  {lap.top_speed !== null && lap.top_speed > 0 ? lap.top_speed.toFixed(1) : '–'}
                </td>
                <td style={{ ...tdBase }}>{fuelPct !== null ? `${fuelPct}%` : '–'}</td>
                {hasVE && <td style={{ ...tdBase, color: '#a855f7' }}>{vePct !== null ? `${vePct}%` : '–'}</td>}
                <td style={{ ...tdBase, textAlign: 'center' }}>
                  <TireWearNumeric tires={[twfl, twfr, twrl, twrr]} />
                </td>
                <td style={{ ...tdBase, textAlign: 'center' }}>
                  {fcompound !== '?' ? <CompoundBadge name={fcompound} /> : '–'}
                </td>
                <td style={{ ...tdBase, textAlign: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <span style={{ color: colors.textMuted }}>{lap.stint_number}</span>
                    {lap.is_pit && (
                      <span style={{
                        background: colors.accent + '22',
                        border: `1px solid ${colors.accent}`,
                        color: colors.accent,
                        borderRadius: 3,
                        padding: '0px 4px',
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                      }}>PIT</span>
                    )}
                  </div>
                </td>
                <td style={{ ...tdBase, textAlign: 'center', minWidth: 40 }}>
                  {lap.incidents && lap.incidents.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, flexWrap: 'wrap' }}>
                      {lap.incidents.map(ev => {
                        const col = severityColor(ev.severity)
                        const tipParts = [`T+${ev.elapsed_time_formatted}`]
                        if (ev.target_name) tipParts.push(`vs. ${ev.target_name}`)
                        if (ev.severity != null) tipParts.push(`sev. ${ev.severity.toFixed(1)}`)
                        if (ev.message) tipParts.push(ev.message)
                        return (
                          <span
                            key={ev.id}
                            title={tipParts.join(' | ')}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              background: col + '22',
                              border: `1px solid ${col}`,
                              color: col,
                              borderRadius: 3,
                              padding: '0 3px',
                              fontSize: 11,
                              fontWeight: 700,
                              lineHeight: '16px',
                              cursor: 'default',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            ⚠
                            {ev.severity != null && (
                              <span style={{ fontSize: 10, marginLeft: 2, opacity: 0.9 }}>
                                {Math.round(ev.severity)}
                              </span>
                            )}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

// ── Compare: Lap-by-lap table ─────────────────────────────────────────────────

function CompareTableLaps({
  compareDriverIds,
  compareDriverInfo,
  compareResult,
}: {
  compareDriverIds: number[]
  compareDriverInfo: Map<number, PostRaceDriverSummary>
  compareResult: { reference_driver_id: number; laps: PostRaceComparedLap[] }
}) {
  const { reference_driver_id: refId, laps } = compareResult

  // Compute cumulative deltas per non-reference driver
  const cumulativeDeltas = useMemo(() => {
    const m = new Map<number, number[]>()
    for (const did of compareDriverIds) {
      if (did === refId) continue
      let cum = 0
      const arr: number[] = []
      for (const lap of laps) {
        const entry = lap.drivers.find(d => d.driver_id === did)
        if (entry?.delta != null) cum += entry.delta
        arr.push(cum)
      }
      m.set(did, arr)
    }
    return m
  }, [compareDriverIds, laps, refId])

  const thStyle: React.CSSProperties = {
    padding: '3px 6px',
    borderBottom: `1px solid ${colors.border}`,
    color: colors.primary,
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    background: '#0e0e0e',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  }
  const tdBase: React.CSSProperties = {
    padding: '2px 6px',
    borderBottom: `1px solid #1a1a1a`,
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  }

  // Per-driver personal bests
  const personalBests = useMemo(() => {
    const m = new Map<number, number>()
    for (const did of compareDriverIds) {
      let best = Infinity
      for (const lap of laps) {
        const e = lap.drivers.find(d => d.driver_id === did)
        if (e?.lap_time != null && e.lap_time > 0) best = Math.min(best, e.lap_time)
      }
      if (best < Infinity) m.set(did, best)
    }
    return m
  }, [compareDriverIds, laps])

  return (
    <div style={{ overflowX: 'auto', background: '#0e0e0e', flex: 1 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 600 }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>LAP</th>
            {compareDriverIds.map((did, i) => {
              const name = compareDriverInfo.get(did)?.name ?? `#${did}`
              const isRef = did === refId
              const color = driverColor(i)
              const colSpan = isRef ? 4 : 6
              return (
                <th
                  key={did}
                  colSpan={colSpan}
                  style={{
                    ...thStyle,
                    textAlign: 'center',
                    color,
                    borderLeft: `2px solid ${color}33`,
                    fontSize: 13,
                  }}
                >
                  {name}{isRef ? ' [REF]' : ''}
                </th>
              )
            })}
          </tr>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }} />
            {compareDriverIds.map((did, i) => {
              const isRef = did === refId
              const color = driverColor(i)
              const sub: React.ReactNode[] = [
                <th key="t" style={{ ...thStyle, borderLeft: `2px solid ${color}33`, color }}>TIME</th>,
                <th key="s1" style={{ ...thStyle }}>S1</th>,
                <th key="s2" style={{ ...thStyle }}>S2</th>,
                <th key="s3" style={{ ...thStyle }}>S3</th>,
              ]
              if (!isRef) {
                sub.push(<th key="d" style={{ ...thStyle }}>Δ</th>)
                sub.push(<th key="cd" style={{ ...thStyle }}>ΣΔ</th>)
              }
              return sub
            })}
          </tr>
        </thead>
        <tbody>
          {laps.map((lap, lapIdx) => {
            const rowBg = lapIdx % 2 === 0 ? '#111' : '#0e0e0e'
            return (
              <tr key={lap.lap_num} style={{ background: rowBg }}>
                <td style={{ ...tdBase, color: colors.textMuted, textAlign: 'left', width: 36 }}>{lap.lap_num}</td>
                {compareDriverIds.map((did, i) => {
                  const isRef = did === refId
                  const color = driverColor(i)
                  const entry = lap.drivers.find(d => d.driver_id === did)
                  const t = entry?.lap_time ?? null
                  const best = personalBests.get(did)
                  const isBest = best != null && t != null && t === best
                  const cumArr = cumulativeDeltas.get(did)
                  const cumDelta = cumArr ? cumArr[lapIdx] : null

                  return (
                    <React.Fragment key={did}>
                      <td style={{ ...tdBase, borderLeft: `2px solid ${color}33`, color: isBest ? '#22c55e' : colors.text, fontWeight: isBest ? 700 : 400 }}>
                        {fmtLap(t)}
                      </td>
                      <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(entry?.s1)}</td>
                      <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(entry?.s2)}</td>
                      <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(entry?.s3)}</td>
                      {!isRef && (
                        <>
                          <td style={{ ...tdBase, color: deltaColor(entry?.delta), fontWeight: 600 }}>
                            {fmtDelta(entry?.delta)}
                          </td>
                          <td style={{ ...tdBase, color: deltaColor(cumDelta) }}>
                            {fmtDelta(cumDelta)}
                          </td>
                        </>
                      )}
                    </React.Fragment>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Compare: Stint side-by-side ───────────────────────────────────────────────

function CompareTableStints({
  compareDriverIds,
  compareDriverInfo,
  compareStints,
}: {
  compareDriverIds: number[]
  compareDriverInfo: Map<number, PostRaceDriverSummary>
  compareStints: Map<number, PostRaceStintData[]>
}) {
  // Collect all stint numbers present across any driver
  const allStintNums = useMemo(() => {
    const s = new Set<number>()
    for (const did of compareDriverIds) {
      for (const st of (compareStints.get(did) ?? [])) {
        s.add(st.stint_number)
      }
    }
    return [...s].sort((a, b) => a - b)
  }, [compareDriverIds, compareStints])

  if (allStintNums.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: colors.textMuted, fontFamily: fonts.body }}>
        Stint-Daten werden geladen…
      </div>
    )
  }

  const statRow = (label: string, values: React.ReactNode[]) => (
    <tr key={label}>
      <td style={{ padding: '3px 8px', color: colors.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
        {label}
      </td>
      {values.map((v, i) => (
        <td key={i} style={{ padding: '3px 8px', fontFamily: fonts.mono, fontSize: 13, color: colors.text, textAlign: 'right', borderLeft: `1px solid ${colors.border}` }}>
          {v}
        </td>
      ))}
    </tr>
  )

  const tireGrid = (fl: number | null | undefined, fr: number | null | undefined, rl: number | null | undefined, rr: number | null | undefined) => {
    if (fl == null) return '—'
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px 8px', fontSize: 12 }}>
        {([['FL', fl], ['FR', fr], ['RL', rl], ['RR', rr]] as [string, number | null | undefined][]).map(([lb, v]) => (
          <span key={lb} style={{ color: v != null ? wearColor(v) : colors.textMuted }}>
            {lb}: {v != null ? `${Math.round(v * 100)}%` : '—'}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {allStintNums.map(sn => {
        const stints = compareDriverIds.map(did => compareStints.get(did)?.find(s => s.stint_number === sn) ?? null)

        return (
          <div key={sn} style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 6, overflow: 'hidden' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 100 }} />
                {compareDriverIds.map(did => <col key={did} />)}
              </colgroup>
              <thead>
                <tr style={{ background: '#0e0e0e', borderBottom: `1px solid ${colors.border}` }}>
                  <th style={{ padding: '6px 12px', fontFamily: fonts.heading, fontSize: 14, color: colors.primary, fontWeight: 700, letterSpacing: 1, textAlign: 'left' }}>
                    STINT {sn}
                  </th>
                  {compareDriverIds.map((did, i) => {
                    const color = driverColor(i)
                    const st = stints[i]
                    const compound = parseCompound(st?.compound)
                    return (
                      <th key={did} style={{ padding: '6px 12px', borderLeft: `2px solid ${color}`, textAlign: 'left' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, color, fontWeight: 700 }}>
                            {compareDriverInfo.get(did)?.name ?? `#${did}`}
                          </span>
                          {compound !== '?' && st && <CompoundBadge name={compound} />}
                          {st && <span style={{ fontSize: 12, color: colors.textMuted }}>{st.lap_count} laps</span>}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {statRow('AVG PACE', stints.map((st, i) => {
                  const ref = stints[0]
                  if (!st) return '—'
                  const delta = i > 0 && ref?.avg_pace != null && st.avg_pace != null
                    ? st.avg_pace - ref.avg_pace : null
                  return (
                    <div>
                      <div>{fmtLap(st.avg_pace)}</div>
                      {delta != null && <div style={{ fontSize: 11, color: deltaColor(delta) }}>{fmtDelta(delta)}</div>}
                    </div>
                  )
                }))}
                {statRow('BEST LAP', stints.map((st, i) => {
                  if (!st) return '—'
                  const delta = i > 0 && stints[0]?.best_lap != null && st.best_lap != null
                    ? st.best_lap - stints[0]!.best_lap! : null
                  return (
                    <div>
                      <div style={{ color: '#22c55e' }}>{fmtLap(st.best_lap)}</div>
                      {delta != null && <div style={{ fontSize: 11, color: deltaColor(delta) }}>{fmtDelta(delta)}</div>}
                    </div>
                  )
                }))}
                {statRow('FUEL', stints.map(st => {
                  if (!st || st.fuel_start == null) return '—'
                  const consumed = st.fuel_consumed != null ? `−${Math.round(st.fuel_consumed * 100)}%` : ''
                  return (
                    <div>
                      <span>{Math.round((st.fuel_start) * 100)}%</span>
                      <span style={{ color: colors.textMuted }}> → </span>
                      <span>{Math.round((st.fuel_end ?? 0) * 100)}%</span>
                      {consumed && <div style={{ fontSize: 11, color: colors.textMuted }}>{consumed}</div>}
                    </div>
                  )
                }))}
                {stints.some(st => st?.ve_start != null) && statRow('VE', stints.map(st => {
                  if (!st || st.ve_start == null) return '—'
                  const consumed = st.ve_consumed != null ? `−${(st.ve_consumed * 100).toFixed(1)}%` : ''
                  return (
                    <div style={{ color: '#a855f7' }}>
                      <span>{Math.round((st.ve_start) * 100)}%</span>
                      <span style={{ color: colors.textMuted }}> → </span>
                      <span>{Math.round((st.ve_end ?? 0) * 100)}%</span>
                      {consumed && <div style={{ fontSize: 11, color: '#a855f755' }}>{consumed}</div>}
                    </div>
                  )
                }))}
                {statRow('TIRES BEG', stints.map(st =>
                  tireGrid(st?.tw_fl_start, st?.tw_fr_start, st?.tw_rl_start, st?.tw_rr_start)
                ))}
                {statRow('TIRES END', stints.map(st =>
                  tireGrid(st?.tw_fl_end, st?.tw_fr_end, st?.tw_rl_end, st?.tw_rr_end)
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// ── Compare: Charts ───────────────────────────────────────────────────────────

function CompareCharts({
  compareDriverIds,
  compareDriverInfo,
  compareResult,
  compareLaps,
}: {
  compareDriverIds: number[]
  compareDriverInfo: Map<number, PostRaceDriverSummary>
  compareResult: { reference_driver_id: number; laps: PostRaceComparedLap[] }
  compareLaps: Map<number, PostRaceLapData[]>
}) {
  const { reference_driver_id: refId, laps } = compareResult

  // ── Lap time chart data ──
  const lapTimeData = useMemo(() => laps.map(lap => {
    const row: Record<string, number | null> = { lap: lap.lap_num }
    for (const did of compareDriverIds) {
      const e = lap.drivers.find(d => d.driver_id === did)
      const t = e?.lap_time
      row[`t_${did}`] = t != null && t > 0 ? t : null
    }
    return row
  }), [laps, compareDriverIds])

  // ── Cumulative delta data ──
  const cumDeltaData = useMemo(() => {
    const cumMap = new Map<number, number>()
    compareDriverIds.forEach(id => cumMap.set(id, 0))
    return laps.map(lap => {
      const row: Record<string, number | null> = { lap: lap.lap_num }
      row[`cd_${refId}`] = 0
      for (const did of compareDriverIds) {
        if (did === refId) continue
        const e = lap.drivers.find(d => d.driver_id === did)
        const prev = cumMap.get(did) ?? 0
        const next = e?.delta != null ? prev + e.delta : prev
        cumMap.set(did, next)
        row[`cd_${did}`] = next
      }
      return row
    })
  }, [laps, compareDriverIds, refId])

  // ── Tire wear data per driver ──
  const tireWearData = useMemo(() => {
    const data: { lap: number; [k: string]: number | null }[] = []
    const allLapNums = new Set<number>()
    for (const did of compareDriverIds) {
      for (const l of (compareLaps.get(did) ?? [])) allLapNums.add(l.lap_num)
    }
    for (const lapNum of [...allLapNums].sort((a, b) => a - b)) {
      const row: { lap: number; [k: string]: number | null } = { lap: lapNum }
      for (const did of compareDriverIds) {
        const l = compareLaps.get(did)?.find(x => x.lap_num === lapNum)
        row[`fl_${did}`] = l?.tw_fl != null ? Math.round(l.tw_fl * 100) : null
        row[`fr_${did}`] = l?.tw_fr != null ? Math.round(l.tw_fr * 100) : null
        row[`rl_${did}`] = l?.tw_rl != null ? Math.round(l.tw_rl * 100) : null
        row[`rr_${did}`] = l?.tw_rr != null ? Math.round(l.tw_rr * 100) : null
      }
      data.push(row)
    }
    return data
  }, [compareDriverIds, compareLaps])

  // ── VE data per driver ──
  const veData = useMemo(() => {
    const data: { lap: number; [k: string]: number | null }[] = []
    const allLapNums = new Set<number>()
    for (const did of compareDriverIds) {
      for (const l of (compareLaps.get(did) ?? [])) allLapNums.add(l.lap_num)
    }
    let anyVE = false
    for (const lapNum of [...allLapNums].sort((a, b) => a - b)) {
      const row: { lap: number; [k: string]: number | null } = { lap: lapNum }
      for (const did of compareDriverIds) {
        const l = compareLaps.get(did)?.find(x => x.lap_num === lapNum)
        const v = l?.ve_level != null ? Math.round(l.ve_level * 100) : null
        row[`ve_${did}`] = v
        if (v !== null) anyVE = true
      }
      data.push(row)
    }
    return anyVE ? data : []
  }, [compareDriverIds, compareLaps])

  // Collect pit laps per driver
  const pitLaps = useMemo(() => {
    const p: { lap: number; did: number }[] = []
    for (const did of compareDriverIds) {
      for (const l of (compareLaps.get(did) ?? [])) {
        if (l.is_pit) p.push({ lap: l.lap_num, did })
      }
    }
    return p
  }, [compareDriverIds, compareLaps])

  const chartStyle: React.CSSProperties = {
    background: '#0e0e0e',
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    padding: '12px 8px 4px',
    marginBottom: 12,
  }
  const chartTitle = (t: string) => (
    <div style={{ fontSize: 12, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700, marginBottom: 6, paddingLeft: 8 }}>
      {t}
    </div>
  )
  const gridProps = { stroke: '#222', strokeDasharray: '3 3' } as const
  const axisProps = { stroke: '#444', tick: { fill: '#666', fontSize: 11 } } as const

  const lapTimeTick = (v: number) => {
    if (!v) return ''
    const m = Math.floor(v / 60)
    const s = (v - m * 60).toFixed(1)
    return `${m}:${s.padStart(4, '0')}`
  }

  const lapTooltipFormatter = (v: number, name: string) => {
    const didStr = name.replace(/^t_/, '')
    const did = Number(didStr)
    const driverName = compareDriverInfo.get(did)?.name ?? `#${did}`
    return [fmtLap(v), driverName]
  }

  const deltaTooltipFormatter = (v: number, name: string) => {
    const did = Number(name.replace(/^cd_/, ''))
    const driverName = compareDriverInfo.get(did)?.name ?? `#${did}`
    return [`${fmtDelta(v)}s`, driverName]
  }

  const hasTireData = tireWearData.length > 0

  return (
    <div style={{ padding: '12px 16px', overflow: 'auto' }}>
      {/* Chart 1: Lap Times */}
      <div style={chartStyle}>
        {chartTitle('LAP TIME PROGRESSION')}
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={lapTimeData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="lap" {...axisProps} label={{ value: 'Lap', position: 'insideBottomRight', fill: '#555', fontSize: 10 }} />
            <YAxis tickFormatter={lapTimeTick} {...axisProps} width={52} domain={['auto', 'auto']} />
            <Tooltip
              formatter={lapTooltipFormatter as never}
              contentStyle={{ background: '#1a1a1a', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }}
              labelFormatter={l => `Lap ${l}`}
            />
            <Legend formatter={(v) => {
              const did = Number(v.replace(/^t_/, ''))
              return compareDriverInfo.get(did)?.name ?? `#${did}`
            }} wrapperStyle={{ fontSize: 12, color: '#999' }} />
            {pitLaps.map(({ lap, did }) => (
              <ReferenceLine key={`pit_${lap}_${did}`} x={lap} stroke={driverColor(compareDriverIds.indexOf(did))} strokeDasharray="2 6" strokeOpacity={0.4} />
            ))}
            {compareDriverIds.map((did, i) => (
              <Line
                key={did}
                dataKey={`t_${did}`}
                stroke={driverColor(i)}
                dot={false}
                strokeWidth={2}
                connectNulls={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 2: Cumulative Delta */}
      {compareDriverIds.length > 1 && (
        <div style={chartStyle}>
          {chartTitle('CUMULATIVE DELTA vs REFERENCE')}
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={cumDeltaData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="lap" {...axisProps} />
              <YAxis tickFormatter={v => `${fmtDelta(v)}s`} {...axisProps} width={52} domain={['auto', 'auto']} />
              <Tooltip
                formatter={deltaTooltipFormatter as never}
                contentStyle={{ background: '#1a1a1a', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }}
                labelFormatter={l => `Lap ${l}`}
              />
              <ReferenceLine y={0} stroke="#555" />
              {compareDriverIds.filter(id => id !== refId).map(did => (
                <Line
                  key={did}
                  dataKey={`cd_${did}`}
                  stroke={driverColor(compareDriverIds.indexOf(did))}
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Chart 3: Tire Wear */}
      {hasTireData && (
        <div style={chartStyle}>
          {chartTitle('TIRE WEAR PROGRESSION')}
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={tireWearData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="lap" {...axisProps} label={{ value: 'Lap', position: 'insideBottomRight', fill: '#555', fontSize: 10 }} />
              <YAxis domain={[(dataMin: number) => Math.max(0, Math.floor(dataMin - 5)), 100]} tickFormatter={v => `${v}%`} {...axisProps} width={44} />
              <Tooltip
                formatter={(v: unknown, name: unknown) => {
                  const pct = typeof v === 'number' ? v : Number(v)
                  const nameStr = typeof name === 'string' ? name : String(name ?? '')
                  const [pos, didStr] = nameStr.split('_')
                  const did = Number(didStr)
                  const dName = compareDriverInfo.get(did)?.name ?? `#${did}`
                  return [`${pct}%`, `${dName} ${pos.toUpperCase()}`]
                }}
                contentStyle={{ background: '#1a1a1a', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }}
                labelFormatter={l => `Lap ${l}`}
              />
              <ReferenceLine y={90} stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.3} />
              <ReferenceLine y={80} stroke="#facc15" strokeDasharray="4 4" strokeOpacity={0.3} />
              <ReferenceLine y={70} stroke="#f97316" strokeDasharray="4 4" strokeOpacity={0.3} />
              {compareDriverIds.map((did, i) => {
                const baseColor = driverColor(i)
                return (
                  <React.Fragment key={did}>
                    <Line dataKey={`fl_${did}`} stroke={baseColor} dot={false} strokeWidth={2} connectNulls name={`fl_${did}`} />
                    <Line dataKey={`fr_${did}`} stroke={baseColor} dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls name={`fr_${did}`} />
                    <Line dataKey={`rl_${did}`} stroke={baseColor} dot={false} strokeWidth={1.5} strokeDasharray="1 2" connectNulls name={`rl_${did}`} />
                    <Line dataKey={`rr_${did}`} stroke={baseColor} dot={false} strokeWidth={1} strokeDasharray="2 4" connectNulls name={`rr_${did}`} />
                  </React.Fragment>
                )
              })}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            {compareDriverIds.map((did, i) => {
              const color = driverColor(i)
              const name = compareDriverInfo.get(did)?.name ?? `#${did}`
              return (
                <div key={did} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color, fontWeight: 700 }}>{name}</span>
                  <span style={{ fontSize: 11, color: '#666' }}>— FL</span>
                  <span style={{ fontSize: 11, color: '#666' }}>╌ FR</span>
                  <span style={{ fontSize: 11, color: '#666' }}>··· RL</span>
                  <span style={{ fontSize: 11, color: '#666' }}>- RR</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!hasTireData && (
        <div style={{ textAlign: 'center', color: colors.textMuted, fontSize: 12, fontFamily: fonts.body, padding: 8 }}>
          Tire wear chart will load once lap data is available…
        </div>
      )}

      {/* Chart 4: Virtual Energy */}
      {veData.length > 0 && (
        <div style={chartStyle}>
          {chartTitle('VIRTUAL ENERGY PROGRESSION')}
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={veData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="lap" {...axisProps} label={{ value: 'Lap', position: 'insideBottomRight', fill: '#555', fontSize: 10 }} />
              <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} {...axisProps} width={44} />
              <Tooltip
                formatter={(v: unknown, name: unknown) => {
                  const pct = typeof v === 'number' ? v : Number(v)
                  const nameStr = typeof name === 'string' ? name : String(name ?? '')
                  const did = Number(nameStr.replace(/^ve_/, ''))
                  const dName = compareDriverInfo.get(did)?.name ?? `#${did}`
                  return [`${pct}%`, dName]
                }}
                contentStyle={{ background: '#1a1a1a', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }}
                labelFormatter={l => `Lap ${l}`}
              />
              {pitLaps.map(({ lap, did }) => (
                <ReferenceLine key={`pit_ve_${lap}_${did}`} x={lap} stroke={driverColor(compareDriverIds.indexOf(did))} strokeDasharray="2 6" strokeOpacity={0.3} />
              ))}
              {compareDriverIds.map((did, i) => (
                <Line
                  key={did}
                  dataKey={`ve_${did}`}
                  stroke='#a855f7'
                  strokeOpacity={0.6 + i * 0.15}
                  strokeDasharray={i === 0 ? undefined : `${4 + i * 2} ${2 + i}`}
                  dot={false}
                  strokeWidth={2}
                  connectNulls={false}
                  activeDot={{ r: 4 }}
                  name={`ve_${did}`}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            {compareDriverIds.map(did => {
              const name = compareDriverInfo.get(did)?.name ?? `#${did}`
              return (
                <span key={did} style={{ fontSize: 12, color: '#a855f7', fontWeight: 700 }}>{name}</span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Compare view wrapper ──────────────────────────────────────────────────────

function CompareView({
  compareDriverIds,
  compareDriverInfo,
  compareResult,
  compareLaps,
  compareStints,
  compareTab,
  onTabChange,
}: {
  compareDriverIds: number[]
  compareDriverInfo: Map<number, PostRaceDriverSummary>
  compareResult: { reference_driver_id: number; laps: PostRaceComparedLap[] } | null
  compareLaps: Map<number, PostRaceLapData[]>
  compareStints: Map<number, PostRaceStintData[]>
  compareTab: 'laps' | 'stints' | 'charts'
  onTabChange: (t: 'laps' | 'stints' | 'charts') => void
}) {
  const tabBtn = (tab: 'laps' | 'stints' | 'charts', label: string) => (
    <button
      key={tab}
      onClick={() => onTabChange(tab)}
      style={{
        background: compareTab === tab ? colors.primary + '22' : 'transparent',
        border: `1px solid ${compareTab === tab ? colors.primary : colors.border}`,
        color: compareTab === tab ? colors.primary : colors.textMuted,
        fontFamily: fonts.body,
        fontSize: 13,
        fontWeight: compareTab === tab ? 700 : 400,
        padding: '3px 14px',
        borderRadius: 3,
        cursor: 'pointer',
        letterSpacing: 0.5,
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Driver header strip */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        background: '#0e0e0e',
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        {compareDriverIds.map((did, i) => {
          const color = driverColor(i)
          const driver = compareDriverInfo.get(did)
          const isRef = i === 0
          return (
            <div key={did} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              background: color + '18',
              border: `1px solid ${color}55`,
              borderRadius: 4,
            }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color, fontWeight: 700 }}>
                {driver?.name ?? `#${did}`}
              </span>
              {driver?.car_class && (
                <span style={{ fontSize: 11, color: '#666' }}>{driver.car_class}</span>
              )}
              {isRef && (
                <span style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.5 }}>REF</span>
              )}
            </div>
          )
        })}
        <div style={{ flex: 1 }} />
        {tabBtn('laps', 'LAPS')}
        {tabBtn('stints', 'STINTS')}
        {tabBtn('charts', 'CHARTS')}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {!compareResult && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: colors.textMuted, fontFamily: fonts.mono, fontSize: 13 }}>
            Vergleich wird geladen…
          </div>
        )}
        {compareResult && compareTab === 'laps' && (
          <CompareTableLaps
            compareDriverIds={compareDriverIds}
            compareDriverInfo={compareDriverInfo}
            compareResult={compareResult}
          />
        )}
        {compareResult && compareTab === 'stints' && (
          <CompareTableStints
            compareDriverIds={compareDriverIds}
            compareDriverInfo={compareDriverInfo}
            compareStints={compareStints}
          />
        )}
        {compareResult && compareTab === 'charts' && (
          <CompareCharts
            compareDriverIds={compareDriverIds}
            compareDriverInfo={compareDriverInfo}
            compareResult={compareResult}
            compareLaps={compareLaps}
          />
        )}
      </div>
    </div>
  )
}

// ── Stint summary view ───────────────────────────────────────────────────────

function StintSummaryView({
  stints,
  laps,
}: {
  stints: PostRaceStintData[]
  laps: PostRaceLapData[] | null
}) {
  const lapRanges = useMemo(() => {
    const m: Record<number, { first: number; last: number }> = {}
    if (laps) {
      for (const lap of laps) {
        const sn = lap.stint_number
        if (!m[sn]) m[sn] = { first: lap.lap_num, last: lap.lap_num }
        else {
          m[sn].first = Math.min(m[sn].first, lap.lap_num)
          m[sn].last = Math.max(m[sn].last, lap.lap_num)
        }
      }
    }
    return m
  }, [laps])

  const stintStdDevs = useMemo(() => {
    const m: Record<number, number | null> = {}
    if (laps) {
      const byStint: Record<number, number[]> = {}
      for (const lap of laps) {
        if (lap.lap_time !== null && lap.lap_time > 0 && !lap.is_pit) {
          if (!byStint[lap.stint_number]) byStint[lap.stint_number] = []
          byStint[lap.stint_number].push(lap.lap_time)
        }
      }
      for (const [sn, times] of Object.entries(byStint)) {
        m[Number(sn)] = stdDev(times)
      }
    }
    return m
  }, [laps])

  const tireKeys = [
    ['tw_fl_start', 'tw_fl_end', 'FL'],
    ['tw_fr_start', 'tw_fr_end', 'FR'],
    ['tw_rl_start', 'tw_rl_end', 'RL'],
    ['tw_rr_start', 'tw_rr_end', 'RR'],
  ] as const

  if (stints.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: colors.textMuted, fontFamily: fonts.body }}>
        No stint data available
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {stints.map(stint => {
        const range = lapRanges[stint.stint_number]
        const lapRange = range
          ? range.first === range.last ? `Lap ${range.first}` : `Lap ${range.first}–${range.last}`
          : `${stint.lap_count} Lap${stint.lap_count !== 1 ? 's' : ''}`
        const compound = parseCompound(stint.compound)
        const consistency = stintStdDevs[stint.stint_number]

        return (
          <div key={stint.stint_number} style={{
            background: colors.bgCard,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            padding: '10px 14px',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: fonts.heading, fontSize: 16, fontWeight: 700, color: colors.primary, letterSpacing: 1 }}>
                STINT {stint.stint_number}
              </span>
              <span style={{ fontSize: 13, color: colors.textMuted, fontFamily: fonts.mono }}>{lapRange}</span>
              {compound !== '?' && <CompoundBadge name={compound} />}
              <span style={{ fontSize: 12, color: colors.textMuted }}>
                {stint.lap_count} Lap{stint.lap_count !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px 16px' }}>
              <div>
                <div style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700 }}>AVG PACE</div>
                <div style={{ fontSize: 14, fontFamily: fonts.mono, color: colors.text, marginTop: 2 }}>{fmtLap(stint.avg_pace)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700 }}>BEST LAP</div>
                <div style={{ fontSize: 14, fontFamily: fonts.mono, color: '#22c55e', marginTop: 2 }}>{fmtLap(stint.best_lap)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700 }}>CONSISTENCY</div>
                <div style={{ fontSize: 14, fontFamily: fonts.mono, color: colors.text, marginTop: 2 }}>
                  {consistency != null ? `±${consistency.toFixed(3)}s` : '—'}
                </div>
              </div>
              {stint.fuel_start !== null && (
                <div>
                  <div style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700 }}>FUEL</div>
                  <div style={{ fontSize: 14, fontFamily: fonts.mono, color: colors.text, marginTop: 2 }}>
                    {Math.round((stint.fuel_start ?? 0) * 100)}%
                    <span style={{ color: colors.textMuted }}> → </span>
                    {Math.round((stint.fuel_end ?? 0) * 100)}%
                  </div>
                  {stint.fuel_consumed !== null && stint.fuel_consumed > 0 && (
                    <div style={{ fontSize: 12, color: colors.textMuted }}>
                      −{Math.round(stint.fuel_consumed * 100)}%
                    </div>
                  )}
                </div>
              )}
              {stint.ve_start !== null && (
                <div>
                  <div style={{ fontSize: 11, color: '#a855f7', letterSpacing: 0.8, fontWeight: 700 }}>VE</div>
                  <div style={{ fontSize: 14, fontFamily: fonts.mono, color: '#a855f7', marginTop: 2 }}>
                    {Math.round((stint.ve_start ?? 0) * 100)}%
                    <span style={{ color: colors.textMuted }}> → </span>
                    {Math.round((stint.ve_end ?? 0) * 100)}%
                  </div>
                  {stint.ve_consumed !== null && stint.ve_consumed > 0 && (
                    <div style={{ fontSize: 12, color: '#a855f755' }}>
                      −{(stint.ve_consumed * 100).toFixed(1)}%
                      {stint.avg_ve_per_lap !== null && (
                        <span style={{ marginLeft: 6 }}>
                          ({(stint.avg_ve_per_lap * 100).toFixed(2)}%/lap)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Tire wear per wheel */}
              {stint.tw_fl_start !== null && (
                <div style={{ gridColumn: 'span 2' }}>
                  <div style={{ fontSize: 11, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700, marginBottom: 4 }}>TIRE WEAR</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 20px' }}>
                    {tireKeys.map(([startKey, endKey, label]) => {
                      const start = stint[startKey] as number | null
                      const end = stint[endKey] as number | null
                      return (
                        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ fontSize: 11, color: '#666', fontFamily: 'monospace', width: 20, flexShrink: 0 }}>{label}</span>
                          <span style={{ fontFamily: fonts.mono, fontSize: 13, color: start !== null ? wearColor(start) : colors.textMuted }}>
                            {start !== null ? `${Math.round(start * 100)}%` : '—'}
                          </span>
                          <span style={{ color: colors.textMuted, fontSize: 12 }}>→</span>
                          <span style={{ fontFamily: fonts.mono, fontSize: 13, color: end !== null ? wearColor(end) : colors.textMuted }}>
                            {end !== null ? `${Math.round(end * 100)}%` : '—'}
                          </span>
                          {start !== null && end !== null && (
                            <span style={{ fontSize: 11, color: colors.textMuted }}>
                              (−{Math.round((start - end) * 100)}%)
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Events panel ─────────────────────────────────────────────────────────────

type EventsData = {
  session_id: number
  summary: PostRaceEventsSummary
  driver_summaries: PostRaceDriverEventSummary[]
  events: PostRaceEvent[]
}

const EVENT_FILTER_OPTIONS: { key: string; label: string }[] = [
  { key: 'incident',    label: 'Incidents' },
  { key: 'penalty',     label: 'Penalties' },
  { key: 'track_limit', label: 'Track Limits' },
  { key: 'damage',      label: 'Damage' },
  { key: 'chat',        label: 'Chat' },
]

function EventsPanel({
  data,
  loading,
}: {
  data: EventsData | null
  loading: boolean
}) {
  const [evView, setEvView] = useState<'timeline' | 'drivers'>('timeline')
  const [typeFilter, setTypeFilter] = useState<Set<string>>(
    () => new Set(['incident', 'penalty', 'track_limit', 'damage'])
  )
  const [driverFilter, setDriverFilter] = useState<string | null>(null)
  const [sortCol, setSortCol] = useState<keyof PostRaceDriverEventSummary>('incidents_total')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: colors.textMuted, fontFamily: fonts.mono, fontSize: 13 }}>
        Loading events…
      </div>
    )
  }
  if (!data) return null

  const { summary, driver_summaries, events } = data

  function toggleType(key: string) {
    setTypeFilter(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const filteredEvents = events.filter(e => {
    if (!typeFilter.has(e.event_type)) return false
    if (driverFilter && e.driver_name !== driverFilter) return false
    return true
  })

  const sortedDrivers = [...driver_summaries].sort((a, b) => {
    const av = (a[sortCol] as number) ?? 0
    const bv = (b[sortCol] as number) ?? 0
    return sortDir === 'asc' ? av - bv : bv - av
  })

  function onDriverSort(col: keyof PostRaceDriverEventSummary) {
    if (col === sortCol) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  function SortDTh({ col, label, title: ttl }: { col: keyof PostRaceDriverEventSummary; label: string; title?: string }) {
    const active = sortCol === col
    return (
      <th
        onClick={() => onDriverSort(col)}
        title={ttl}
        style={{
          padding: '4px 8px',
          borderBottom: `1px solid ${colors.border}`,
          color: active ? colors.accent : colors.primary,
          fontFamily: fonts.body,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          textAlign: 'right',
          whiteSpace: 'nowrap',
          background: '#0e0e0e',
          position: 'sticky',
          top: 0,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {label}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    )
  }

  // Summary card
  const summaryCards: { label: string; value: number; color: string; title?: string }[] = [
    { label: 'Incidents', value: summary.total_incidents, color: '#ef4444' },
    { label: 'Vehicle Contact', value: summary.vehicle_contacts, color: '#f97316' },
    { label: 'Object Contact', value: summary.object_contacts, color: '#eab308' },
    { label: 'Penalties', value: summary.penalties, color: '#ef4444' },
    { label: 'Track Limits', value: summary.track_limit_warnings, color: '#eab308', title: 'warnings' },
    { label: 'Damage', value: summary.damage_reports, color: '#f97316' },
  ]

  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? colors.primary + '22' : 'transparent',
    border: `1px solid ${active ? colors.primary : colors.border}`,
    color: active ? colors.primary : colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: active ? 700 : 400,
    padding: '3px 12px',
    borderRadius: 3,
    cursor: 'pointer',
    letterSpacing: 0.5,
  })

  const thTd: React.CSSProperties = {
    padding: '4px 8px',
    borderBottom: `1px solid ${colors.border}`,
    color: colors.primary,
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    background: '#0e0e0e',
    position: 'sticky' as const,
    top: 0,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>

      {/* Summary cards */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '10px 14px',
        background: '#0a0a0a',
        borderBottom: `1px solid ${colors.border}`,
        flexWrap: 'wrap',
        flexShrink: 0,
      }}>
        {summaryCards.map(card => (
          <div key={card.label} style={{
            background: card.color + '12',
            border: `1px solid ${card.color}44`,
            borderRadius: 5,
            padding: '6px 12px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1,
            minWidth: 80,
          }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: card.color, fontFamily: fonts.mono, lineHeight: 1 }}>
              {card.value}
            </span>
            <span style={{ fontSize: 10, color: colors.textMuted, letterSpacing: 0.6, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {card.label.toUpperCase()}{card.title ? ` ${card.title.toUpperCase()}` : ''}
            </span>
          </div>
        ))}
      </div>

      {/* View toggle + filter chips */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        background: '#0c0c0c',
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        <button style={toggleBtnStyle(evView === 'timeline')} onClick={() => setEvView('timeline')}>TIMELINE</button>
        <button style={toggleBtnStyle(evView === 'drivers')} onClick={() => setEvView('drivers')}>DRIVERS</button>
        <div style={{ width: 1, height: 18, background: colors.border }} />
        {EVENT_FILTER_OPTIONS.map(opt => {
          const active = typeFilter.has(opt.key)
          const col = eventRowColor(opt.key, null)
          return (
            <button
              key={opt.key}
              onClick={() => toggleType(opt.key)}
              style={{
                background: active ? col + '22' : 'transparent',
                border: `1px solid ${active ? col : colors.border}`,
                color: active ? col : colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: active ? 700 : 400,
                padding: '2px 9px',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              {eventTypeIcon(opt.key)} {opt.label}
            </button>
          )
        })}
        {driverFilter && (
          <>
            <div style={{ width: 1, height: 18, background: colors.border }} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: colors.primary + '18',
              border: `1px solid ${colors.primary}55`,
              borderRadius: 3,
              padding: '2px 7px',
              fontSize: 11,
              color: colors.primary,
            }}>
              <span>{driverFilter}</span>
              <button
                onClick={() => setDriverFilter(null)}
                style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', padding: '0 2px', fontSize: 12, lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          </>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: colors.textMuted }}>
          {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>

        {/* Timeline */}
        {evView === 'timeline' && (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...thTd, textAlign: 'left', width: 56 }}>TIME</th>
                <th style={{ ...thTd, textAlign: 'center', width: 32 }}>TYPE</th>
                <th style={{ ...thTd, textAlign: 'left' }}>DRIVER</th>
                <th style={{ ...thTd, textAlign: 'left' }}>DETAILS</th>
                <th style={{ ...thTd, textAlign: 'right', width: 70 }}>SEVERITY</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '24px 14px', textAlign: 'center', color: colors.textMuted, fontFamily: fonts.body, fontSize: 13 }}>
                    No events match the current filters
                  </td>
                </tr>
              )}
              {filteredEvents.map((ev, idx) => {
                const col = eventRowColor(ev.event_type, ev.severity)
                const rowBg = idx % 2 === 0 ? '#111' : '#0e0e0e'
                const description = ev.target_name
                  ? `vs. ${ev.target_name}`
                  : ev.message ?? '—'
                return (
                  <tr key={ev.id} style={{ background: rowBg, borderLeft: `2px solid ${col}44` }}>
                    <td style={{
                      padding: '3px 8px',
                      borderBottom: `1px solid #1a1a1a`,
                      fontFamily: fonts.mono,
                      fontSize: 12,
                      color: colors.textMuted,
                      whiteSpace: 'nowrap',
                    }}>
                      {ev.elapsed_time_formatted}
                    </td>
                    <td style={{
                      padding: '3px 6px',
                      borderBottom: `1px solid #1a1a1a`,
                      textAlign: 'center',
                      fontSize: 14,
                    }}>
                      <span title={ev.event_type} style={{ cursor: 'default' }}>
                        {eventTypeIcon(ev.event_type)}
                      </span>
                    </td>
                    <td style={{
                      padding: '3px 8px',
                      borderBottom: `1px solid #1a1a1a`,
                      fontFamily: fonts.body,
                      fontSize: 13,
                      color: colors.text,
                      whiteSpace: 'nowrap',
                      cursor: ev.driver_name ? 'pointer' : 'default',
                    }}
                      onClick={() => ev.driver_name && setDriverFilter(
                        driverFilter === ev.driver_name ? null : ev.driver_name
                      )}
                      title={ev.driver_name ? `Filter to ${ev.driver_name}` : undefined}
                    >
                      {ev.driver_name ?? '—'}
                    </td>
                    <td style={{
                      padding: '3px 8px',
                      borderBottom: `1px solid #1a1a1a`,
                      fontFamily: fonts.body,
                      fontSize: 13,
                      color: colors.textMuted,
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {description}
                    </td>
                    <td style={{
                      padding: '3px 8px',
                      borderBottom: `1px solid #1a1a1a`,
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                    }}>
                      {ev.event_type === 'incident' && ev.severity != null ? (
                        <span style={{
                          background: col + '22',
                          border: `1px solid ${col}`,
                          color: col,
                          borderRadius: 3,
                          padding: '1px 5px',
                          fontSize: 11,
                          fontWeight: 700,
                          fontFamily: fonts.mono,
                        }}>
                          {ev.severity.toFixed(1)}
                        </span>
                      ) : ev.event_type === 'track_limit' && ev.message != null ? (
                        <span style={{ fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono }}>{ev.message}</span>
                      ) : (
                        <span style={{ color: colors.textMuted }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {/* Driver summaries */}
        {evView === 'drivers' && (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...thTd, textAlign: 'left', cursor: 'default' }}>DRIVER</th>
                <SortDTh col="incidents_total"   label="INC"  title="Total incidents" />
                <SortDTh col="incidents_vehicle" label="VEH"  title="Vehicle contacts" />
                <SortDTh col="incidents_object"  label="OBJ"  title="Object contacts" />
                <SortDTh col="avg_severity"      label="AVG"  title="Average incident severity" />
                <SortDTh col="max_severity"      label="MAX"  title="Maximum incident severity" />
                <SortDTh col="penalties"         label="PEN"  title="Penalties" />
                <SortDTh col="track_limit_warnings" label="TLW" title="Track limit warnings" />
                <SortDTh col="track_limit_points"   label="TLP" title="Track limit points" />
              </tr>
            </thead>
            <tbody>
              {sortedDrivers.map((ds, idx) => {
                const rowBg = idx % 2 === 0 ? '#111' : '#0e0e0e'
                const isFiltered = driverFilter === ds.driver_name
                const td: React.CSSProperties = {
                  padding: '4px 8px',
                  borderBottom: `1px solid #1a1a1a`,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  color: colors.text,
                  textAlign: 'right',
                  whiteSpace: 'nowrap',
                }
                return (
                  <tr
                    key={ds.driver_name}
                    style={{ background: isFiltered ? colors.primary + '14' : rowBg, cursor: 'pointer' }}
                    onClick={() => setDriverFilter(isFiltered ? null : ds.driver_name)}
                    onMouseEnter={e => (e.currentTarget.style.background = isFiltered ? colors.primary + '22' : colors.bgCard)}
                    onMouseLeave={e => (e.currentTarget.style.background = isFiltered ? colors.primary + '14' : rowBg)}
                    title="Click to filter timeline to this driver"
                  >
                    <td style={{ ...td, textAlign: 'left', fontFamily: fonts.body, fontSize: 13, color: isFiltered ? colors.primary : colors.text }}>
                      {ds.driver_name}
                    </td>
                    <td style={{ ...td, color: ds.incidents_total > 0 ? '#ef4444' : colors.textMuted, fontWeight: ds.incidents_total > 0 ? 700 : 400 }}>
                      {ds.incidents_total}
                    </td>
                    <td style={{ ...td, color: ds.incidents_vehicle > 0 ? '#f97316' : colors.textMuted }}>
                      {ds.incidents_vehicle}
                    </td>
                    <td style={{ ...td, color: ds.incidents_object > 0 ? '#eab308' : colors.textMuted }}>
                      {ds.incidents_object}
                    </td>
                    <td style={{ ...td, color: ds.avg_severity != null ? severityColor(ds.avg_severity) : colors.textMuted }}>
                      {ds.avg_severity != null ? ds.avg_severity.toFixed(1) : '—'}
                    </td>
                    <td style={{ ...td, color: ds.max_severity != null ? severityColor(ds.max_severity) : colors.textMuted }}>
                      {ds.max_severity != null ? ds.max_severity.toFixed(1) : '—'}
                    </td>
                    <td style={{ ...td, color: ds.penalties > 0 ? '#ef4444' : colors.textMuted }}>
                      {ds.penalties}
                    </td>
                    <td style={{ ...td, color: ds.track_limit_warnings > 0 ? '#eab308' : colors.textMuted }}>
                      {ds.track_limit_warnings}
                    </td>
                    <td style={{ ...td, color: (ds.track_limit_points ?? 0) > 0 ? '#eab308' : colors.textMuted }}>
                      {ds.track_limit_points != null ? ds.track_limit_points.toFixed(2) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Detail result row ─────────────────────────────────────────────────────────

interface DetailRowProps {
  driver: PostRaceDriverSummary
  overallBest: number
  classBest: number
  onSelect: () => void
  rowIndex: number
  compareMode: boolean
  inCompare: boolean
  compareColor: string | null
  onToggleCompare: () => void
}

const DetailRow = memo(function DetailRow({
  driver, overallBest, classBest, onSelect, rowIndex,
  compareMode, inCompare, compareColor, onToggleCompare,
}: DetailRowProps) {
  const cc = getClassColor(driver.car_class ?? '')
  const fl = finishLabel(driver.finish_status)
  const rowBg = rowIndex % 2 === 0 ? colors.bg : '#141414'

  const cell: React.CSSProperties = {
    padding: '4px 7px',
    borderBottom: `1px solid ${colors.border}`,
    verticalAlign: 'middle',
    fontSize: 14,
    color: colors.text,
    fontFamily: fonts.body,
    whiteSpace: 'nowrap',
  }

  const isOverallBest = overallBest > 0 && (driver.best_lap_time ?? 0) > 0 && driver.best_lap_time === overallBest
  const isClassBest   = !isOverallBest && classBest > 0 && driver.best_lap_time === classBest
  const bestColor = isOverallBest ? '#c026d3' : isClassBest ? '#22c55e' : colors.text

  return (
    <tr
      onClick={compareMode ? onToggleCompare : onSelect}
      style={{
        background: inCompare ? compareColor + '14' : rowBg,
        cursor: 'pointer',
        borderLeft: `3px solid ${inCompare && compareColor ? compareColor : 'transparent'}`,
        transition: 'background 0.1s',
      }}
      title={compareMode ? 'Click to toggle compare selection' : 'Click to view lap detail'}
      onMouseEnter={e => (e.currentTarget.style.background = inCompare && compareColor ? compareColor + '22' : colors.bgCard)}
      onMouseLeave={e => (e.currentTarget.style.background = inCompare && compareColor ? compareColor + '14' : rowBg)}
    >
      {/* Compare checkbox (visible in compare mode) */}
      {compareMode && (
        <td style={{ ...cell, width: 28, textAlign: 'center', padding: '4px 4px' }}>
          <div style={{
            width: 14, height: 14, borderRadius: 3,
            border: `2px solid ${inCompare && compareColor ? compareColor : colors.border}`,
            background: inCompare && compareColor ? compareColor : 'transparent',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, color: '#000', fontWeight: 900,
          }}>
            {inCompare ? '✓' : ''}
          </div>
        </td>
      )}

      {/* Overall position */}
      <td style={{ ...cell, color: colors.primary, fontFamily: fonts.heading, fontSize: 22, width: 42, textAlign: 'right', paddingRight: 8 }}>
        {(driver.position ?? 0) > 0 ? driver.position : '–'}
      </td>

      {/* Class position */}
      <td style={{ ...cell, width: 36, textAlign: 'center' }}>
        {(driver.class_position ?? 0) > 0 && (
          <span style={{
            background: cc,
            color: '#fff',
            borderRadius: 3,
            padding: '1px 5px',
            fontSize: 12,
            fontWeight: 700,
          }}>
            C{driver.class_position}
          </span>
        )}
      </td>

      {/* Car # */}
      <td style={{ ...cell, width: 38, textAlign: 'center', fontFamily: fonts.mono, color: colors.textMuted }}>
        {driver.car_number !== null ? `#${driver.car_number}` : '–'}
      </td>

      {/* Driver + team */}
      <td style={{ ...cell, maxWidth: 200 }}>
        <div style={{
          fontWeight: 600, fontSize: 14,
          overflow: 'hidden', textOverflow: 'ellipsis',
          color: driver.is_player ? colors.accent : colors.text,
        }}>
          {driver.is_player ? '★ ' : ''}{driver.name}
        </div>
        <div style={{ fontSize: 11, color: colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {driver.team_name ?? ''}
        </div>
      </td>

      {/* Class badge */}
      <td style={{ ...cell, width: 90 }}>
        {driver.car_class && (
          <span style={{
            background: cc + '28',
            border: `1px solid ${cc}`,
            color: cc,
            borderRadius: 3,
            padding: '1px 5px',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}>
            {driver.car_class}
          </span>
        )}
      </td>

      {/* Laps */}
      <td style={{ ...cell, width: 42, textAlign: 'center', color: colors.textMuted }}>
        {driver.total_laps ?? '–'}
      </td>

      {/* Best lap */}
      <td style={{ ...cell, width: 105, textAlign: 'right', fontFamily: fonts.mono, color: bestColor, fontWeight: isOverallBest || isClassBest ? 700 : 400 }}>
        {fmtLap(driver.best_lap_time)}
      </td>

      {/* Gap to leader */}
      <td style={{ ...cell, width: 90, textAlign: 'right', fontFamily: fonts.mono, color: driver.gap_to_leader != null || driver.laps_behind != null ? '#f59e0b' : colors.textMuted }}>
        {driver.position === 1
          ? 'LEADER'
          : driver.laps_behind != null && driver.laps_behind > 0
            ? `+${driver.laps_behind} Lap${driver.laps_behind > 1 ? 's' : ''}`
            : fmtGap(driver.gap_to_leader)}
      </td>

      {/* Pits */}
      <td style={{ ...cell, width: 38, textAlign: 'center' }}>
        {driver.pitstops ?? '–'}
      </td>

      {/* Status */}
      <td style={{ ...cell, width: 48, textAlign: 'center' }}>
        <span style={{ color: fl.color, fontWeight: 700, fontSize: 13 }}>{fl.text}</span>
      </td>

      {/* Navigate indicator */}
      <td style={{ ...cell, width: 24, textAlign: 'center', color: colors.textMuted, fontSize: 14 }}>
        ›
      </td>
    </tr>
  )
})

// ── Session browser filter bar ────────────────────────────────────────────────

interface BrowserFilters {
  track: string
  sessionTypes: Set<string>
  dateFrom: string
  dateTo: string
  gameVersion: string
  search: string
}

const ALL_SESSION_TYPES = ['Race', 'Qualifying', 'Practice', 'Warmup']

function FilterBar({
  filters,
  onChange,
  tracks,
  versions,
}: {
  filters: BrowserFilters
  onChange: (f: BrowserFilters) => void
  tracks: string[]
  versions: string[]
}) {
  const inputStyle: React.CSSProperties = {
    background: colors.bgWidget,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 12,
    padding: '3px 8px',
    borderRadius: 3,
    outline: 'none',
    height: 26,
  }

  function toggleType(t: string) {
    const next = new Set(filters.sessionTypes)
    if (next.has(t)) next.delete(t); else next.add(t)
    onChange({ ...filters, sessionTypes: next })
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 12px',
      background: '#0e0e0e',
      borderBottom: `1px solid ${colors.border}`,
      flexWrap: 'wrap',
      flexShrink: 0,
    }}>
      {/* Track dropdown */}
      <select
        value={filters.track}
        onChange={e => onChange({ ...filters, track: e.target.value })}
        style={{ ...inputStyle, minWidth: 130 }}
        title="Filter by track"
      >
        <option value="">All Tracks</option>
        {tracks.map(t => <option key={t} value={t}>{t}</option>)}
      </select>

      {/* Game version dropdown */}
      {versions.length > 0 && (
        <select
          value={filters.gameVersion}
          onChange={e => onChange({ ...filters, gameVersion: e.target.value })}
          style={{ ...inputStyle, minWidth: 110 }}
          title="Filter by game version"
        >
          <option value="">All Versions</option>
          {versions.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      )}

      {/* Session type checkboxes */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {ALL_SESSION_TYPES.map(t => {
          const { bg } = sessionColors(t)
          const active = filters.sessionTypes.size === 0 || filters.sessionTypes.has(t)
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              style={{
                background: filters.sessionTypes.has(t) ? bg + '33' : 'transparent',
                border: `1px solid ${filters.sessionTypes.has(t) ? bg : colors.border}`,
                color: filters.sessionTypes.has(t) ? bg : colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 3,
                cursor: 'pointer',
                opacity: active ? 1 : 0.4,
              }}
            >
              {t}
            </button>
          )
        })}
        {filters.sessionTypes.size > 0 && (
          <button
            onClick={() => onChange({ ...filters, sessionTypes: new Set() })}
            style={{ background: 'transparent', border: 'none', color: colors.textMuted, fontSize: 11, cursor: 'pointer', padding: '2px 4px' }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 11, color: colors.textMuted }}>Von</span>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={e => onChange({ ...filters, dateFrom: e.target.value })}
          style={{ ...inputStyle, width: 128, colorScheme: 'dark' }}
        />
        <span style={{ fontSize: 11, color: colors.textMuted }}>Bis</span>
        <input
          type="date"
          value={filters.dateTo}
          onChange={e => onChange({ ...filters, dateTo: e.target.value })}
          style={{ ...inputStyle, width: 128, colorScheme: 'dark' }}
        />
        {(filters.dateFrom || filters.dateTo) && (
          <button
            onClick={() => onChange({ ...filters, dateFrom: '', dateTo: '' })}
            style={{ background: 'transparent', border: 'none', color: colors.textMuted, fontSize: 11, cursor: 'pointer', padding: '2px 4px' }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Text search */}
      <input
        type="search"
        placeholder="Track / Event…"
        value={filters.search}
        onChange={e => onChange({ ...filters, search: e.target.value })}
        style={{ ...inputStyle, width: 160 }}
      />
    </div>
  )
}

// ── Session browser table ──────────────────────────────────────────────────────

function SessionBrowser({
  sessions,
  onSelect,
  importInfo,
}: {
  sessions: PostRaceSessionMeta[]
  onSelect: (s: PostRaceSessionMeta) => void
  importInfo: { total: number; newImported: number; filesFound: number; importErrors: number } | null
}) {
  const thStyle: React.CSSProperties = {
    padding: '5px 10px',
    borderBottom: `2px solid ${colors.border}`,
    color: colors.primary,
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.6,
    background: colors.bgCard,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    whiteSpace: 'nowrap',
    textAlign: 'left',
    userSelect: 'none',
  }

  if (sessions.length === 0) {
    const noFiles = importInfo !== null && importInfo.filesFound === 0
    const hasErrors = importInfo !== null && importInfo.importErrors > 0
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: colors.textMuted,
        fontFamily: fonts.body,
      }}>
        <div style={{ fontSize: 48, opacity: 0.15 }}>📋</div>
        {importInfo !== null && importInfo.total === 0 ? (
          <>
            <div style={{ fontSize: 17, color: colors.text }}>
              {noFiles ? 'No result files found' : 'No sessions available'}
            </div>
            <div style={{ fontSize: 14, color: colors.textMuted, textAlign: 'center', maxWidth: 480, lineHeight: 1.6 }}>
              {noFiles
                ? 'The bridge looks for XML files in:\nC:\\Program Files (x86)\\Steam\\steamapps\\common\\Le Mans Ultimate\\UserData\\Log\\Results'
                : 'Files were found, but none could be imported.'}
            </div>
            {noFiles && (
              <div style={{ fontSize: 13, color: colors.textMuted }}>
                Start LMU, complete a race, then click Refresh.
              </div>
            )}
            {hasErrors && (
              <div style={{ fontSize: 13, color: '#f97316' }}>
                {importInfo.importErrors} file{importInfo.importErrors !== 1 ? 's' : ''} could not be imported.
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 18, color: colors.text }}>No sessions match the current filters</div>
        )}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
        <thead>
          <tr>
            <th style={{ ...thStyle }}>DATE</th>
            <th style={{ ...thStyle }}>TRACK</th>
            <th style={{ ...thStyle }}>EVENT</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>TYPE</th>
            <th style={{ ...thStyle }}>VERSION</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>DRIVERS</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>LAPS</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, idx) => {
            const sessionType = normalizeSessionType(s.session_type)
            const rowBg = idx % 2 === 0 ? colors.bg : '#141414'
            return (
              <tr
                key={s.id}
                onClick={() => onSelect(s)}
                style={{ background: rowBg, cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.background = colors.bgCard)}
                onMouseLeave={e => (e.currentTarget.style.background = rowBg)}
              >
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, fontFamily: fonts.mono, fontSize: 14, color: colors.text, whiteSpace: 'nowrap' }}>
                  {formatDateTime(s.date_time)}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, fontSize: 15, color: colors.text, fontFamily: fonts.body, whiteSpace: 'nowrap' }}>
                  {s.track_venue ?? '—'}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, fontSize: 14, color: colors.textMuted, fontFamily: fonts.body }}>
                  {s.track_event ?? '—'}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, textAlign: 'center' }}>
                  <SessionTypeBadge type={sessionType} />
                </td>
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, fontSize: 13, color: colors.textMuted, fontFamily: fonts.mono, whiteSpace: 'nowrap' }}>
                  {s.game_version ?? '—'}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, textAlign: 'right', fontFamily: fonts.mono, fontSize: 15, color: colors.text }}>
                  {s.driver_count}
                </td>
                <td style={{ padding: '6px 10px', borderBottom: `1px solid ${colors.border}`, textAlign: 'right', fontFamily: fonts.mono, fontSize: 15, color: colors.textMuted }}>
                  {s.race_laps ?? s.total_laps}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

type ViewState = 'loading' | 'browser' | 'loading_detail' | 'detail' | 'driver_detail' | 'compare' | 'error'

export default function PostRaceResults({ onClose }: { onClose: () => void }) {
  // WS
  const wsRef = useRef<WebSocket | null>(null)
  const viewRef = useRef<ViewState>('loading')

  // View state
  const [view, setView] = useState<ViewState>('loading')
  const [error, setError] = useState<string | null>(null)

  // Session browser data
  const [allSessions, setAllSessions]       = useState<PostRaceSessionMeta[]>([])
  const [selectedSession, setSelectedSession] = useState<PostRaceSessionMeta | null>(null)
  const [importInfo, setImportInfo]           = useState<{ total: number; newImported: number; filesFound: number; importErrors: number } | null>(null)

  // Session detail data
  const [drivers, setDrivers]               = useState<PostRaceDriverSummary[]>([])
  const [sessionHasEvents, setSessionHasEvents] = useState(false)
  const [eventsData, setEventsData]         = useState<EventsData | null>(null)
  const [eventsLoading, setEventsLoading]   = useState(false)
  const [detailTab, setDetailTab]           = useState<'results' | 'events'>('results')
  const [driverLaps, setDriverLaps]         = useState<Map<number, PostRaceLapData[]>>(new Map())
  const [driverStints, setDriverStints]     = useState<Map<number, PostRaceStintData[]>>(new Map())

  // Detail view controls
  const [classFilter, setClassFilter]       = useState<string>('All')
  const [sortCol, setSortCol]               = useState<'pos' | 'best' | 'laps'>('pos')
  const [sortDir, setSortDir]               = useState<'asc' | 'desc'>('asc')

  // Driver detail
  const [selectedDriver, setSelectedDriver] = useState<PostRaceDriverSummary | null>(null)
  const [driverDetailTab, setDriverDetailTab] = useState<'laps' | 'stints'>('laps')

  // Compare
  const [compareMode, setCompareMode]           = useState(false)
  const [compareDriverIds, setCompareDriverIds] = useState<number[]>([])
  const [compareDriverInfo, setCompareDriverInfo] = useState<Map<number, PostRaceDriverSummary>>(new Map())
  const [compareLaps, setCompareLaps]           = useState<Map<number, PostRaceLapData[]>>(new Map())
  const [compareStints, setCompareStints]       = useState<Map<number, PostRaceStintData[]>>(new Map())
  const [compareResult, setCompareResult]       = useState<{ reference_driver_id: number; laps: PostRaceComparedLap[] } | null>(null)
  const [compareTab, setCompareTab]             = useState<'laps' | 'stints' | 'charts'>('laps')

  // Browser filters
  const [filters, setFilters] = useState<BrowserFilters>({
    track: '',
    sessionTypes: new Set(),
    dateFrom: '',
    dateTo: '',
    gameVersion: '',
    search: '',
  })

  // Scale
  const SCALE_MIN = 0.5
  const SCALE_MAX = 2.0
  const SCALE_STEP = 0.1
  const LS_SCALE_KEY = 'post-race-scale'
  const [scale, setScaleState] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem(LS_SCALE_KEY) ?? '1')
    return isNaN(v) ? 1 : Math.min(SCALE_MAX, Math.max(SCALE_MIN, v))
  })
  function adjustScale(delta: number) {
    setScaleState(prev => {
      const next = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, prev + delta)) * 10) / 10
      localStorage.setItem(LS_SCALE_KEY, String(next))
      return next
    })
  }

  // ── Fun facts ticker ─────────────────────────────────────────────────────────

  const LS_PLAYER_KEY = 'post-race-player-name'
  const [funFacts, setFunFacts] = useState<string[]>([])
  const [factIdx, setFactIdx] = useState(0)
  const [factVisible, setFactVisible] = useState(true)

  useEffect(() => {
    if (funFacts.length < 2) return
    let tid: ReturnType<typeof setTimeout>
    const iv = setInterval(() => {
      setFactVisible(false)
      tid = setTimeout(() => {
        setFactIdx(i => (i + 1) % funFacts.length)
        setFactVisible(true)
      }, 450)
    }, 8000)
    return () => { clearInterval(iv); clearTimeout(tid) }
  }, [funFacts])

  // ── WebSocket ────────────────────────────────────────────────────────────────

  function goTo(v: ViewState) {
    viewRef.current = v
    setView(v)
  }

  const sendCmd = useCallback((cmd: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd))
    }
  }, [])

  useEffect(() => {
    const { wsHost, wsPort } = useSettingsStore.getState()
    const host = (wsHost || '').trim() || window.location.hostname
    const url = `ws://${host}:${wsPort}`
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      const { resultsPath } = useSettingsStore.getState()
      ws.send(JSON.stringify({ command: 'post_race_init', results_path: resultsPath || null }))
    }

    ws.onmessage = (event) => {
      try {
        let msg: PostRaceMsg
        if (event.data instanceof ArrayBuffer) {
          msg = decode(new Uint8Array(event.data)) as PostRaceMsg
        } else {
          msg = JSON.parse(event.data as string) as PostRaceMsg
        }
        handleMsg(msg)
      } catch { /* malformed */ }
    }

    ws.onerror = () => {
      viewRef.current = 'error'
      setError('WebSocket-Verbindung fehlgeschlagen.')
      setView('error')
    }

    ws.onclose = () => {
      if (viewRef.current === 'loading' || viewRef.current === 'loading_detail') {
        viewRef.current = 'error'
        setError('Verbindung zum Bridge getrennt.')
        setView('error')
      }
    }

    return () => {
      ws.onclose = null
      ws.close()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleMsg(msg: PostRaceMsg) {
    switch (msg.type) {
      case 'PostRaceSessions':
        setAllSessions(msg.sessions)
        setImportInfo({ total: msg.total_sessions, newImported: msg.new_imported, filesFound: msg.files_found, importErrors: msg.import_errors })
        goTo('browser')
        sendCmd({ command: 'post_race_fun_facts' })
        break

      case 'PostRaceSessionDetail':
        setDrivers(msg.drivers)
        setSessionHasEvents(msg.has_events)
        setEventsData(null)
        setEventsLoading(false)
        setDetailTab('results')
        setDriverLaps(new Map())
        setDriverStints(new Map())
        setSelectedDriver(null)
        setClassFilter('All')
        setSortCol('pos')
        setSortDir('asc')
        goTo('detail')
        break

      case 'PostRaceDriverLaps':
        setDriverLaps(prev => { const n = new Map(prev); n.set(msg.driver_id, msg.laps); return n })
        setCompareLaps(prev => { const n = new Map(prev); n.set(msg.driver_id, msg.laps); return n })
        break

      case 'PostRaceStintSummary':
        setDriverStints(prev => { const n = new Map(prev); n.set(msg.driver_id, msg.stints); return n })
        setCompareStints(prev => { const n = new Map(prev); n.set(msg.driver_id, msg.stints); return n })
        break

      case 'PostRaceCompare':
        setCompareResult({ reference_driver_id: msg.reference_driver_id, laps: msg.laps })
        break

      case 'PostRaceEvents':
        setEventsData({ session_id: msg.session_id, summary: msg.summary, driver_summaries: msg.driver_summaries, events: msg.events })
        setEventsLoading(false)
        break

      case 'PostRaceError':
        setError(msg.message)
        goTo('error')
        break

      case 'PostRaceFunFacts': {
        if (msg.player_name) {
          localStorage.setItem(LS_PLAYER_KEY, msg.player_name)
        }
        const storedName = msg.player_name ?? localStorage.getItem(LS_PLAYER_KEY)
        const allFacts = storedName
          ? [`Racing as: ${storedName}`, ...msg.facts]
          : msg.facts
        if (allFacts.length > 0) {
          setFunFacts(allFacts)
          setFactIdx(0)
          setFactVisible(true)
        }
        break
      }
    }
  }

  // ── Session selection ────────────────────────────────────────────────────────

  function openSession(s: PostRaceSessionMeta) {
    setSelectedSession(s)
    goTo('loading_detail')
    sendCmd({ command: 'post_race_session_detail', session_id: s.id })
  }

  function backToBrowser() {
    setSelectedSession(null)
    goTo('browser')
  }

  // ── Driver detail navigation ──────────────────────────────────────────────

  function openDriver(driver: PostRaceDriverSummary) {
    setSelectedDriver(driver)
    setDriverDetailTab('laps')
    goTo('driver_detail')
    if (!driverLaps.has(driver.id)) {
      sendCmd({ command: 'post_race_driver_laps', driver_id: driver.id })
    }
    if (!driverStints.has(driver.id)) {
      sendCmd({ command: 'post_race_stint_summary', driver_id: driver.id })
    }
  }

  function backToDetail() {
    setSelectedDriver(null)
    goTo('detail')
  }

  function openEventsTab() {
    setDetailTab('events')
    if (!eventsData && !eventsLoading && selectedSession) {
      setEventsLoading(true)
      sendCmd({ command: 'post_race_events', session_id: selectedSession.id })
    }
  }

  // ── Compare ───────────────────────────────────────────────────────────────

  function toggleCompareDriver(driver: PostRaceDriverSummary) {
    const id = driver.id
    setCompareDriverIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      return [...prev, id]
    })
    setCompareDriverInfo(prev => {
      const n = new Map(prev)
      if (n.has(id)) n.delete(id); else n.set(id, driver)
      return n
    })
  }

  function clearCompare() {
    setCompareDriverIds([])
    setCompareDriverInfo(new Map())
    setCompareResult(null)
    setCompareMode(false)
  }

  function openCompare() {
    setCompareResult(null)
    setCompareTab('laps')
    goTo('compare')
    for (const id of compareDriverIds) {
      if (!compareLaps.has(id)) sendCmd({ command: 'post_race_driver_laps', driver_id: id })
      if (!compareStints.has(id)) sendCmd({ command: 'post_race_stint_summary', driver_id: id })
    }
    sendCmd({ command: 'post_race_compare', driver_ids: compareDriverIds })
  }

  function backFromCompare() {
    goTo(selectedSession ? 'detail' : 'browser')
  }

  // ── Derived state (browser) ───────────────────────────────────────────────

  const tracks = useMemo(() =>
    [...new Set(allSessions.map(s => s.track_venue).filter(Boolean) as string[])].sort(),
    [allSessions])

  const versions = useMemo(() =>
    [...new Set(allSessions.map(s => s.game_version).filter(Boolean) as string[])].sort().reverse(),
    [allSessions])

  const filteredSessions = useMemo(() => {
    return allSessions.filter(s => {
      if (filters.track && s.track_venue !== filters.track) return false
      if (filters.gameVersion && s.game_version !== filters.gameVersion) return false
      if (filters.sessionTypes.size > 0) {
        const st = normalizeSessionType(s.session_type)
        if (!filters.sessionTypes.has(st)) return false
      }
      if (filters.dateFrom) {
        const d = parseDateTime(s.date_time)
        if (!d || d < new Date(filters.dateFrom)) return false
      }
      if (filters.dateTo) {
        const d = parseDateTime(s.date_time)
        const to = new Date(filters.dateTo)
        to.setDate(to.getDate() + 1)
        if (!d || d >= to) return false
      }
      if (filters.search) {
        const q = filters.search.toLowerCase()
        const hay = `${s.track_venue ?? ''} ${s.track_event ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [allSessions, filters])

  // ── Derived state (detail) ────────────────────────────────────────────────

  const allClasses = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const d of drivers) {
      const cls = d.car_class ?? ''
      if (cls && !seen.has(cls)) { seen.add(cls); out.push(cls) }
    }
    return out
  }, [drivers])

  const overallBest = useMemo(() => {
    const valid = drivers.map(d => d.best_lap_time ?? 0).filter(t => t > 0)
    return valid.length > 0 ? Math.min(...valid) : -1
  }, [drivers])

  const classBests = useMemo(() => {
    const m: Record<string, number> = {}
    for (const d of drivers) {
      const cls = d.car_class ?? ''
      const t = d.best_lap_time ?? 0
      if (t > 0 && (!m[cls] || t < m[cls])) m[cls] = t
    }
    return m
  }, [drivers])

  const displayedDrivers = useMemo(() => {
    let list = classFilter === 'All'
      ? drivers
      : drivers.filter(d => d.car_class === classFilter)

    list = [...list].sort((a, b) => {
      let av: number, bv: number
      if (sortCol === 'best') {
        av = (a.best_lap_time ?? 0) > 0 ? (a.best_lap_time!) : 999999
        bv = (b.best_lap_time ?? 0) > 0 ? (b.best_lap_time!) : 999999
      } else if (sortCol === 'laps') {
        av = a.total_laps ?? 0
        bv = b.total_laps ?? 0
      } else {
        av = (a.position ?? 0) > 0 ? a.position! : 999
        bv = (b.position ?? 0) > 0 ? b.position! : 999
      }
      return sortDir === 'asc' ? av - bv : bv - av
    })

    return list
  }, [drivers, classFilter, sortCol, sortDir])

  function onSort(col: typeof sortCol) {
    if (col === sortCol) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // ── Shared styles ─────────────────────────────────────────────────────────

  const btnStyle: React.CSSProperties = {
    background: colors.bgWidget,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
    padding: '3px 10px',
    borderRadius: 3,
    cursor: 'pointer',
    flexShrink: 0,
  }

  const thBase: React.CSSProperties = {
    padding: '5px 7px',
    borderBottom: `2px solid ${colors.border}`,
    color: colors.primary,
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.6,
    background: colors.bgCard,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  }

  function SortTh({ col, label, align = 'right' }: {
    col: typeof sortCol
    label: string
    align?: 'left' | 'right' | 'center'
  }) {
    const active = sortCol === col
    return (
      <th
        onClick={() => onSort(col)}
        style={{ ...thBase, textAlign: align, cursor: 'pointer', color: active ? colors.accent : colors.primary }}
      >
        {label}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    )
  }

  // ── Session type for selected session ────────────────────────────────────

  const detailSessionType = selectedSession
    ? normalizeSessionType(selectedSession.session_type)
    : ''

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: colors.bg,
      fontFamily: fonts.body,
      overflow: 'hidden',
    }}>
      {/* ── Top control bar ───────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: colors.bgCard,
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
        flexWrap: 'wrap',
        position: 'relative',
      }}>
        <span style={{
          fontFamily: fonts.heading,
          fontSize: 20,
          fontWeight: 700,
          color: colors.primary,
          letterSpacing: 1.5,
          flexShrink: 0,
        }}>
          SESSION RESULTS
        </span>

        {/* Breadcrumb */}
        {(view === 'detail' || view === 'driver_detail') && selectedSession && (
          <>
            <div style={{ width: 1, height: 20, background: colors.border }} />
            <button onClick={backToBrowser} style={{ ...btnStyle, color: colors.textMuted }}>← Sessions</button>
            <span style={{ color: colors.border }}>/</span>
            {view === 'driver_detail'
              ? <>
                  <button onClick={backToDetail} style={{ ...btnStyle, color: colors.textMuted }}>{selectedSession.track_venue ?? '—'}</button>
                  <span style={{ color: colors.border }}>/</span>
                </>
              : <span style={{ fontSize: 15, color: colors.text, fontFamily: fonts.body }}>{selectedSession.track_venue ?? '—'}</span>
            }
            <SessionTypeBadge type={detailSessionType} />
            <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>{formatDateTime(selectedSession.date_time)}</span>
            {view === 'driver_detail' && selectedDriver && (
              <>
                <span style={{ color: colors.border }}>/</span>
                <span style={{ fontSize: 15, color: colors.text, fontFamily: fonts.body }}>
                  {selectedDriver.is_player ? '★ ' : ''}{selectedDriver.name}
                </span>
              </>
            )}
          </>
        )}
        {view === 'compare' && (
          <>
            <div style={{ width: 1, height: 20, background: colors.border }} />
            <button onClick={backFromCompare} style={{ ...btnStyle, color: colors.textMuted }}>← Back</button>
            <span style={{ color: colors.border }}>/</span>
            <span style={{ fontSize: 15, color: colors.text, fontFamily: fonts.body }}>
              Compare ({compareDriverIds.length} drivers)
            </span>
          </>
        )}

        {/* Browser: import info */}
        {view === 'browser' && importInfo !== null && (
          <>
            <div style={{ width: 1, height: 20, background: colors.border }} />
            <span style={{ fontSize: 13, color: colors.textMuted }}>
              {importInfo.total} session{importInfo.total !== 1 ? 's' : ''}
              {importInfo.filesFound > 0 && importInfo.total === 0 && (
                <span style={{ color: '#f97316' }}> · {importInfo.filesFound} file{importInfo.filesFound !== 1 ? 's' : ''} found, 0 imported</span>
              )}
              {importInfo.importErrors > 0 && (
                <span style={{ color: '#f97316' }}> · {importInfo.importErrors} error{importInfo.importErrors !== 1 ? 's' : ''}</span>
              )}
              {importInfo.newImported > 0 && (
                <span style={{ color: colors.success }}> · {importInfo.newImported} newly imported</span>
              )}
            </span>
            <button
              onClick={() => sendCmd({ command: 'post_race_init', results_path: useSettingsStore.getState().resultsPath || null })}
              style={{ ...btnStyle, fontSize: 13, color: colors.textMuted }}
              title="Import new results"
            >
              ↻
            </button>
          </>
        )}

        <div style={{ flex: 1 }} />

        {/* Fun facts ticker — centered absolutely so it doesn't shift the flex layout */}
        {funFacts.length > 0 && (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            pointerEvents: 'none',
            maxWidth: 420,
            overflow: 'hidden',
          }}>
            <span style={{
              fontFamily: fonts.heading,
              fontSize: 12,
              fontWeight: 700,
              color: colors.primary,
              letterSpacing: 1,
              flexShrink: 0,
              opacity: 0.85,
            }}>
              ◆ FUN FACT
            </span>
            <span style={{
              fontSize: 14,
              color: colors.text,
              fontFamily: fonts.body,
              opacity: factVisible ? 0.9 : 0,
              transform: factVisible ? 'translateY(0px)' : 'translateY(-5px)',
              transition: 'opacity 0.45s ease, transform 0.45s ease',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {funFacts[factIdx]}
            </span>
          </div>
        )}

        {/* Compare mode toggle — shown in browser and detail views */}
        {(view === 'browser' || view === 'detail') && (
          <button
            onClick={() => setCompareMode(m => !m)}
            style={{
              ...btnStyle,
              color: compareMode ? colors.primary : colors.textMuted,
              border: `1px solid ${compareMode ? colors.primary : colors.border}`,
              background: compareMode ? colors.primary + '18' : colors.bgWidget,
            }}
            title="Toggle compare mode to select drivers for head-to-head comparison"
          >
            {compareMode ? '⊠ Compare Mode ON' : '⊞ Compare Mode'}
          </button>
        )}

        {/* Scale controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => adjustScale(-SCALE_STEP)}
            disabled={scale <= SCALE_MIN}
            title="Kleiner"
            style={{
              width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: `1px solid ${scale <= SCALE_MIN ? '#333' : colors.border}`,
              color: scale <= SCALE_MIN ? '#333' : colors.textMuted, cursor: scale <= SCALE_MIN ? 'not-allowed' : 'pointer',
              borderRadius: 3, fontSize: 14, padding: 0, lineHeight: 1,
            }}
          >−</button>
          <span style={{ fontSize: 13, color: colors.textMuted, minWidth: 34, textAlign: 'center', fontFamily: fonts.mono }}>
            {scale.toFixed(1)}×
          </span>
          <button
            onClick={() => adjustScale(SCALE_STEP)}
            disabled={scale >= SCALE_MAX}
            title="Grösser"
            style={{
              width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: `1px solid ${scale >= SCALE_MAX ? '#333' : colors.border}`,
              color: scale >= SCALE_MAX ? '#333' : colors.textMuted, cursor: scale >= SCALE_MAX ? 'not-allowed' : 'pointer',
              borderRadius: 3, fontSize: 14, padding: 0, lineHeight: 1,
            }}
          >+</button>
        </div>

        <button onClick={onClose} title="Back to dashboard" style={{ ...btnStyle, color: colors.textMuted }}>
          ← Dashboard
        </button>
      </div>

      {/* ── Scalable content area ─────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        <div style={{
          position: 'absolute', top: 0, left: 0,
          width: `${100 / scale}%`, height: `${100 / scale}%`,
          transform: `scale(${scale})`, transformOrigin: 'top left',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>

      {/* ── Compare tray — persistent when drivers selected ────────────────── */}
      {compareDriverIds.length > 0 && view !== 'compare' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px',
          background: '#0c0c0c',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, color: colors.textMuted, fontWeight: 700, letterSpacing: 0.8, flexShrink: 0 }}>COMPARE:</span>
          {compareDriverIds.map((id, i) => {
            const color = driverColor(i)
            const driver = compareDriverInfo.get(id)
            return (
              <div key={id} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '1px 6px', borderRadius: 3,
                background: color + '18', border: `1px solid ${color}55`,
              }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                <span style={{ fontSize: 11, color, fontWeight: 700 }}>{driver?.name ?? `#${id}`}</span>
                {i === 0 && <span style={{ fontSize: 9, color: colors.textMuted }}>REF</span>}
                <button
                  onClick={() => driver && toggleCompareDriver(driver)}
                  style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', padding: '0 2px', fontSize: 12, lineHeight: 1 }}
                >×</button>
              </div>
            )
          })}
          <div style={{ flex: 1 }} />
          <button
            onClick={clearCompare}
            style={{ ...btnStyle, fontSize: 11, color: colors.textMuted, padding: '2px 8px' }}
          >
            Clear
          </button>
          <button
            onClick={openCompare}
            disabled={compareDriverIds.length < 2}
            style={{
              ...btnStyle,
              fontSize: 11,
              padding: '2px 10px',
              color: compareDriverIds.length >= 2 ? colors.primary : colors.textMuted,
              border: `1px solid ${compareDriverIds.length >= 2 ? colors.primary : colors.border}`,
              background: compareDriverIds.length >= 2 ? colors.primary + '18' : colors.bgWidget,
              cursor: compareDriverIds.length >= 2 ? 'pointer' : 'not-allowed',
            }}
          >
            Compare ({compareDriverIds.length}) →
          </button>
        </div>
      )}

      {/* ── Detail / driver_detail: info + class filter strip ────────────── */}
      {(view === 'detail' || view === 'driver_detail') && (
        <>
          {selectedSession && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              padding: '5px 14px',
              background: '#0e0e0e',
              borderBottom: `1px solid ${colors.border}`,
              flexShrink: 0,
              flexWrap: 'wrap',
            }}>
              <SessionTypeBadge type={detailSessionType} />
              <InfoChip label="TRACK" value={selectedSession.track_venue ?? ''} />
              <InfoChip label="EVENT" value={selectedSession.track_event ?? ''} />
              <InfoChip label="DATE" value={formatDateTime(selectedSession.date_time)} />
              {selectedSession.race_laps && (
                <InfoChip label="LAPS" value={String(selectedSession.race_laps)} />
              )}
              {selectedSession.game_version && (
                <InfoChip label="VERSION" value={selectedSession.game_version} />
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 13, color: colors.textMuted }}>
                <span style={{ color: '#c026d3', fontWeight: 700 }}>■</span> Overall best&nbsp;&nbsp;
                <span style={{ color: '#22c55e', fontWeight: 700 }}>■</span> Class best&nbsp;&nbsp;
                <span style={{ color: colors.text }}>★</span> Player
              </span>
            </div>
          )}

          {/* Class filter pills — only in session detail */}
          {view === 'detail' && allClasses.length > 1 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              background: '#0a0a0a',
              borderBottom: `1px solid ${colors.border}`,
              flexShrink: 0,
              flexWrap: 'wrap',
            }}>
              {(['All', ...allClasses]).map(cls => {
                const active = classFilter === cls
                const cc = cls !== 'All' ? getClassColor(cls) : colors.textMuted
                const count = cls === 'All'
                  ? drivers.length
                  : drivers.filter(d => d.car_class === cls).length
                return (
                  <button
                    key={cls}
                    onClick={() => setClassFilter(cls)}
                    style={{
                      background: active ? (cls !== 'All' ? cc + '28' : colors.bgWidget) : 'transparent',
                      border: `1px solid ${active ? (cls !== 'All' ? cc : colors.primary) : colors.border}`,
                      color: active ? (cls !== 'All' ? cc : colors.text) : colors.textMuted,
                      fontFamily: fonts.body,
                      fontSize: 12,
                      padding: '2px 8px',
                      borderRadius: 3,
                      cursor: 'pointer',
                      fontWeight: active ? 700 : 400,
                      flexShrink: 0,
                    }}
                  >
                    {cls} ({count})
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ── Browser: filter bar ───────────────────────────────────────────── */}
      {view === 'browser' && (
        <FilterBar
          filters={filters}
          onChange={setFilters}
          tracks={tracks}
          versions={versions}
        />
      )}

      {/* ── Main content ──────────────────────────────────────────────────── */}

      {/* Loading sessions */}
      {(view === 'loading' || view === 'loading_detail') && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          color: colors.textMuted,
          fontFamily: fonts.body,
        }}>
          <div style={{ fontSize: 48, opacity: 0.2 }}>📋</div>
          <div style={{ fontSize: 16, color: colors.text }}>
            {view === 'loading' ? 'Scanning sessions…' : 'Loading session detail…'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>
            {view === 'loading' ? 'Importing new result files from LMU folder' : ''}
          </div>
        </div>
      )}

      {/* Error */}
      {view === 'error' && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 12, color: colors.danger,
        }}>
          <div style={{ fontSize: 32, opacity: 0.5 }}>⚠</div>
          <div style={{ fontWeight: 600, fontSize: 18 }}>Error</div>
          <div style={{ fontSize: 13, color: colors.textMuted, maxWidth: 400, textAlign: 'center' }}>{error}</div>
          <button
            onClick={() => {
              setError(null)
              goTo('loading')
              sendCmd({ command: 'post_race_init', results_path: useSettingsStore.getState().resultsPath || null })
            }}
            style={{ marginTop: 8, ...btnStyle, fontSize: 13, padding: '6px 16px', color: colors.primary }}
          >
            Try again
          </button>
        </div>
      )}

      {/* Session browser */}
      {view === 'browser' && (
        <SessionBrowser sessions={filteredSessions} onSelect={openSession} importInfo={importInfo} />
      )}

      {/* Session detail */}
      {view === 'detail' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            background: '#0a0a0a',
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}>
            <button
              onClick={() => setDetailTab('results')}
              style={{
                background: detailTab === 'results' ? colors.primary + '22' : 'transparent',
                border: `1px solid ${detailTab === 'results' ? colors.primary : colors.border}`,
                color: detailTab === 'results' ? colors.primary : colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 12,
                fontWeight: detailTab === 'results' ? 700 : 400,
                padding: '3px 14px',
                borderRadius: 3,
                cursor: 'pointer',
                letterSpacing: 0.5,
              }}
            >
              RESULTS
            </button>
            {sessionHasEvents && (
              <button
                onClick={openEventsTab}
                style={{
                  background: detailTab === 'events' ? '#ef4444' + '22' : 'transparent',
                  border: `1px solid ${detailTab === 'events' ? '#ef4444' : colors.border}`,
                  color: detailTab === 'events' ? '#ef4444' : colors.textMuted,
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: detailTab === 'events' ? 700 : 400,
                  padding: '3px 14px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  letterSpacing: 0.5,
                }}
              >
                ⚠ EVENTS
              </button>
            )}
          </div>

          {/* Results tab */}
          {detailTab === 'results' && (
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
                <thead>
                  <tr>
                    {compareMode && <th style={{ ...thBase, cursor: 'default', width: 28 }} />}
                    <SortTh col="pos"  label="POS"      align="right" />
                    <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>CL</th>
                    <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>CAR</th>
                    <th style={{ ...thBase, cursor: 'default', textAlign: 'left' }}>DRIVER / TEAM</th>
                    <th style={{ ...thBase, cursor: 'default' }}>CLASS</th>
                    <SortTh col="laps" label="LAPS"     align="center" />
                    <SortTh col="best" label="BEST LAP" align="right" />
                    <th style={{ ...thBase, cursor: 'default', textAlign: 'right' }}>GAP</th>
                    <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>PITS</th>
                    <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>ST</th>
                    <th style={{ ...thBase, cursor: 'default', width: 24 }} />
                  </tr>
                </thead>
                <tbody>
                  {displayedDrivers.map((d, idx) => {
                    const compareIdx = compareDriverIds.indexOf(d.id)
                    return (
                      <DetailRow
                        key={d.id}
                        driver={d}
                        overallBest={overallBest}
                        classBest={classBests[d.car_class ?? ''] ?? -1}
                        onSelect={() => openDriver(d)}
                        rowIndex={idx}
                        compareMode={compareMode}
                        inCompare={compareIdx >= 0}
                        compareColor={compareIdx >= 0 ? driverColor(compareIdx) : null}
                        onToggleCompare={() => toggleCompareDriver(d)}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Events tab */}
          {detailTab === 'events' && (
            <EventsPanel data={eventsData} loading={eventsLoading} />
          )}
        </div>
      )}

      {/* Driver detail */}
      {view === 'driver_detail' && selectedDriver && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Driver info strip */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '6px 14px',
            background: '#0e0e0e',
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
            flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: selectedDriver.is_player ? colors.accent : colors.text }}>
              {selectedDriver.is_player ? '★ ' : ''}{selectedDriver.name}
            </span>
            {selectedDriver.car_number !== null && (
              <span style={{ fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono }}>
                #{selectedDriver.car_number}
              </span>
            )}
            {selectedDriver.car_class && (
              <span style={{
                background: getClassColor(selectedDriver.car_class) + '28',
                border: `1px solid ${getClassColor(selectedDriver.car_class)}`,
                color: getClassColor(selectedDriver.car_class),
                borderRadius: 3,
                padding: '1px 5px',
                fontSize: 11,
                fontWeight: 700,
              }}>
                {selectedDriver.car_class}
              </span>
            )}
            {selectedDriver.team_name && (
              <span style={{ fontSize: 11, color: colors.textMuted }}>{selectedDriver.team_name}</span>
            )}
            <span style={{ fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono }}>
              Best: {fmtLap(selectedDriver.best_lap_time)}
            </span>
            <div style={{ flex: 1 }} />
            {/* Tab toggle */}
            {(['laps', 'stints'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setDriverDetailTab(tab)}
                style={{
                  background: driverDetailTab === tab ? colors.primary + '22' : 'transparent',
                  border: `1px solid ${driverDetailTab === tab ? colors.primary : colors.border}`,
                  color: driverDetailTab === tab ? colors.primary : colors.textMuted,
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: driverDetailTab === tab ? 700 : 400,
                  padding: '3px 14px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  letterSpacing: 0.5,
                }}
              >
                {tab === 'laps' ? 'LAPS' : 'STINTS'}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {driverDetailTab === 'laps' && (
              driverLaps.has(selectedDriver.id)
                ? <ServerLapDetail
                    laps={driverLaps.get(selectedDriver.id)!}
                    overallBest={overallBest > 0 ? overallBest : 0}
                  />
                : (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 120, color: colors.textMuted, fontFamily: fonts.mono, fontSize: 13,
                  }}>
                    Loading laps…
                  </div>
                )
            )}
            {driverDetailTab === 'stints' && (
              driverStints.has(selectedDriver.id)
                ? <StintSummaryView
                    stints={driverStints.get(selectedDriver.id)!}
                    laps={driverLaps.get(selectedDriver.id) ?? null}
                  />
                : (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    height: 120, color: colors.textMuted, fontFamily: fonts.mono, fontSize: 13,
                  }}>
                    Loading stints…
                  </div>
                )
            )}
          </div>
        </div>
      )}

      {/* Compare view */}
      {view === 'compare' && (
        <CompareView
          compareDriverIds={compareDriverIds}
          compareDriverInfo={compareDriverInfo}
          compareResult={compareResult}
          compareLaps={compareLaps}
          compareStints={compareStints}
          compareTab={compareTab}
          onTabChange={setCompareTab}
        />
      )}

        </div>{/* end scalable inner */}
      </div>{/* end scalable wrapper */}
    </div>
  )
}
