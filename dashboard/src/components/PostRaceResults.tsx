import React, { useState, useRef, useMemo, memo } from 'react'
import { colors, fonts } from '../styles/theme'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LapRecord {
  num: number
  pos: number
  time: number | null
  et: number
  s1?: number
  s2?: number
  s3?: number
  topspeed: number
  fuel: number       // 0–1 fraction remaining
  fuelUsed: number
  twfl: number       // tire wear remaining (1.0 = fresh)
  twfr: number
  twrl: number
  twrr: number
  fcompound: string  // e.g. "Medium"
  rcompound: string
  isPit: boolean
}

interface DriverResult {
  name: string
  carClass: string
  carNumber: string
  teamName: string
  vehName: string
  position: number
  classPosition: number
  gridPos: number
  bestLapTime: number
  finishTime: number
  totalLaps: number
  pitstops: number
  finishStatus: string
  isPlayer: boolean
  laps: LapRecord[]
  bestTopSpeed: number
  finalTires: [number, number, number, number]
  lastFCompound: string
  lastRCompound: string
}

interface RaceData {
  trackVenue: string
  trackEvent: string
  trackLength: number
  timeString: string
  raceDurationMinutes: number
  fuelMult: number
  tireMult: number
  sessionType: string   // 'Race', 'Qualifying', 'Practice', 'Warmup', etc.
  drivers: DriverResult[]
}

interface SessionEntry {
  name: string       // filename
  data: RaceData
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function fmtLap(secs: number | null): string {
  if (secs === null || secs <= 0 || !isFinite(secs)) return '--:--.---'
  const m = Math.floor(secs / 60)
  const s = secs - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

function fmtSec(v?: number): string {
  if (!v || v <= 0) return '–'
  return v.toFixed(3)
}

function wearColor(w: number): string {
  if (w >= 0.85) return '#22c55e'
  if (w >= 0.65) return '#facc15'
  if (w >= 0.40) return '#f97316'
  return '#ef4444'
}

function parseCompound(raw: string | null): string {
  if (!raw) return '?'
  const idx = raw.indexOf(',')
  return idx >= 0 ? raw.slice(idx + 1).trim() : raw
}

const KNOWN_CLASS_COLORS: Record<string, string> = {
  Hypercar:   '#e11d48',
  LMP2:       '#2563eb',
  LMP2_ELMS:  '#2563eb',
  LMGT3:      '#16a34a',
  GT3:        '#16a34a',
  LMP3:       '#7c3aed',
}
const CLASS_PALETTE = ['#0891b2', '#d97706', '#059669', '#9333ea', '#dc2626']

function clsColor(cls: string, all: string[]): string {
  return KNOWN_CLASS_COLORS[cls]
    ?? CLASS_PALETTE[all.indexOf(cls) % CLASS_PALETTE.length]
    ?? '#737373'
}

function finishLabel(status: string): { text: string; color: string } {
  if (status === 'Finished Normally') return { text: 'FIN',  color: colors.success }
  if (status === 'DNF')               return { text: 'DNF',  color: colors.danger }
  if (status === 'DQ')                return { text: 'DQ',   color: colors.danger }
  if (status === 'None')              return { text: '–',    color: colors.textMuted }
  return { text: status.slice(0, 4).toUpperCase(), color: colors.textMuted }
}

// ── Session type helpers ───────────────────────────────────────────────────────

function inferSessionType(xmlValue: string, fileName: string): string {
  const check = (src: string) => {
    const v = src.toLowerCase()
    if (v.includes('race'))    return 'Race'
    if (v.includes('qual'))    return 'Qualifying'
    if (v.includes('prac'))    return 'Practice'
    if (v.includes('warm'))    return 'Warmup'
    return null
  }
  return check(xmlValue) ?? check(fileName) ?? (xmlValue.trim() || 'Session')
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

// ── XML Parser ─────────────────────────────────────────────────────────────────

function fv(s: string | null | undefined): number {
  const v = parseFloat(s ?? '')
  return isNaN(v) ? 0 : v
}

function iv(s: string | null | undefined): number {
  const v = parseInt(s ?? '', 10)
  return isNaN(v) ? 0 : v
}

function getTextContent(parent: Element, tag: string): string {
  return parent.querySelector(tag)?.textContent?.trim() ?? ''
}

function parseRaceXML(xmlText: string, fileName = ''): RaceData {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')

  if (doc.querySelector('parsererror')) {
    throw new Error('XML parse error — is this a valid rFactor results file?')
  }

  const root = doc.querySelector('RaceResults')
  if (!root) throw new Error('No <RaceResults> element found')

  const drivers: DriverResult[] = []

  doc.querySelectorAll('Driver').forEach((el) => {
    const name = getTextContent(el, 'Name')
    if (!name) return

    const laps: LapRecord[] = []
    el.querySelectorAll('Lap').forEach((lapEl) => {
      const raw = lapEl.textContent?.trim() ?? ''
      const time: number | null =
        raw === '--.----' || raw === '' ? null : fv(raw)

      laps.push({
        num:       iv(lapEl.getAttribute('num')),
        pos:       iv(lapEl.getAttribute('p')),
        time,
        et:        fv(lapEl.getAttribute('et')),
        s1:        lapEl.hasAttribute('s1') ? fv(lapEl.getAttribute('s1')) : undefined,
        s2:        lapEl.hasAttribute('s2') ? fv(lapEl.getAttribute('s2')) : undefined,
        s3:        lapEl.hasAttribute('s3') ? fv(lapEl.getAttribute('s3')) : undefined,
        topspeed:  fv(lapEl.getAttribute('topspeed')),
        fuel:      fv(lapEl.getAttribute('fuel')),
        fuelUsed:  fv(lapEl.getAttribute('fuelUsed')),
        twfl:      fv(lapEl.getAttribute('twfl')),
        twfr:      fv(lapEl.getAttribute('twfr')),
        twrl:      fv(lapEl.getAttribute('twrl')),
        twrr:      fv(lapEl.getAttribute('twrr')),
        fcompound: parseCompound(lapEl.getAttribute('fcompound')),
        rcompound: parseCompound(lapEl.getAttribute('rcompound')),
        isPit:     lapEl.getAttribute('pit') === '1',
      })
    })

    const bestTopSpeed = laps.reduce((m, l) => Math.max(m, l.topspeed), 0)
    const last = laps[laps.length - 1]
    const finalTires: [number, number, number, number] = last
      ? [last.twfl, last.twfr, last.twrl, last.twrr]
      : [1, 1, 1, 1]

    drivers.push({
      name,
      carClass:      getTextContent(el, 'CarClass'),
      carNumber:     getTextContent(el, 'CarNumber'),
      teamName:      getTextContent(el, 'TeamName'),
      vehName:       getTextContent(el, 'VehName'),
      position:      iv(getTextContent(el, 'Position')),
      classPosition: iv(getTextContent(el, 'ClassPosition')),
      gridPos:       iv(getTextContent(el, 'GridPos')),
      bestLapTime:   fv(getTextContent(el, 'BestLapTime')),
      finishTime:    fv(getTextContent(el, 'FinishTime')),
      totalLaps:     iv(getTextContent(el, 'Laps')),
      pitstops:      iv(getTextContent(el, 'Pitstops')),
      finishStatus:  getTextContent(el, 'FinishStatus'),
      isPlayer:      getTextContent(el, 'isPlayer') === '1',
      laps,
      bestTopSpeed,
      finalTires,
      lastFCompound: last?.fcompound ?? '?',
      lastRCompound: last?.rcompound ?? '?',
    })
  })

  // Sort by overall finish position; unclassified to bottom
  drivers.sort((a, b) => {
    if (a.position <= 0 && b.position <= 0) return 0
    if (a.position <= 0) return 1
    if (b.position <= 0) return -1
    return a.position - b.position
  })

  // Detect session type: prefer explicit tags, then presence of <Race>/<Qualifying>/etc. child element
  const rawSession = getTextContent(root, 'RaceSession') || getTextContent(root, 'SessionType') || ''
  const sessionTagType = root.querySelector('Race') ? 'Race'
    : root.querySelector('Qualifying') ? 'Qualifying'
    : root.querySelector('Practice') ? 'Practice'
    : root.querySelector('Warmup') ? 'Warmup'
    : ''

  return {
    trackVenue:            getTextContent(root, 'TrackVenue'),
    trackEvent:            getTextContent(root, 'TrackEvent'),
    trackLength:           fv(getTextContent(root, 'TrackLength')),
    timeString:            getTextContent(root, 'TimeString'),
    raceDurationMinutes:   iv(getTextContent(root, 'RaceTime')),
    fuelMult:              fv(getTextContent(root, 'FuelMult')),
    tireMult:              fv(getTextContent(root, 'TireMult')),
    sessionType:           sessionTagType || inferSessionType(rawSession, fileName),
    drivers,
  }
}

// ── Tire wear mini grid ────────────────────────────────────────────────────────

const TIRE_LABELS = ['FL', 'FR', 'RL', 'RR'] as const

function TireGrid({ tires }: { tires: [number, number, number, number] }) {
  const tip = tires.map((w, i) => `${TIRE_LABELS[i]}: ${Math.round(w * 100)}%`).join(' | ')
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: '1fr 1fr', gap: 2 }} title={tip}>
      {tires.map((w, i) => (
        <div
          key={i}
          style={{ width: 14, height: 7, background: wearColor(w), borderRadius: 1 }}
        />
      ))}
    </div>
  )
}

// ── Tire wear numeric 2×2 ─────────────────────────────────────────────────────

function TireWearNumeric({ tires }: { tires: [number, number, number, number] }) {
  const [fl, fr, rl, rr] = tires
  const cell = (label: string, w: number): React.ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 9, color: '#555', fontFamily: 'monospace', lineHeight: 1 }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: wearColor(w), fontFamily: 'monospace', lineHeight: 1 }}>
        {Math.round(w * 100)}%
      </span>
    </div>
  )
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
      {cell('FL', fl)}
      {cell('FR', fr)}
      {cell('RL', rl)}
      {cell('RR', rr)}
    </div>
  )
}

// ── Compound badge ─────────────────────────────────────────────────────────────

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
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.3,
      whiteSpace: 'nowrap',
    }}>
      {name}
    </span>
  )
}

// ── Session type badge ─────────────────────────────────────────────────────────

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

// ── Expanded lap detail ────────────────────────────────────────────────────────

const LapDetail = memo(function LapDetail({ laps, overallBest }: {
  laps: LapRecord[]
  overallBest: number
}) {
  const thStyle: React.CSSProperties = {
    padding: '3px 6px',
    borderBottom: `1px solid ${colors.border}`,
    color: colors.primary,
    fontFamily: fonts.body,
    fontSize: 11,
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
    fontSize: 12,
    color: colors.text,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  }

  const personalBest = laps.reduce((best, l) => {
    if (l.time === null || l.time <= 0 || l.isPit) return best
    return best === null || l.time < best ? l.time : best
  }, null as number | null)

  return (
    <div style={{ overflowX: 'auto', background: '#0e0e0e', borderTop: `1px solid ${colors.border}` }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 800 }}>
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
            <th style={{ ...thStyle, textAlign: 'center' }}>TIRE WEAR</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>CPND</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>PIT</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap, idx) => {
            const isOBest = overallBest > 0 && lap.time !== null && lap.time === overallBest
            const isPBest = personalBest !== null && lap.time !== null && lap.time === personalBest && !isOBest
            const timeColor = isOBest ? '#c026d3' : isPBest ? '#22c55e' : colors.text
            const rowBg = lap.isPit
              ? '#1b1a10'
              : idx % 2 === 0 ? '#111' : '#0e0e0e'

            return (
              <tr key={lap.num} style={{ background: rowBg }}>
                <td style={{ ...tdBase, color: colors.textMuted }}>{lap.num}</td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{lap.pos}</td>
                <td style={{ ...tdBase, color: timeColor, fontWeight: isOBest || isPBest ? 700 : 400 }}>
                  {fmtLap(lap.time)}
                </td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(lap.s1)}</td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(lap.s2)}</td>
                <td style={{ ...tdBase, color: colors.textMuted }}>{fmtSec(lap.s3)}</td>
                <td style={{ ...tdBase }}>{lap.topspeed > 0 ? lap.topspeed.toFixed(1) : '–'}</td>
                <td style={{ ...tdBase }}>{Math.round(lap.fuel * 100)}%</td>
                <td style={{ ...tdBase, textAlign: 'center' }}>
                  <TireWearNumeric tires={[lap.twfl, lap.twfr, lap.twrl, lap.twrr]} />
                </td>
                <td style={{ ...tdBase, textAlign: 'center' }}>
                  <CompoundBadge name={lap.fcompound} />
                </td>
                <td style={{ ...tdBase, textAlign: 'center', color: colors.accent }}>
                  {lap.isPit ? 'PIT' : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

// ── Main results table row ─────────────────────────────────────────────────────

interface ResultRowProps {
  driver: DriverResult
  allClasses: string[]
  gap: string
  overallBest: number
  classBest: number
  expanded: boolean
  onToggle: () => void
  rowIndex: number
}

const ResultRow = memo(function ResultRow({
  driver, allClasses, gap, overallBest, classBest, expanded, onToggle, rowIndex,
}: ResultRowProps) {
  const cc = clsColor(driver.carClass, allClasses)
  const fl = finishLabel(driver.finishStatus)
  const isLeader = gap === 'LEAD'
  const rowBg = expanded
    ? colors.bgCard + 'cc'
    : rowIndex % 2 === 0 ? colors.bg : '#141414'

  const cell: React.CSSProperties = {
    padding: '4px 7px',
    borderBottom: `1px solid ${colors.border}`,
    verticalAlign: 'middle',
    fontSize: 13,
    color: colors.text,
    fontFamily: fonts.body,
    whiteSpace: 'nowrap',
  }

  const isOverallBest = overallBest > 0 && driver.bestLapTime > 0 && driver.bestLapTime === overallBest
  const isClassBest   = !isOverallBest && classBest > 0 && driver.bestLapTime === classBest
  const bestColor = isOverallBest ? '#c026d3' : isClassBest ? '#22c55e' : colors.text

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          background: rowBg,
          cursor: 'pointer',
          borderLeft: `3px solid ${expanded ? cc : 'transparent'}`,
          transition: 'background 0.1s',
        }}
        title="Click to expand lap detail"
      >
        {/* Overall position */}
        <td style={{ ...cell, color: colors.primary, fontFamily: fonts.heading, fontSize: 22, width: 42, textAlign: 'right', paddingRight: 8 }}>
          {driver.position > 0 ? driver.position : '–'}
        </td>

        {/* Class position */}
        <td style={{ ...cell, width: 36, textAlign: 'center' }}>
          {driver.classPosition > 0 && (
            <span style={{
              background: cc,
              color: '#fff',
              borderRadius: 3,
              padding: '1px 5px',
              fontSize: 11,
              fontWeight: 700,
            }}>
              C{driver.classPosition}
            </span>
          )}
        </td>

        {/* Car # */}
        <td style={{ ...cell, width: 38, textAlign: 'center', fontFamily: fonts.mono, color: colors.textMuted }}>
          #{driver.carNumber}
        </td>

        {/* Driver + team */}
        <td style={{ ...cell, maxWidth: 200 }}>
          <div style={{
            fontWeight: 600, fontSize: 13,
            overflow: 'hidden', textOverflow: 'ellipsis',
            color: driver.isPlayer ? colors.accent : colors.text,
          }}>
            {driver.isPlayer ? '★ ' : ''}{driver.name}
          </div>
          <div style={{ fontSize: 10, color: colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {driver.teamName}
          </div>
        </td>

        {/* Class badge */}
        <td style={{ ...cell, width: 90 }}>
          <span style={{
            background: cc + '28',
            border: `1px solid ${cc}`,
            color: cc,
            borderRadius: 3,
            padding: '1px 5px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}>
            {driver.carClass || '—'}
          </span>
        </td>

        {/* Laps */}
        <td style={{ ...cell, width: 42, textAlign: 'center', color: colors.textMuted }}>
          {driver.totalLaps}
        </td>

        {/* Best lap */}
        <td style={{ ...cell, width: 105, textAlign: 'right', fontFamily: fonts.mono, color: bestColor, fontWeight: isOverallBest || isClassBest ? 700 : 400 }}>
          {fmtLap(driver.bestLapTime)}
        </td>

        {/* Gap */}
        <td style={{ ...cell, width: 100, textAlign: 'right', fontFamily: fonts.mono, color: isLeader ? colors.success : colors.textMuted, fontSize: 12 }}>
          {gap}
        </td>

        {/* Pits */}
        <td style={{ ...cell, width: 38, textAlign: 'center' }}>
          {driver.pitstops}
        </td>

        {/* Final tire wear */}
        <td style={{ ...cell, width: 72, textAlign: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <TireGrid tires={driver.finalTires} />
            <TireWearNumeric tires={driver.finalTires} />
          </div>
        </td>

        {/* Compound */}
        <td style={{ ...cell, width: 80, textAlign: 'center' }}>
          <CompoundBadge name={driver.lastFCompound} />
        </td>

        {/* Top speed */}
        <td style={{ ...cell, width: 82, textAlign: 'right', fontFamily: fonts.mono, fontSize: 12 }}>
          {driver.bestTopSpeed > 0 ? `${driver.bestTopSpeed.toFixed(1)}` : '–'}
        </td>

        {/* Grid pos */}
        <td style={{ ...cell, width: 42, textAlign: 'center', color: colors.textMuted, fontSize: 12 }}>
          P{driver.gridPos}
        </td>

        {/* Status */}
        <td style={{ ...cell, width: 48, textAlign: 'center' }}>
          <span style={{ color: fl.color, fontWeight: 700, fontSize: 12 }}>{fl.text}</span>
        </td>

        {/* Expand indicator */}
        <td style={{ ...cell, width: 20, textAlign: 'center', color: colors.textMuted, fontSize: 12 }}>
          {expanded ? '▲' : '▼'}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={15} style={{ padding: 0, borderBottom: `2px solid ${cc}` }}>
            <LapDetail laps={driver.laps} overallBest={overallBest} />
          </td>
        </tr>
      )}
    </>
  )
})

// ── Empty / load state ─────────────────────────────────────────────────────────

function EmptyState({ onLoad, onLoadFolder, hasDirPicker }: {
  onLoad: () => void
  onLoadFolder: () => void
  hasDirPicker: boolean
}) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 20,
      color: colors.textMuted,
      fontFamily: fonts.body,
    }}>
      <div style={{ fontSize: 72, opacity: 0.15 }}>📋</div>
      <div style={{ fontSize: 22, color: colors.text, fontWeight: 600 }}>Session Results</div>
      <div style={{ fontSize: 14, opacity: 0.6, textAlign: 'center', maxWidth: 480 }}>
        Load XML result files generated by Le Mans Ultimate.<br />
        Files are saved in: <code style={{ color: colors.primary }}>UserData\Log\Results\</code>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        {hasDirPicker && (
          <button
            onClick={onLoadFolder}
            style={{
              background: colors.primary,
              border: 'none',
              color: '#000',
              fontFamily: fonts.body,
              fontSize: 15,
              fontWeight: 700,
              padding: '10px 24px',
              borderRadius: 4,
              cursor: 'pointer',
              letterSpacing: 0.5,
            }}
          >
            Open Results Folder…
          </button>
        )}
        <button
          onClick={onLoad}
          style={{
            background: hasDirPicker ? colors.bgWidget : colors.primary,
            border: hasDirPicker ? `1px solid ${colors.border}` : 'none',
            color: hasDirPicker ? colors.text : '#000',
            fontFamily: fonts.body,
            fontSize: 15,
            fontWeight: 700,
            padding: '10px 24px',
            borderRadius: 4,
            cursor: 'pointer',
            letterSpacing: 0.5,
          }}
        >
          Open XML File(s)…
        </button>
      </div>
      <div style={{ fontSize: 12, opacity: 0.4 }}>
        Files are read locally — nothing is uploaded
      </div>
    </div>
  )
}

// ── Session navigator ──────────────────────────────────────────────────────────

function SessionNav({
  sessions,
  currentIdx,
  onSelect,
}: {
  sessions: SessionEntry[]
  currentIdx: number
  onSelect: (i: number) => void
}) {
  if (sessions.length === 0) return null
  const total = sessions.length
  const canPrev = currentIdx > 0
  const canNext = currentIdx < total - 1

  const btnStyle = (enabled: boolean): React.CSSProperties => ({
    background: 'transparent',
    border: `1px solid ${enabled ? colors.border : colors.border + '44'}`,
    color: enabled ? colors.text : colors.textMuted + '44',
    fontFamily: fonts.mono,
    fontSize: 14,
    width: 28,
    height: 28,
    borderRadius: 3,
    cursor: enabled ? 'pointer' : 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <button
        style={btnStyle(canPrev)}
        onClick={() => canPrev && onSelect(currentIdx - 1)}
        title="Newer session"
      >
        ‹
      </button>
      <span style={{
        fontSize: 12,
        color: colors.textMuted,
        fontFamily: fonts.mono,
        minWidth: 44,
        textAlign: 'center',
        userSelect: 'none',
      }}>
        {currentIdx + 1} / {total}
      </span>
      <button
        style={btnStyle(canNext)}
        onClick={() => canNext && onSelect(currentIdx + 1)}
        title="Older session"
      >
        ›
      </button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const hasDirPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window

export default function PostRaceResults({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions]         = useState<SessionEntry[]>([])
  const [currentIdx, setCurrentIdx]     = useState(0)
  const [error, setError]               = useState<string | null>(null)
  const [loading, setLoading]           = useState(false)
  const [classFilter, setClassFilter]   = useState<string>('All')
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null)
  const [sortCol, setSortCol]           = useState<'pos' | 'best' | 'speed' | 'laps'>('pos')
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('asc')

  const fileInputRef = useRef<HTMLInputElement>(null)

  const raceData: RaceData | null = sessions[currentIdx]?.data ?? null
  const fileName: string = sessions[currentIdx]?.name ?? ''

  function resetView() {
    setClassFilter('All')
    setExpandedDriver(null)
    setSortCol('pos')
    setSortDir('asc')
    setError(null)
  }

  function selectSession(idx: number) {
    setCurrentIdx(idx)
    resetView()
  }

  // Merge new entries: deduplicate by name, sort newest-first (by name = timestamp prefix), max 10
  function mergeSessions(incoming: SessionEntry[]) {
    setSessions((prev) => {
      const map = new Map<string, SessionEntry>()
      for (const s of prev)      map.set(s.name, s)
      for (const s of incoming)  map.set(s.name, s)
      const merged = Array.from(map.values())
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, 10)
      return merged
    })
    setCurrentIdx(0)
  }

  async function loadFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.xml'))
    if (arr.length === 0) return
    setLoading(true)
    const results: SessionEntry[] = []
    for (const file of arr) {
      try {
        const text = await file.text()
        const data = parseRaceXML(text, file.name)
        results.push({ name: file.name, data })
      } catch {
        // skip unreadable files silently when loading multiple
        if (arr.length === 1) setError((new Error(`Failed to parse "${file.name}"`)).message)
      }
    }
    if (results.length > 0) {
      mergeSessions(results)
      resetView()
    }
    setLoading(false)
  }

  const openFile = () => fileInputRef.current?.click()

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadFiles(e.target.files)
    }
    e.target.value = ''
  }

  async function openFolder() {
    if (!hasDirPicker) return
    try {
      // @ts-ignore — File System Access API
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' })
      setLoading(true)
      const files: File[] = []
      // @ts-ignore
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.xml')) {
          // @ts-ignore
          const file: File = await entry.getFile()
          files.push(file)
        }
      }
      // Sort by name desc (newest first due to timestamp prefix), take 10
      files.sort((a, b) => b.name.localeCompare(a.name))
      await loadFiles(files.slice(0, 10))
    } catch (err: unknown) {
      // User cancelled picker — not an error
      if ((err as Error)?.name !== 'AbortError') {
        setError(`Could not open folder: ${(err as Error).message}`)
      }
      setLoading(false)
    }
  }

  // Distinct class list in order of first appearance
  const allClasses = useMemo(() => {
    if (!raceData) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const d of raceData.drivers) {
      if (d.carClass && !seen.has(d.carClass)) {
        seen.add(d.carClass)
        out.push(d.carClass)
      }
    }
    return out
  }, [raceData])

  // Per-class leader for gap computation
  const classLeaders = useMemo(() => {
    if (!raceData) return {}
    const map: Record<string, DriverResult> = {}
    for (const d of raceData.drivers) {
      if (d.classPosition === 1) map[d.carClass] = d
    }
    return map
  }, [raceData])

  function computeGap(d: DriverResult): string {
    if (d.classPosition === 1) return 'LEAD'
    if (d.finishStatus === 'DNF' || d.finishStatus === 'DQ') return d.finishStatus
    const leader = classLeaders[d.carClass]
    if (!leader) return '–'
    if (d.totalLaps < leader.totalLaps) {
      const n = leader.totalLaps - d.totalLaps
      return `+${n} lap${n > 1 ? 's' : ''}`
    }
    if (leader.finishTime > 0 && d.finishTime > 0) {
      const delta = d.finishTime - leader.finishTime
      return delta >= 0 ? `+${delta.toFixed(3)}s` : 'LEAD'
    }
    return '–'
  }

  const overallBest = useMemo(() => {
    if (!raceData) return -1
    const valid = raceData.drivers.map((d) => d.bestLapTime).filter((t) => t > 0)
    return valid.length > 0 ? Math.min(...valid) : -1
  }, [raceData])

  const classBests = useMemo(() => {
    if (!raceData) return {} as Record<string, number>
    const m: Record<string, number> = {}
    for (const d of raceData.drivers) {
      if (d.bestLapTime > 0) {
        if (!m[d.carClass] || d.bestLapTime < m[d.carClass]) {
          m[d.carClass] = d.bestLapTime
        }
      }
    }
    return m
  }, [raceData])

  const displayedDrivers = useMemo(() => {
    if (!raceData) return []
    let list = classFilter === 'All'
      ? raceData.drivers
      : raceData.drivers.filter((d) => d.carClass === classFilter)

    list = [...list].sort((a, b) => {
      let av: number, bv: number
      if (sortCol === 'best') {
        av = a.bestLapTime > 0 ? a.bestLapTime : 999999
        bv = b.bestLapTime > 0 ? b.bestLapTime : 999999
      } else if (sortCol === 'speed') {
        av = a.bestTopSpeed
        bv = b.bestTopSpeed
      } else if (sortCol === 'laps') {
        av = a.totalLaps
        bv = b.totalLaps
      } else {
        av = a.position > 0 ? a.position : 999
        bv = b.position > 0 ? b.position : 999
      }
      return sortDir === 'asc' ? av - bv : bv - av
    })

    return list
  }, [raceData, classFilter, sortCol, sortDir])

  function onSort(col: typeof sortCol) {
    if (col === sortCol) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

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

  const btnStyle: React.CSSProperties = {
    background: colors.bgWidget,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 3,
    cursor: 'pointer',
    flexShrink: 0,
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: colors.bg,
      fontFamily: fonts.body,
      overflow: 'hidden',
    }}>
      {/* ── Top control bar ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: colors.bgCard,
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
        flexWrap: 'wrap',
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

        {/* Session navigator */}
        {sessions.length > 0 && (
          <>
            <div style={{ width: 1, height: 20, background: colors.border }} />
            <SessionNav sessions={sessions} currentIdx={currentIdx} onSelect={selectSession} />
            {fileName && (
              <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
                {fileName}
              </span>
            )}
          </>
        )}

        {/* File open buttons */}
        <div style={{ width: 1, height: 20, background: colors.border, flexShrink: 0 }} />
        {hasDirPicker && (
          <button onClick={openFolder} style={btnStyle} disabled={loading}>
            {loading ? 'Loading…' : '📁 Open Folder'}
          </button>
        )}
        <button onClick={openFile} style={btnStyle} disabled={loading}>
          {sessions.length > 0 ? '+ Add Files' : 'Open XML File(s)…'}
        </button>

        {/* Class filter pills */}
        {raceData && (
          <>
            <div style={{ width: 1, height: 20, background: colors.border, flexShrink: 0 }} />
            {(['All', ...allClasses]).map((cls) => {
              const active = classFilter === cls
              const cc = cls !== 'All' ? clsColor(cls, allClasses) : colors.textMuted
              const count = cls === 'All'
                ? raceData.drivers.length
                : raceData.drivers.filter((d) => d.carClass === cls).length
              return (
                <button
                  key={cls}
                  onClick={() => { setClassFilter(cls); setExpandedDriver(null) }}
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
          </>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={onClose}
          title="Back to dashboard"
          style={{ ...btnStyle, color: colors.textMuted }}
        >
          ← Dashboard
        </button>
      </div>

      {/* ── Session info strip ──────────────────────────────────────────────── */}
      {raceData && (
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
          <SessionTypeBadge type={raceData.sessionType} />
          <InfoChip label="TRACK" value={raceData.trackVenue} />
          <InfoChip label="EVENT" value={raceData.trackEvent} />
          <InfoChip label="DATE" value={raceData.timeString} />
          <InfoChip label="DURATION" value={`${raceData.raceDurationMinutes} min`} />
          <InfoChip label="TRACK LENGTH" value={`${(raceData.trackLength / 1000).toFixed(3)} km`} />
          {raceData.fuelMult !== 1 && <InfoChip label="FUEL" value={`×${raceData.fuelMult}`} />}
          {raceData.tireMult !== 1 && <InfoChip label="TYRE" value={`×${raceData.tireMult}`} />}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: colors.textMuted }}>
            <span style={{ color: '#c026d3', fontWeight: 700 }}>■</span> Overall best&nbsp;&nbsp;
            <span style={{ color: '#22c55e', fontWeight: 700 }}>■</span> Class best&nbsp;&nbsp;
            <span style={{ color: colors.text }}>★</span> Player
          </span>
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 12, color: colors.danger,
        }}>
          <div style={{ fontSize: 32, opacity: 0.5 }}>⚠</div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Failed to load file</div>
          <div style={{ fontSize: 13, color: colors.textMuted, maxWidth: 400, textAlign: 'center' }}>{error}</div>
          <button
            onClick={openFile}
            style={{ marginTop: 8, ...btnStyle, fontSize: 13, padding: '6px 16px' }}
          >
            Try another file
          </button>
        </div>
      )}

      {!error && sessions.length === 0 && (
        <EmptyState onLoad={openFile} onLoadFolder={openFolder} hasDirPicker={hasDirPicker} />
      )}

      {!error && raceData && (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
            <thead>
              <tr>
                <SortTh col="pos"   label="POS"       align="right" />
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>CL</th>
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>CAR</th>
                <th style={{ ...thBase, cursor: 'default', textAlign: 'left' }}>DRIVER / TEAM</th>
                <th style={{ ...thBase, cursor: 'default' }}>CLASS</th>
                <SortTh col="laps"  label="LAPS"      align="center" />
                <SortTh col="best"  label="BEST LAP"  align="right" />
                <th style={{ ...thBase, cursor: 'default', textAlign: 'right' }}>GAP</th>
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>PITS</th>
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>TIRES</th>
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>CPND</th>
                <SortTh col="speed" label="TOP km/h"  align="right" />
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>GRID</th>
                <th style={{ ...thBase, cursor: 'default', textAlign: 'center' }}>ST</th>
                <th style={{ ...thBase, cursor: 'default', width: 20 }} />
              </tr>
            </thead>
            <tbody>
              {displayedDrivers.map((d, idx) => (
                <ResultRow
                  key={d.name}
                  driver={d}
                  allClasses={allClasses}
                  gap={computeGap(d)}
                  overallBest={overallBest}
                  classBest={classBests[d.carClass] ?? -1}
                  expanded={expandedDriver === d.name}
                  onToggle={() => setExpandedDriver((prev) => (prev === d.name ? null : d.name))}
                  rowIndex={idx}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Hidden file input — multiple files */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xml"
        multiple
        onChange={handleFile}
        style={{ display: 'none' }}
      />
    </div>
  )
}

// ── Small helper chip ──────────────────────────────────────────────────────────

function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.8, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 13, color: colors.text }}>{value || '—'}</span>
    </div>
  )
}
