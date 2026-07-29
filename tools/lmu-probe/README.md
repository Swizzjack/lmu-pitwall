# lmu-probe

Answers one question, on evidence rather than on release notes:

> **Can the bridge read everything it needs from LMU's built-in `LMU_Data`
> mapping, with `rFactor2SharedMemoryMapPlugin64.dll` not installed at all?**

Not part of the product build — a separate crate, so `make build-release` and
`scripts/release.sh` are untouched.

## What it actually proves

Three things have to hold at once, and the report is organised around them:

1. **The plugin is really gone.** All nine `$rFactor2SMMP_*$` names must fail to
   resolve. A Windows named mapping outlives its creator as long as any process
   holds a handle, so "the buffer opens" is no evidence the plugin runs — and a
   bridge left open keeps the dead buffers in the namespace, which is also why a
   frozen dashboard can look connected.
2. **`LMU_Data` is written, fast enough.** Scoring (`mCurrentET`) and telemetry
   (`mElapsedTime`) are timed separately, sampled at 200 Hz. The distinction
   matters: the scoring block ticks at ~5 Hz in every rF2-derived sim, and if the
   telemetry block did the same, TireMonitor and the pedal traces would be
   unusable after the port.
3. **Every field the bridge consumes arrives intact.** That is the coverage
   table in `src/checks.rs` — one entry per field `bridge/src/main.rs` reads
   today, checked for presence, plausibility and liveness.

The field list is taken from what the bridge reads, not from what the structs
offer. The `LMU_Data` map is decoded with the bridge's *own* structs, included
verbatim from `bridge/src/shared_memory/types.rs`: a second copy of those
definitions could drift, and then the probe would prove something about itself
rather than about the product.

### Why plausibility windows, not null checks

A struct that gained a field upstream still decodes: every offset shifts, and
what used to be a tire temperature comes back as a perfectly valid `f64` like
`3.7e-42`. "Is it non-zero" passes that. "Is it between 240 K and 500 K" does
not. The same windows settle the open V1.4 question of whether `mBrakeTemp` is
still Kelvin — section 5 prints the observed range in both readings.

A window that is too *tight* costs more than one that is loose, because it
accuses the layout of a shift that never happened. The 2026-07-29 Monza run
reported four such false IMPLAUSIBLEs, all sentinels rather than drift:
`mMaxLaps` = `i32::MAX` in a timed race, `mSectorFlag` = 11 for a green sector
(LMU encodes 1 = yellow, 11 = clear, unlike rF2), and `mLapStartET` = -1 in both
buffers because no lap had been completed. The bridge handles all three
correctly; only the probe was wrong. `known_sentinels_are_not_mistaken_for_
layout_drift` in `checks.rs` keeps the windows from being re-tightened.

Verdicts:

| verdict | meaning |
| --- | --- |
| `OK` | written, plausible, changing where it should |
| `zero (ok)` | always zero, but zero is legal here (no penalty, no impact, leading the race). The offset decodes; that the game writes it cannot be shown in a clean session |
| `STATIC` | plausible but never changed, where change was expected |
| `SUSPECT` | always zero where a car on track must produce a value |
| `IMPLAUSIBLE` | outside a believable range — the layout has most likely shifted |
| `NO DATA` | never extractable (no player car / no scoring row) |

## Build

```bash
cd tools/lmu-probe
cargo test                                          # coverage table + layout assertions, on Linux
cargo zigbuild --target x86_64-pc-windows-gnu --release
# → target/x86_64-pc-windows-gnu/release/lmu-probe.exe
```

`cargo test` is worth running first: it exercises every extractor in the
coverage table against a zeroed and a player-less snapshot, and it runs the
bridge's own layout assertions. Finding a broken table entry after a driving
session on the sim machine is the expensive way to find it.

## Run

Copy `lmu-probe.exe` to the LMU machine and run it from a terminal (it prints;
it does not open a window), **while sitting in a session, on track**:

```
lmu-probe.exe                            # 3 laps or 900 s, report to lmu-probe-report.txt
lmu-probe.exe --laps 5 --seconds 1800
lmu-probe.exe --laps 0 --seconds 120     # pure timed run, no lap condition
```

The run ends at whichever comes first, and the live line shows `laps=n/3` so
there is no guessing about when it will stop. The lap condition is not
cosmetic: `mLastLapTime`, `mLastSector1/2`, `mBestLapTime`, `mBestSector`,
`mDeltaBest`, `mTotalLaps` and per-lap fuel all hold sentinels (`0` or `-1`)
until the car first crosses the line, so a run that ends before that proves the
struct layout and nothing about lap timing. The report says so explicitly when
`Laps completed` is 0, and the PROVEN verdict is qualified in that case rather
than counting the sentinels as passes.

It writes the full report to a file as well as printing it — scrolling a console
back on the sim machine is the worst possible way to get results off it.

## The two runs that matter

**Run A — plugin removed. This is the proof.**
Rename `Le Mans Ultimate\Plugins\rFactor2SharedMemoryMapPlugin64.dll` to
something that does **not** end in `.dll` (`…dll.off`) — the plugin loader takes
every `*.dll` in that folder regardless of its name. Leave *Settings → Gameplay →
Enable Plugins* **ON**. Beforehand, close LMU Pitwall (bridge included) and every
other telemetry tool (CrewChief, SimHub, dash apps), then exit and restart the
game. Section 1 must show every `$rFactor2SMMP_*$` row as `not mapped`.

Drive the three laps it asks for, including a pit entry if convenient — a field
the session never exercises reports as unproven rather than as working. Worth
doing in a **Hypercar or LMP2**: `mVirtualEnergy` and `mBatteryChargeFraction`
have no meaning in an LMP3 and read zero there no matter how well the port
works. A wet session would likewise be the only way to exercise the four
`*PathWetness` fields and `mRaining`.

**Run B — plugin installed (optional, complementary).**
Only this run can fill section 8, which reads the same physical quantity out of
both maps at the same instant. `max |delta| = 0.000000` means switching the
bridge to `LMU_Data` changes no number the dashboard shows. It is not needed for
the proof — section 4 does that job single-handedly — but it is the cheapest
possible answer to "will anything look different afterwards".

## The known gap: safety car

`mSafetyCarActive` / `mSafetyCarExists` live in the plugin's Rules buffer and
have **no `LMU_Data` equivalent**. What LMU_Data offers instead is
`mGamePhase == 6` (full course yellow) plus `mYellowFlagState`, which covers
"is the field under caution" but not "is a safety car configured for this
session". Section 7 reports the phase/yellow combinations seen; with the plugin
installed it also cross-tabulates them against the plugin's truth.
