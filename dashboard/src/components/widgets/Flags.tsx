/*
 * Flags Widget — LMU Pitwall
 *
 * ─── Header Analysis (from bridge/src/shared_memory/types.rs + protocol/messages.rs) ───
 *
 * SOURCE: VehicleStatusUpdate (WebSocket, ~5 Hz)
 *
 * player_flag (u8) — mFlag from rF2VehicleScoring.
 *   SDK currently only uses: 0 = no flag (green), 6 = blue flag
 *   Yellow/red/checkered are NOT communicated via mFlag in LMU.
 *
 * individual_phase (u8) — mIndividualPhase per-vehicle game phase:
 *   10 = under yellow  ← authoritative yellow indicator for this car
 *   11 = under blue (unused in LMU)
 *
 * yellow_flag_state (i32) — session-wide FCY/yellow state from rF2ScoringInfo.mYellowFlagState:
 *   -1 = no scoring data
 *    0 = none
 *    1 = pending
 *    2 = pits closed
 *    3 = pit lead lap
 *    4 = pits open
 *    5 = last lap
 *    6 = resume
 *    7 = race halt
 *
 * game_phase (u8) — from rF2ScoringInfo.mGamePhase:
 *   0 = garage, 1 = warmup, 2 = gridwalk, 3 = formation, 5 = green,
 *   6 = full-caution (FCY), 7 = stopped, 8 = over
 *
 * sector_flags [i32; 3] — local yellow per sector from rF2ScoringInfo.mSectorFlag[3]:
 *   1 = yellow active in that sector, 11 = clear (default)
 *   NOTE: LMU does NOT use 0 as "clear" — the default value is 11. Use === 1 to detect yellow.
 *
 * player_under_yellow (bool) — from rF2VehicleScoring.mUnderYellow
 *   NOTE: Only set when crossing S/F under FCY. NOT set for local sector yellows.
 *
 * safety_car_active (bool) — from rF2Rules.mSafetyCarActive
 * safety_car_exists (bool) — from rF2Rules.mSafetyCarExists
 *
 * start_light (u8) — from rF2ScoringInfo.mStartLight:
 *   0 = off, 1–5 = red lights (count), 6 = green (go!)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useTelemetryStore } from '../../stores/telemetryStore'
import { colors, fonts } from '../../styles/theme'

// ─── Flag definitions ───────────────────────────────────────────────────────

interface FlagStyle {
  label: string
  bg: string
  text: string
  pulse?: boolean
  border?: string
  checkered?: boolean
}

// Flag style table — keyed by logical flag index (not raw mFlag value):
//   0 = GREEN (no flag / default)
//   1 = BLUE  (mFlag === 6 in LMU SDK)
//   2 = YELLOW (sector yellow or mIndividualPhase === 10)
const FLAG_STYLES: Record<number, FlagStyle> = {
  0: { label: 'GREEN',  bg: '#14532d', text: '#4ade80' },
  1: { label: 'BLUE',   bg: '#1e3a8a', text: '#93c5fd', pulse: true },
  2: { label: 'YELLOW', bg: '#713f12', text: '#facc15' },
}

// Map player_sector (1=S1, 2=S2, 0=S3, -1=unknown) to sectorFlags index (0–2).
function sectorFlagsIndex(playerSector: number): number {
  if (playerSector === 1) return 0
  if (playerSector === 2) return 1
  if (playerSector === 0) return 2
  return -1
}

// Derive logical flag index from raw LMU data.
// mFlag only uses 0/6. Local yellow is detected via mIndividualPhase === 10
// (FCY) or sectorFlags[player's sector] === 1 (local sector yellow).
function resolveFlag(
  playerFlag: number,
  individualPhase: number,
  sectorFlags: [number, number, number],
  playerSector: number,
): number {
  if (playerFlag === 6) return 1  // blue flag
  if (individualPhase === 10) return 2  // FCY / explicit under-yellow
  const idx = sectorFlagsIndex(playerSector)
  if (idx >= 0 && sectorFlags[idx] === 1) return 2  // local sector yellow
  return 0
}

const UNKNOWN_FLAG: FlagStyle = { label: '—', bg: '#1a1a1a', text: colors.textMuted }

// Yellow flag state labels shown as sub-line during FCY phases
const FCY_LABELS: Record<number, string> = {
  1: 'PENDING',
  2: 'PITS CLOSED',
  3: 'PIT LEAD LAP',
  4: 'PITS OPEN',
  5: 'LAST LAP',
  7: 'RACE HALT',
}

// ─── Pulse keyframe (injected once) ─────────────────────────────────────────

const STYLE_ID = 'flags-widget-keyframes'
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    @keyframes flags-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.55; }
    }
    @keyframes sector-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.45; }
    }
  `
  document.head.appendChild(s)
}

// ─── Checkered background helper ────────────────────────────────────────────

const CHECKERED_BG =
  'repeating-conic-gradient(#333 0% 25%, #111 0% 50%) 0 0 / 20px 20px'

// ─── Sub-components ──────────────────────────────────────────────────────────

function MainFlagBanner({
  playerFlag,
  individualPhase,
  safetyCarActive,
  yellowFlagState,
  gamePhase,
  startLight,
  sectorFlags,
  playerSector,
}: {
  playerFlag: number
  individualPhase: number
  safetyCarActive: boolean
  yellowFlagState: number
  gamePhase: number
  startLight: number
  sectorFlags: [number, number, number]
  playerSector: number
}) {
  const style = FLAG_STYLES[resolveFlag(playerFlag, individualPhase, sectorFlags, playerSector)] ?? UNKNOWN_FLAG
  const isFCY = gamePhase === 6 || safetyCarActive
  const fcySubLabel = FCY_LABELS[yellowFlagState]

  // Start lights take over the banner when active
  if (startLight > 0 && startLight < 6) {
    return (
      <StartLightsDisplay count={startLight} />
    )
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      border: `2px solid ${style.border ?? style.bg}`,
      background: style.checkered ? CHECKERED_BG : style.bg,
      position: 'relative',
      overflow: 'hidden',
      animation: style.pulse ? 'flags-pulse 1.1s ease-in-out infinite' : undefined,
      minHeight: 64,
    }}>
      {/* SC / FCY badge */}
      {isFCY && (
        <div style={{
          position: 'absolute',
          top: 6,
          right: 8,
          padding: '1px 7px',
          borderRadius: 3,
          background: safetyCarActive ? '#f97316' : '#facc15',
          color: '#000',
          fontFamily: fonts.body,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1,
        }}>
          {safetyCarActive ? 'SC' : 'FCY'}
        </div>
      )}

      <span style={{
        fontFamily: fonts.heading,
        fontSize: 44,
        lineHeight: 1,
        color: style.text,
        letterSpacing: 3,
        textTransform: 'uppercase',
      }}>
        {style.label}
      </span>

      {isFCY && fcySubLabel && (
        <span style={{
          fontFamily: fonts.body,
          fontSize: 11,
          color: style.text,
          opacity: 0.75,
          letterSpacing: 2,
          marginTop: 3,
        }}>
          {fcySubLabel}
        </span>
      )}
    </div>
  )
}

function StartLightsDisplay({ count }: { count: number }) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      background: '#1a1a1a',
      border: `2px solid ${colors.border}`,
      gap: 8,
      minHeight: 64,
    }}>
      <div style={{
        fontFamily: fonts.body,
        fontSize: 12,
        color: colors.textMuted,
        letterSpacing: 2,
      }}>
        START
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: i < count ? '#ef4444' : '#2a2a2a',
            border: `1px solid ${i < count ? '#f87171' : '#3a3a3a'}`,
            boxShadow: i < count ? '0 0 8px #ef444488' : 'none',
          }} />
        ))}
      </div>
    </div>
  )
}

function SectorFlags({ sectorFlags }: {
  sectorFlags: [number, number, number]
}) {
  const labels = ['S1', 'S2', 'S3']

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {labels.map((lbl, i) => {
        // LMU uses 1 = yellow, 11 = clear. No gate needed — 11 won't falsely trigger.
        const isYellow = sectorFlags[i] === 1
        return (
          <div key={i} style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '5px 4px',
            borderRadius: 5,
            background: isYellow ? '#713f12' : '#1a1a1a',
            border: `1px solid ${isYellow ? '#facc15' : colors.border}`,
            animation: isYellow ? 'sector-pulse 1.4s ease-in-out infinite' : undefined,
          }}>
            <span style={{
              fontFamily: fonts.body,
              fontSize: 11,
              color: isYellow ? '#facc15' : colors.textMuted,
              letterSpacing: 1,
              fontWeight: 700,
            }}>
              {lbl}
            </span>
            <span style={{
              fontFamily: fonts.body,
              fontSize: 9,
              color: isYellow ? '#fde68a' : '#3a3a3a',
              letterSpacing: 0.5,
              marginTop: 1,
            }}>
              {isYellow ? 'YLW' : '●'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Main widget ─────────────────────────────────────────────────────────────

export default function Flags() {
  const vs = useTelemetryStore((s) => s.vehicleStatus)

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '10px 12px',
      gap: 8,
      boxSizing: 'border-box',
    }}>
      <MainFlagBanner
        playerFlag={vs.player_flag}
        individualPhase={vs.individual_phase}
        safetyCarActive={vs.safety_car_active}
        yellowFlagState={vs.yellow_flag_state}
        gamePhase={vs.game_phase}
        startLight={vs.start_light}
        sectorFlags={vs.sector_flags as [number, number, number]}
        playerSector={vs.player_sector}
      />

      <SectorFlags
        sectorFlags={vs.sector_flags as [number, number, number]}
      />
    </div>
  )
}
