// Scrolling sheet view — VexFlow-engraved grand staff that follows the MasterClock.
//
// Time→x mapping with a fixed playhead; notes scroll right-to-left like
// PianoBooster's stave (ideas only — original implementation). Loop region is
// editable here by drag (create + trim handles, ✕ in the band); wrong notes
// flash red. Focus treatment borrows from Simply Piano's stave: played notes
// sink, only the immediate window reads at full strength, the playhead glows,
// and near noteheads carry their letter name.
//
// Notation is engraved once per piece with VexFlow 5.9.0 (dynamic import on
// first setData — the static bundle keeps zero VexFlow bytes): ONE long
// single-system grand staff (treble + bass Staves with clefs, no key / time
// signatures drawn), voices filled from MIDI (chords grouped ≤0.04s,
// quantized durations, greedy rest infill, beams via Beam.generateBeams,
// sharp accidentals). Per frame only the visible measure window is drawn
// (ctx.translate for scroll); xAtTime(t) interpolates the laid-out notehead X
// positions (StaveNote.getAbsoluteX/getYs) for playhead scroll, loop mapping,
// and pending/hit overlays.

// Type-only VexFlow surface — erased at compile time, so the initial bundle is
// untouched. Runtime values come from the dynamic import in ensureVF().
import type {
  Beam as VFBeam,
  CanvasContext as VFCanvasContext,
  Stave as VFStave,
  StaveNote as VFStaveNote,
  Voice as VFVoice,
} from 'vexflow'
import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiFile } from '../core/midi/types'
import { isAccidental, staffForNote } from '../learn/exercises/sight-reading/music'
import { WAIT_LOOP_MIN_SEC } from '../play/waitController'
import { hexToCSS, type Theme } from '../renderer/theme'
import type { SheetBar, TimeSample } from './sheetModel'
import {
  barXForTime,
  buildBarLines,
  buildInverseSamples,
  collapseToOnsets,
  SHEET_CHORD_GROUP_SEC,
} from './sheetModel'
import { vexSheetStyle } from './sheetTheme'

// Module-namespace type only (no runtime import).
type VF = typeof import('vexflow')

export interface SheetLoop {
  start: number
  end: number
}

interface Flash {
  pitch: number
  time: number
  until: number
}

export const SHEET_TOP_PAD = 16
export const SHEET_BOTTOM_PAD = 40
export const SHEET_MAX_LS = 30
export const SHEET_MIN_LS = 6

export interface SheetStaffGeometry {
  ls: number
  trebleTop: number
  bassTop: number
  staffBottom: number
  barTop: number
  barBottom: number
}

// Grand-staff geometry: the engraved block is 12ls tall (4ls treble + 4ls
// inter-staff gap + 4ls bass; trebleTop→bassTop is 8ls). It is centered inside
// the padded pane so neither staff clips: pad = 8px base + ~4px halo
// (playhead 8px core/2, loop inset) = 12px each side. ls tracks h
// proportionally (h/16 leaves room for stems/ledgers/halo inside the pads)
// but never exceeds the fit (avail/12), never exceeds 30px, and floors at 6px
// only when the fit allows it — small panes shrink ls instead of clipping.
// Guarantees trebleTop >= 4 and staffBottom <= h - 4.
export function sheetStaffGeometry(h: number): SheetStaffGeometry {
  const padTop = SHEET_TOP_PAD
  const padBottom = SHEET_BOTTOM_PAD
  const avail = h - padTop - padBottom
  const lsFit = avail / 12
  const lsWant = h / 16
  let ls: number
  if (!Number.isFinite(lsFit) || !Number.isFinite(lsWant)) {
    ls = SHEET_MIN_LS
  } else if (lsFit >= SHEET_MIN_LS) {
    ls = Math.min(SHEET_MAX_LS, lsWant, lsFit)
    ls = Math.max(SHEET_MIN_LS, ls)
  } else {
    // Degenerate tiny pane: preserve fit over the readable minimum.
    ls = Math.max(0.5, Math.min(SHEET_MAX_LS, lsFit))
  }
  if (!Number.isFinite(ls) || ls <= 0) ls = Math.max(0.5, Math.min(SHEET_MAX_LS, h / 12))
  let trebleTop = padTop + (avail - 12 * ls) / 2
  // Hard guarantees against float error / degenerate h.
  trebleTop = Math.max(4, Math.min(trebleTop, Math.max(4, h - 4 - 12 * ls)))
  const bassTop = trebleTop + 8 * ls
  const staffBottom = bassTop + 4 * ls
  return { ls, trebleTop, bassTop, staffBottom, barTop: trebleTop, barBottom: staffBottom }
}

const PENDING_FALLBACK = '#ffc83c'
const HIT = '#50c878'
const MISS = '#dc4646'
// Height drift below this keeps the current engraving: divider drags change
// the pane height continuously, and re-engraving every frame mid-playback
// hitches scroll + risks playhead jumps.
export const RELAYOUT_H_TOLERANCE = 2
// Settle gate for height-only re-engraving: re-engrave promptly once the
// divider stops moving, never mid-drag frame (see shouldRelayoutScore).
export const SHEET_RELAYOUT_SETTLE_MS = 60

// Single source for staff-space: BOTH layoutScore (engraving) and draw
// (live geometry) derive ls from here. Twin inline formulas drifted apart
// historically, so staff lines spread with the pane while glyphs kept the
// stale engraved size.
export function lsFromHeight(h: number): number {
  return sheetStaffGeometry(h).ls
}

// Horizontal system geometry derived from ls so the whole score scales as
// one: beat-grid density, left clef room, and trailing/format padding all
// track staff-space. Factors preserve the historic values at ls=17
// (startX 28, endPad 160, formatPad 40, minWidth 1400).
export function sheetLayoutMetrics(h: number): {
  ls: number
  startX: number
  pxPerBeat: number
  endPad: number
  formatPad: number
  minWidth: number
} {
  const ls = lsFromHeight(h)
  const startX = Math.round(ls * 1.65)
  const pxPerBeat = ls * 6.6
  const endPad = Math.round(ls * 9.4)
  const formatPad = Math.round(ls * 2.35)
  const minWidth = Math.round(ls * 82.35)
  return { ls, startX, pxPerBeat, endPad, formatPad, minWidth }
}

export function sheetScoreWidth(h: number, totalBeats: number): number {
  const { startX, pxPerBeat, endPad, minWidth } = sheetLayoutMetrics(h)
  return Math.max(minWidth, startX + totalBeats * pxPerBeat + endPad)
}

// Pure relayout predicate (exported for tests): height drift beyond
// tolerance re-engraves once the resize settles, but never mid-drag — a
// mid-gesture engraving would swap the samples under the frozen
// dragScrollX mapping and yank the region.
export function shouldRelayoutScore(
  layoutH: number,
  h: number,
  nowMs: number,
  lastResizeAtMs: number,
  dragging: boolean,
): boolean {
  if (dragging) return false
  if (Math.abs(layoutH - h) <= RELAYOUT_H_TOLERANCE) return false
  return nowMs - lastResizeAtMs > SHEET_RELAYOUT_SETTLE_MS
}
// Base letter only (accidentals carry their own ♯ from the engraving).
const BASE_LETTER = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']

// Widths derived from staff-space ls so glyphs stay proportional when the
// pane grows/shrinks: VexFlow already scales heads/stem-length/dots/
// accidentals/clefs/rests with spacingBetweenLinesPx, and these cover what it
// leaves fixed (stem thickness, beam thickness, ledger). ls comes from
// lsFromHeight (single source with layoutScore/draw). staff holds 1.5px
// (barlines match); stem tracks ls clamped to [1.2, 2.2]; beams track ls;
// ledger matches staff.
export function notationWidths(ls: number): {
  staff: number
  stem: number
  beam: number
  ledger: number
} {
  const staff = 1.5
  const stem = Math.min(2.2, Math.max(1.2, ls * 0.11))
  const beam = ls * 0.12
  const ledger = staff
  return { staff, stem, beam, ledger }
}

interface SheetPalette {
  bg: string
  staff: string
  note: string
  pending: string
  hit: string
  miss: string
  playhead: string
  loopEdge: string
  label: string
}

// ── VexFlow score model ─────────────────────────────────────────────────

interface BeatUnit {
  beats: number
  dur: string
  dots: number
}

interface ChordEvent {
  time: number
  treble: number[]
  bass: number[]
  gap: BeatUnit[]
  len: BeatUnit[]
  /** Real onset duration, seconds (max member dur, >= 0.05) — rec/hit clock. */
  dur: number
}

interface NoteRec {
  note: VFStaveNote
  time: number
  end: number
  pitches: number[]
  /** False for tied continuations of one onset split across units. */
  onset?: boolean
}

interface EngravedHit {
  time: number
  pitch: number
  x: number
  y: number
}

// One x per onset, time-ordered. Chord noteheads share an x and the treble /
// bass doubles of one slice sit a few px apart — collapsing them keeps the
// inverse search strictly increasing so a drag can't land between two
// same-time samples and average its way to a garbage region.
// (Built by collapseToOnsets in sheetModel; see there for the invariant.)

interface EngravedScore {
  treble: VFStave
  bass: VFStave
  recs: NoteRec[]
  hits: EngravedHit[]
  samples: TimeSample[]
  // Same onsets sorted by x for the inverse lookup — timeAtX binary-searches
  // this, never the time-ordered array (x is only near-monotonic in time).
  invSamples: TimeSample[]
  beams: VFBeam[]
  byNote: Map<VFStaveNote, NoteRec>
  layoutW: number
  layoutH: number
  // Layout-time snapshot of the bar span (treble top → bass bottom at
  // layoutH, from the same sheetStaffGeometry the staves were engraved with).
  // Draw uses LIVE sheetStaffGeometry(h) barTop/barBottom so divider drags
  // track instantly until the settled re-engrave lands; the snapshot only lets
  // tests/debuggers compare engraved vs live without re-deriving geometry.
  barTop: number
  barBottom: number
}

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']

function midiKey(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12] ?? 'c'}/${Math.floor(pitch / 12) - 1}`
}

const BEAT_UNITS: BeatUnit[] = [
  { beats: 4, dur: 'w', dots: 0 },
  { beats: 3, dur: 'h', dots: 1 },
  { beats: 2, dur: 'h', dots: 0 },
  { beats: 1.5, dur: 'q', dots: 1 },
  { beats: 1, dur: 'q', dots: 0 },
  { beats: 0.75, dur: '8', dots: 1 },
  { beats: 0.5, dur: '8', dots: 0 },
  { beats: 0.375, dur: '16', dots: 1 },
  { beats: 0.25, dur: '16', dots: 0 },
  { beats: 0.125, dur: '32', dots: 0 },
]

// Greedy decomposition of a beat length into engravable units (32nd grid).
// Rests only: gaps must fill exactly, so multiple symbols are correct here.
// Pitched durations use snapBeatUnit (single symbol) — never greedy — so a
// short hit stays a quarter/eighth instead of degrading into a dotted-half
// plus fragments.
function decomposeBeats(beats: number): BeatUnit[] {
  let rest = Math.max(0.125, Math.round(beats * 8) / 8)
  const out: BeatUnit[] = []
  for (const u of BEAT_UNITS) {
    while (rest >= u.beats - 1e-9 && out.length < 8) {
      out.push(u)
      rest = Math.round((rest - u.beats) * 8) / 8
    }
  }
  if (out.length === 0) out.push(BEAT_UNITS[BEAT_UNITS.length - 1]!)
  return out
}

// Nearest single engravable value (ties: fewer dots, then shorter — same
// rule as notationEngine.quantizeDuration so the sheet agrees with the IR).
function snapBeatUnit(beats: number): BeatUnit {
  const clamped = Math.max(0.125, Math.min(4, beats))
  let best = BEAT_UNITS[BEAT_UNITS.length - 1]!
  let bestDist = Math.abs(best.beats - clamped)
  for (const u of BEAT_UNITS) {
    const d = Math.abs(u.beats - clamped)
    if (
      d < bestDist - 1e-9 ||
      (Math.abs(d - bestDist) <= 1e-9 &&
        (u.dots < best.dots || (u.dots === best.dots && u.beats < best.beats)))
    ) {
      best = u
      bestDist = d
    }
  }
  return best
}

// Pitched length capped at the next onset: a ringing MIDI duration must not
// stretch past the following chord (that overlap is what produced whole /
// dotted-half symbols for short hits and pushed `cursor` past the next
// onset, shifting every later engraved x off its real time).
function quantizeLen(rawBeats: number, availBeats: number): BeatUnit {
  const want = snapBeatUnit(Math.max(0.125, rawBeats))
  if (!Number.isFinite(availBeats) || want.beats <= availBeats + 1e-9) return want
  let best: BeatUnit | null = null
  for (const u of BEAT_UNITS) {
    if (u.beats <= availBeats + 1e-9 && (!best || u.beats > best.beats)) best = u
  }
  return best ?? BEAT_UNITS[BEAT_UNITS.length - 1]!
}

interface PitchedHit {
  time: number
  pitch: number
  dur: number
}

// Chords grouped within the sheet's onset window; durations quantized to the
// quarter derived from the nominal tempo. Gaps become greedy rest infill so
// both staff voices hold identical tick counts and format aligned.
function buildChordEvents(
  midi: MidiFile,
  visible: ReadonlySet<string> | null,
  qSec: number,
): ChordEvent[] {
  const pitched: PitchedHit[] = []
  for (const track of midi.tracks) {
    if (track.isDrum) continue
    if (visible && !visible.has(track.id)) continue
    for (const n of track.notes) {
      if (n.pitch < 21 || n.pitch > 108) continue
      pitched.push({ time: n.time, pitch: n.pitch, dur: Math.max(0, n.duration) })
    }
  }
  pitched.sort((a, b) => a.time - b.time || a.pitch - b.pitch)
  const events: ChordEvent[] = []
  let cursor = 0
  let open: { time: number; members: PitchedHit[] } | null = null
  const flush = (g: { time: number; members: PitchedHit[] }): void => {
    const treble: number[] = []
    const bass: number[] = []
    let maxDur = 0
    for (const m of g.members) {
      if (staffForNote(m.pitch) === 'treble') treble.push(m.pitch)
      else bass.push(m.pitch)
      if (m.dur > maxDur) maxDur = m.dur
    }
    const trebleU = [...new Set(treble)].sort((a, b) => a - b)
    const bassU = [...new Set(bass)].sort((a, b) => a - b)
    treble.length = 0
    treble.push(...trebleU)
    bass.length = 0
    bass.push(...bassU)
    const gap = g.time - cursor
    const dur = Math.max(0.05, maxDur)
    // ONE pitched symbol per onset, capped at the next onset is applied by
    // the caller pass below (flush lacks lookahead); here snap only so a
    // short hit never degrades into a greedy dotted-half + fragments.
    events.push({
      time: g.time,
      treble,
      bass,
      gap: gap > 0.015 ? decomposeBeats(gap / qSec) : [],
      len: [snapBeatUnit(dur / qSec)],
      dur,
    })
    let lenBeats = 0
    const last = events[events.length - 1]!
    for (const u of last.len) lenBeats += u.beats
    cursor = Math.max(cursor, g.time) + lenBeats * qSec
  }
  for (const n of pitched) {
    if (open && n.time - open.time <= SHEET_CHORD_GROUP_SEC + 1e-9) open.members.push(n)
    else {
      if (open) flush(open)
      open = { time: n.time, members: [n] }
    }
  }
  if (open) flush(open)
  // Cap each pitched length at the next onset so a ringing MIDI duration
  // can't stretch past the following chord (the overlap that produced whole
  // / dotted-half symbols for short hits and pushed `cursor` past the next
  // onset). Short staccato hits keep their snapped value; the leftover gap
  // becomes the next event's rest infill.
  for (let i = 0; i + 1 < events.length; i++) {
    const cur = events[i]!
    const nxt = events[i + 1]!
    const avail = (nxt.time - cur.time) / qSec
    if (avail <= 0) continue
    const raw = cur.dur / qSec
    const capped = quantizeLen(raw, Math.max(0.125, avail))
    cur.len = [capped]
  }
  return events
}

function makeChordNote(
  vf: VF,
  pitches: number[],
  unit: BeatUnit,
  clef: string,
  showAcc: readonly boolean[] = pitches.map(() => true),
  stemDir?: number,
): VFStaveNote {
  const note = new vf.StaveNote({
    keys: pitches.map(midiKey),
    duration: unit.dur,
    clef,
    ...(stemDir === undefined ? { autoStem: true } : { stemDirection: stemDir }),
    ...(unit.dots > 0 ? { dots: unit.dots } : {}),
  })
  pitches.forEach((p, i) => {
    // C-major spelling: a chromatic pitch shows ♯ once per bar per pitch
    // class (caller-supplied suppression); repeats hide so dots sit tight
    // and chords stop flashing a sharp on every head.
    if (isAccidental(p) && (showAcc[i] ?? true)) note.addModifier(new vf.Accidental('#'), i)
  })
  if (unit.dots > 0) vf.Dot.buildAndAttach([note], { all: true })
  return note
}

// Whole-note (and breve) bass rests sit on the F line; shorter bass rests
// stay on the D line so the glyph never collides with staff furniture.
function bassRestKey(unit: BeatUnit): string {
  return unit.dur === 'w' || unit.dur === 'b' ? 'f/3' : 'd/3'
}

function makeRestNote(vf: VF, key: string, unit: BeatUnit, clef: string): VFStaveNote {
  // Rests never take stems: explicit DOWN/UP keeps VexFlow from auto-stemming
  // a short rest into the staff furniture; duration letter drives the glyph.
  // Treble rests anchor on d/5 (second space from top — standard VexFlow rest
  // line); bass uses bassRestKey so whole rests hang from f/3 and shorter
  // values sit on d/3 clear of the lines.
  const note = new vf.StaveNote({
    keys: [key],
    duration: `${unit.dur}r`,
    clef,
    autoStem: false,
    ...(unit.dots > 0 ? { dots: unit.dots } : {}),
  })
  if (unit.dots > 0) vf.Dot.buildAndAttach([note], { all: true })
  return note
}

// Index window [lo, hi) over a time-sorted array.
function indexWindow<T extends { time: number }>(
  arr: readonly T[],
  t0: number,
  t1: number,
): [number, number] {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]!.time < t0) lo = mid + 1
    else hi = mid
  }
  const start = lo
  hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]!.time <= t1) lo = mid + 1
    else hi = mid
  }
  return [start, lo]
}

export class SheetView {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private bars: SheetBar[] = []
  private midi: MidiFile | null = null
  private visibleIds: Set<string> | null = null
  private loop: SheetLoop | null = null
  private pending: ReadonlySet<number> | null = null
  private accepted: ReadonlySet<number> | null = null
  private flashes: Flash[] = []
  private w = 0
  private h = 0
  private lastResizeAt = 0
  private raf = 0
  private unsubClock: (() => void) | null = null
  private clock: MasterClock
  private lastTime = 0
  private pxPerSec = 185
  // Fallback time→x line before engraving resolves (or when the score is
  // empty): x = xOrigin + t * pxPerSec. Re-seeded from the laid-out notehead
  // slope in layoutScore so the playhead doesn't jump when engraving lands.
  private xOrigin = 8
  private notationInk = '#f0e6d2'
  private restInk = '#9d927c'
  private ledgerInk = '#dcd2be'
  private pal: SheetPalette = {
    bg: '#0a0a12',
    staff: '#dcd2be',
    note: '#f0e6d2',
    pending: PENDING_FALLBACK,
    hit: HIT,
    miss: MISS,
    playhead: '#ffffff',
    loopEdge: PENDING_FALLBACK,
    label: '#0a0a12',
  }

  // VexFlow backend: loaded once, on first setData, via dynamic import.
  private vf: VF | null = null
  private vfPromise: Promise<void> | null = null
  private vfCtx: VFCanvasContext | null = null
  private score: EngravedScore | null = null
  private vfGen = 0

  private dragMode: 'none' | 'new' | 'start' | 'end' = 'none'
  private dragAnchor = 0
  // Pointer that owns the in-flight gesture: a second finger lifting must
  // neither commit nor cancel the first one's drag. MouseEvent-driven tests
  // carry pointerId undefined on every event, which still matches.
  private dragPointerId: number | undefined = undefined
  // Scroll captured at dragstart: the playhead keeps advancing under a live
  // drag, and re-reading lastTime per move would slide the mapping mid-gesture.
  private dragScrollX: number | null = null
  // Pre-drag loop for pointercancel rollback (an aborted gesture must not
  // commit a half-dragged region).
  private dragLoopBackup: SheetLoop | null = null
  private edgeTol = 12
  private focusedBeforeDrag: Element | null = null

  onLoopChange: ((region: SheetLoop | null) => void) | null = null
  // Brackets a drag gesture so the controller can suspend loop-wrap ticks
  // while the region is half-dragged (onTick would otherwise seek mid-drag
  // and yank the mapping under the pointer).
  onLoopEditChange: ((editing: boolean) => void) | null = null
  // Wheel / arrow-key navigation on the sheet scrubs the playhead.
  onSeekRequest: ((time: number) => void) | null = null

  private loopXBtn: HTMLButtonElement | null = null

  // `parent` only anchors the canvas at construction; `clock` is retained so
  // every draw() frame reads live `currentTime` (sub-frame accuracy) instead
  // of the 60 Hz subscribe cache — the subscription stays for seek snaps.
  constructor(parent: HTMLElement, clock: MasterClock) {
    this.clock = clock
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'sheet-canvas'
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.touchAction = 'none'
    // Focusable so arrow keys scroll the piece only when the sheet has focus.
    this.canvas.tabIndex = 0
    this.canvas.setAttribute('role', 'region')
    this.canvas.setAttribute('aria-label', 'Sheet music — arrow keys scroll, drag to loop')
    parent.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('keydown', this.onKey)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('pointercancel', this.onCancel)
    // Loop remove button lives in the band between the two edge lines.
    const xBtn = document.createElement('button')
    xBtn.type = 'button'
    xBtn.className = 'sheet-loop-x'
    xBtn.textContent = '✕'
    xBtn.setAttribute('aria-label', 'Remove loop')
    xBtn.style.display = 'none'
    xBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.loop = null
      this.onLoopChange?.(null)
    })
    parent.appendChild(xBtn)
    this.loopXBtn = xBtn
    this.unsubClock = clock.subscribe((t) => {
      this.lastTime = t
    })
    const loop = (): void => {
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  setData(midi: MidiFile | null, visibleIds: Set<string> | null): void {
    this.midi = midi
    this.visibleIds = visibleIds ? new Set(visibleIds) : null
    this.score = null
    if (!midi) {
      this.bars = []
      return
    }
    this.bars = buildBarLines(midi)
    // Seed the pre-engrave fallback line from the nominal 112px/beat grid so
    // the playhead already tracks audio-linear time before VexFlow resolves
    // (layoutScore later re-seeds from the laid-out noteheads).
    const qSec = 60 / Math.max(20, Math.min(400, midi.bpm || 120))
    this.pxPerSec = 112 / qSec
    this.xOrigin = 28
    const gen = ++this.vfGen
    void this.ensureVF().then(() => {
      if (gen !== this.vfGen || this.midi !== midi) return
      this.layoutScore()
    })
  }

  private ensureVF(): Promise<void> {
    if (this.vf) return Promise.resolve()
    if (!this.vfPromise) {
      this.vfPromise = import('vexflow').then(
        (vf) => {
          this.vf = vf
          this.vfCtx = new vf.CanvasContext(this.ctx)
          this.applyNotationStyle()
        },
        () => {
          this.vfPromise = null
        },
      )
    }
    return this.vfPromise
  }

  // Engrave the whole piece onto one long single-system grand staff
  // (treble + bass clefs, no key / time signatures — Simply-style anchor at
  // the left edge). Synchronous; runs once the backend resolves and whenever
  // the height changes staff geometry.
  private layoutScore(): void {
    const vf = this.vf
    const vfCtx = this.vfCtx
    const midi = this.midi
    if (!vf || !vfCtx || !midi || this.h <= 0) return
    const h = this.h
    // Even scale: ls tracks pane height so lines stay proportional, never
    // stretched — VexFlow scales heads/stems/dots/clefs with ls, and the
    // beat grid below scales with ls too so horizontal density matches.
    // Single source via sheetStaffGeometry (same fn draw() uses): centered
    // 12ls block inside the padded pane so the bottom staff never clips.
    const { startX, formatPad } = sheetLayoutMetrics(h)
    const { ls, trebleTop, bassTop, staffBottom } = sheetStaffGeometry(h)
    const qSec = 60 / Math.max(20, Math.min(400, midi.bpm || 120))
    const chords = buildChordEvents(midi, this.visibleIds, qSec)
    if (chords.length === 0) {
      this.score = null
      return
    }
    let totalBeats = 0
    for (const c of chords) {
      for (const u of c.gap) totalBeats += u.beats
      for (const u of c.len) totalBeats += u.beats
    }
    // Beat grid scales with ls (6.6ls ≈ 112px at ls 17) so horizontal
    // density matches vertical size; startX + trailing pads scale with ls
    // too so clef room and right padding stay proportional (no fixed-px
    // pinch that reads as uneven scaling when the pane grows).
    const scoreWidth = sheetScoreWidth(h, totalBeats)
    const trebleStave = new vf.Stave(startX, trebleTop, scoreWidth, {
      spacingBetweenLinesPx: ls,
    })
    const bassStave = new vf.Stave(startX, bassTop, scoreWidth, {
      spacingBetweenLinesPx: ls,
    })
    trebleStave.addClef('treble')
    bassStave.addClef('bass')
    for (const st of [trebleStave, bassStave]) {
      st.setBegBarType(vf.BarlineType.NONE)
      st.setEndBarType(vf.BarlineType.NONE)
      st.setContext(vfCtx)
    }

    const trebleNotes: VFStaveNote[] = []
    const bassNotes: VFStaveNote[] = []
    const recs: NoteRec[] = []
    // Per-bar accidental suppression (same rule as sheetModel): the first
    // sharp of a pitch class in a bar shows ♯, repeats hide. Tracked per
    // staff so a treble sharp never hides a needed bass one. Sharps are the
    // left modifiers that were pushing dots far from their heads — hiding
    // repeats pulls dots back tight.
    const barTimes = this.bars.map((b) => b.time)
    let barIdx = -1
    let trebleSeen = new Set<number>()
    let bassSeen = new Set<number>()
    const UP = vf.Stem.UP ?? 1
    const DOWN = vf.Stem.DOWN ?? -1
    let cursor = 0
    for (const c of chords) {
      while (barIdx + 1 < barTimes.length && barTimes[barIdx + 1]! <= c.time + 1e-9) {
        barIdx++
        trebleSeen = new Set()
        bassSeen = new Set()
      }
      const trebleAcc = c.treble.map((p) => {
        if (!isAccidental(p)) return false
        const pc = p % 12
        if (trebleSeen.has(pc)) return false
        trebleSeen.add(pc)
        return true
      })
      const bassAcc = c.bass.map((p) => {
        if (!isAccidental(p)) return false
        const pc = p % 12
        if (bassSeen.has(pc)) return false
        bassSeen.add(pc)
        return true
      })
      for (const u of c.gap) {
        const end = cursor + u.beats * qSec
        const tr = makeRestNote(vf, 'd/5', u, 'treble')
        const br = makeRestNote(vf, bassRestKey(u), u, 'bass')
        trebleNotes.push(tr)
        bassNotes.push(br)
        recs.push({ note: tr, time: cursor, end, pitches: [] })
        recs.push({ note: br, time: cursor, end, pitches: [] })
        cursor = end
      }
      // Engraved x advances on the quantized cursor, but the TIME labels stay
      // on the real MIDI clock (c.time / c.dur): samples and bar lines then
      // share one timeline and Formatter justification can't drift them apart.
      // Multi-unit lens are tied continuations — only the first unit is an
      // onset for hits/samples.
      let sliceStart = Math.max(cursor, c.time)
      c.len.forEach((u, ui) => {
        const sliceEnd = sliceStart + u.beats * qSec
        const isOnset = ui === 0
        // One stem direction per staff (treble up / bass down): every chord
        // in a staff agrees, so beams never flip mid-phrase. Only the onset
        // unit carries accidentals; tied continuations suppress.
        const tr =
          c.treble.length > 0
            ? makeChordNote(vf, c.treble, u, 'treble', isOnset ? trebleAcc : c.treble.map(() => false), UP)
            : makeRestNote(vf, 'd/5', u, 'treble')
        const br =
          c.bass.length > 0
            ? makeChordNote(vf, c.bass, u, 'bass', isOnset ? bassAcc : c.bass.map(() => false), DOWN)
            : makeRestNote(vf, bassRestKey(u), u, 'bass')
        trebleNotes.push(tr)
        bassNotes.push(br)
        const end = c.time + c.dur
        recs.push({ note: tr, time: c.time, end, pitches: [...c.treble], onset: isOnset })
        recs.push({ note: br, time: c.time, end, pitches: [...c.bass], onset: isOnset })
        sliceStart = sliceEnd
      })
      cursor = sliceStart
    }

    const totalQuarters = Math.max(1, Math.ceil(totalBeats) + 1)
    const trebleVoice: VFVoice = new vf.Voice({ numBeats: totalQuarters, beatValue: 4 })
    trebleVoice.setStrict(false)
    trebleVoice.addTickables(trebleNotes)
    const bassVoice: VFVoice = new vf.Voice({ numBeats: totalQuarters, beatValue: 4 })
    bassVoice.setStrict(false)
    bassVoice.addTickables(bassNotes)
    trebleVoice.setStave(trebleStave)
    bassVoice.setStave(bassStave)
    for (const n of trebleNotes) {
      n.setStave(trebleStave)
      n.setContext(vfCtx)
    }
    for (const n of bassNotes) {
      n.setStave(bassStave)
      n.setContext(vfCtx)
    }

    const beams = [...vf.Beam.generateBeams(trebleNotes), ...vf.Beam.generateBeams(bassNotes)]
    for (const b of beams) b.setContext(vfCtx)

    new vf.Formatter()
      .joinVoices([trebleVoice])
      .joinVoices([bassVoice])
      .format([trebleVoice, bassVoice], scoreWidth - startX - formatPad)

    // Laid-out notehead centers on the REAL clock: one hit per onset pitch
    // (tied continuations excluded) so the time→x samples share the bar
    // lines' meter-map timeline. X still comes from the justified engraving.
    const hits: EngravedHit[] = []
    for (const r of recs) {
      if (r.pitches.length === 0 || r.onset === false) continue
      const ys = r.note.getYs()
      const cx = (r.note.getNoteHeadBeginX() + r.note.getNoteHeadEndX()) / 2
      r.pitches.forEach((p, i) => {
        hits.push({ time: r.time, pitch: p, x: cx, y: ys[i] ?? 0 })
      })
    }
    hits.sort((a, b) => a.time - b.time || a.pitch - b.pitch)
    recs.sort((a, b) => a.time - b.time)

    // One x per onset (see sheetModel.collapseToOnsets); the inverse map
    // gets its own x-sorted copy (see buildInverseSamples).
    const samples = collapseToOnsets(hits.map((hit) => ({ t: hit.time, x: hit.x })))
    const invSamples = buildInverseSamples(samples)
    const first = samples[0]!
    const last = samples[samples.length - 1]!
    if (last.t > first.t + 1e-6) {
      const slope = (last.x - first.x) / (last.t - first.t)
      if (Number.isFinite(slope) && slope > 0) {
        this.pxPerSec = Math.max(40, Math.min(800, slope))
        this.xOrigin = first.x - first.t * this.pxPerSec
      }
    }

    this.score = {
      treble: trebleStave,
      bass: bassStave,
      recs,
      hits,
      samples,
      invSamples,
      beams,
      byNote: new Map(recs.map((r) => [r.note, r])),
      layoutW: this.w,
      layoutH: h,
      barTop: trebleTop,
      barBottom: staffBottom,
    }
    this.applyNotationStyle()
  }

  // Clamp an extrapolation slope to a band around the engraved mean density:
  // Formatter justifies the whole system to one width, so a local two-sample
  // slope can be near-zero or near-infinite and fling scroll / loop mapping
  // on seeks past either end. Interior interpolation stays exact so hit
  // overlays sit on their engraved heads.
  private clampSlope(slope: number): number {
    const n = this.pxPerSec
    if (!Number.isFinite(slope) || slope <= 0) return n
    return Math.min(n * 8, Math.max(n / 8, slope))
  }

  // Score-space X for a time: linear interpolation between laid-out notehead
  // centers (extrapolated past the ends). Falls back to the seeded px/sec
  // line until the backend finishes engraving.
  xAtTime(t: number): number {
    const s = this.score
    if (!s || s.samples.length === 0) return this.xOrigin + t * this.pxPerSec
    const sm = s.samples
    const first = sm[0]!
    const last = sm[sm.length - 1]!
    if (t <= first.t) {
      const b = sm[1]
      const dxdt = b && b.t > first.t ? (b.x - first.x) / (b.t - first.t) : this.pxPerSec
      const slope = this.clampSlope(dxdt)
      return first.x - (first.t - t) * slope
    }
    if (t >= last.t) {
      const a = sm[sm.length - 2]
      const dxdt = a && last.t > a.t ? (last.x - a.x) / (last.t - a.t) : this.pxPerSec
      const slope = this.clampSlope(dxdt)
      return last.x + (t - last.t) * slope
    }
    let lo = 0
    let hi = sm.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (sm[mid]!.t <= t) lo = mid
      else hi = mid
    }
    const A = sm[lo]!
    const B = sm[hi]!
    const span = B.t - A.t
    // Distinct onsets by construction — a zero span only survives float
    // noise, so hold the left edge instead of averaging two different xs.
    if (span <= 1e-9) return A.x
    return A.x + ((t - A.t) / span) * (B.x - A.x)
  }

  // Bar-line x on the SAME engraved timeline as the noteheads: interpolate
  // the bar's meter-map second through the real-time onset samples, then
  // lock to the downbeat head when one is adjacent (time and/or px snap in
  // sheetModel.barXForTime). Falls back to xAtTime with no engraving.
  barX(t: number): number {
    const s = this.score
    if (!s || s.samples.length === 0) return this.xAtTime(t)
    const snapped = barXForTime(t, s.samples)
    if (snapped !== null) return snapped
    return this.xAtTime(t)
  }

  private timeAtX(x: number): number {
    const s = this.score
    if (!s || s.invSamples.length === 0) return (x - this.xOrigin) / this.pxPerSec
    const sm = s.invSamples
    const first = sm[0]!
    const last = sm[sm.length - 1]!
    if (x <= first.x) {
      const b = sm[1]
      const dxdt = b && b.t > first.t ? (b.x - first.x) / (b.t - first.t) : this.pxPerSec
      return first.t - (first.x - x) / this.clampSlope(dxdt)
    }
    if (x >= last.x) {
      const a = sm[sm.length - 2]
      const dxdt = a && last.t > a.t ? (last.x - a.x) / (last.t - a.t) : this.pxPerSec
      return last.t + (x - last.x) / this.clampSlope(dxdt)
    }
    let lo = 0
    let hi = sm.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (sm[mid]!.x <= x) lo = mid
      else hi = mid
    }
    const A = sm[lo]!
    const B = sm[hi]!
    const span = B.x - A.x
    // Residual duplicates are dropped at layout; a zero span only survives
    // float noise, so hold the left edge instead of averaging two times
    // (that average is what used to yank a drag mid-gesture).
    if (span <= 1e-9) return A.t
    return A.t + ((x - A.x) / span) * (B.t - A.t)
  }

  setLoop(loop: SheetLoop | null): void {
    this.loop = loop ? { ...loop } : null
  }

  // Follows the app theme (stage background, accents, light/dark). Called
  // from App.applyTheme alongside the renderer theme swap. Notation ink goes
  // through VexFlow setStyle: cream on dark stages, dark slate on light.
  setTheme(theme: Theme): void {
    const vs = vexSheetStyle(theme)
    this.pal = {
      bg: hexToCSS(theme.background),
      staff: vs.staffLine,
      note: vs.noteFill,
      pending: vs.pendingFill,
      hit: HIT,
      miss: MISS,
      playhead: hexToCSS(theme.nowLine),
      loopEdge: vs.pendingFill,
      label: hexToCSS(theme.background),
    }
    this.notationInk = vs.noteFill
    this.restInk = vs.restFill
    this.ledgerInk = vs.ledgerLine
    this.applyNotationStyle()
  }

  private applyNotationStyle(): void {
    const vfCtx = this.vfCtx
    const score = this.score
    if (!vfCtx || !score) return
    vfCtx.setDefaultStyle({
      fillStyle: this.notationInk,
      strokeStyle: this.notationInk,
    })
    // Widths scale with staff-space ls (recomputed from layoutH so a
    // setTheme-driven restyle agrees with the engraving even without a
    // re-layout): thicker stems/heads at big panes, hairlines never below
    // 1.2px at small panes. Staff/ledger hold 1.5px like MuseScore; beams
    // track ls so they read at a glance like Simply/MuseScore.
    // applyStyle() pushes these before Stave.draw() strokes the five lines,
    // so leaked playhead/loop widths can never thicken them further.
    const ls = lsFromHeight(score.layoutH)
    const w = notationWidths(ls)
    const ink = { fillStyle: this.notationInk, strokeStyle: this.notationInk, lineWidth: w.stem }
    const rest = { fillStyle: this.restInk, strokeStyle: this.restInk, lineWidth: w.stem }
    const staff = { fillStyle: this.pal.staff, strokeStyle: this.pal.staff, lineWidth: w.staff }
    const ledger = { fillStyle: this.ledgerInk, strokeStyle: this.ledgerInk, lineWidth: w.ledger }
    const beam = { fillStyle: this.notationInk, strokeStyle: this.notationInk, lineWidth: w.beam }
    score.treble.setStyle(staff)
    score.bass.setStyle(staff)
    // Thin ledgers in staff ink (MuseScore convention); per-note + stave
    // default both, so neither the stave fallback nor a raw-ctx leak repaints
    // them in an accent color.
    score.treble.setDefaultLedgerLineStyle({ ...ledger })
    score.bass.setDefaultLedgerLineStyle({ ...ledger })
    for (const r of score.recs) {
      // Rests read muted; pitched heads keep full ink. Stems get their own
      // style call — VexFlow draws them outside the notehead fill path, so
      // setStyle alone leaves them hairline.
      const pitched = r.pitches.length > 0
      r.note.setStyle(pitched ? ink : rest)
      try {
        r.note.setStemStyle(pitched ? ink : rest)
      } catch {
        /* older VexFlow without setStemStyle */
      }
      r.note.setLedgerLineStyle({ ...ledger })
    }
    for (const b of score.beams) b.setStyle({ ...beam })
  }

  setPending(pending: ReadonlySet<number> | null, accepted: ReadonlySet<number> | null): void {
    this.pending = pending
    this.accepted = accepted
  }

  flashError(pitch: number, time: number): void {
    this.flashes.push({ pitch, time, until: performance.now() + 700 })
    if (this.flashes.length > 32) this.flashes.shift()
  }

  resize(cssW: number, cssH: number): void {
    // Clamp first so a transient 0/negative divider size never poisons w/h
    // or the backing store mid-drag; CSS px are set explicitly so the
    // backing store never stretches against a stale 100% flex size.
    const w = Math.max(1, Math.round(cssW))
    const h = Math.max(1, Math.round(cssH))
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (
      w === this.w &&
      h === this.h &&
      this.canvas.width === Math.round(w * dpr) &&
      this.canvas.height === Math.round(h * dpr)
    )
      return
    this.w = w
    this.h = h
    this.lastResizeAt = performance.now()
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.unsubClock?.()
    this.vfGen++
    this.score = null
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('keydown', this.onKey)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onCancel)
    this.loopXBtn?.remove()
    this.loopXBtn = null
    this.canvas.remove()
  }

  // ── Pointer → loop editing ────────────────────────────────────────────
  private scrollX(): number {
    return this.xAtTime(this.lastTime) - this.w * 0.22
  }
  private xToTime(x: number): number {
    // Mid-gesture the playhead keeps advancing; map against the scroll
    // captured at dragstart so the region doesn't slide under the pointer.
    return this.timeAtX(x + (this.dragScrollX ?? this.scrollX()))
  }
  private timeToX(t: number): number {
    return this.xAtTime(t) - this.scrollX()
  }

  private startDrag(mode: 'new' | 'start' | 'end', e: PointerEvent): void {
    this.dragMode = mode
    this.dragPointerId = e.pointerId
    this.canvas.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    this.onLoopEditChange?.(true)
  }

  // A drag that ends with the canvas focused steals the arrow keys (they
  // scroll the sheet instead of driving transport). The pointerdown default
  // already prevents focus on mouse, but touch/keyboard focus can still land
  // here — hand focus back unless the canvas had it before the gesture.
  private restoreFocus(): void {
    if (document.activeElement === this.canvas && this.focusedBeforeDrag !== this.canvas) {
      this.canvas.blur()
    }
    this.focusedBeforeDrag = null
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.midi || this.dragMode !== 'none') return
    const rect = this.canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    this.dragLoopBackup = this.loop ? { ...this.loop } : null
    this.dragScrollX = this.scrollX()
    this.focusedBeforeDrag = document.activeElement
    // Touch needs a fatter edge target; rect math is CSS px either way, so
    // no dpr scaling is required here.
    this.edgeTol = e.pointerType === 'touch' ? 20 : 12
    if (this.loop) {
      const xs = this.timeToX(this.loop.start)
      const xe = this.timeToX(this.loop.end)
      if (Math.abs(x - xs) < this.edgeTol) {
        this.startDrag('start', e)
        return
      }
      if (Math.abs(x - xe) < this.edgeTol) {
        this.startDrag('end', e)
        return
      }
    }
    this.dragAnchor = this.xToTime(x)
    this.startDrag('new', e)
  }

  private onMove = (e: PointerEvent): void => {
    if (this.dragMode === 'none' || !this.midi) return
    if (e.pointerId !== this.dragPointerId) return
    const rect = this.canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const t = this.xToTime(x)
    const dur = this.midi.duration
    if (this.dragMode === 'new') {
      const s = Math.max(0, Math.min(this.dragAnchor, t))
      const en = Math.max(0, Math.min(dur, Math.max(this.dragAnchor, t)))
      // Keep the last valid band until the drag exceeds the floor: nulling
      // mid-drag flickers the band out, and a missed pointerup would lose the
      // pre-drag region with it. Only pointerup commits (or falls back).
      if (en - s >= WAIT_LOOP_MIN_SEC) this.loop = { start: s, end: en }
    } else if (this.loop) {
      const c = Math.max(0, Math.min(dur, t))
      if (this.dragMode === 'start')
        this.loop = {
          start: Math.min(c, this.loop.end - WAIT_LOOP_MIN_SEC),
          end: this.loop.end,
        }
      else
        this.loop = {
          start: this.loop.start,
          end: Math.max(c, this.loop.start + WAIT_LOOP_MIN_SEC),
        }
    }
  }

  private onUp = (e: PointerEvent): void => {
    if (this.dragMode === 'none') return
    if (e.pointerId !== this.dragPointerId) return
    const mode = this.dragMode
    this.dragMode = 'none'
    this.dragPointerId = undefined
    this.dragScrollX = null
    this.dragLoopBackup = null
    if (mode === 'new') {
      // A plain click (no drag) still makes a loop: a small area appears at
      // the click that the user then drags to their preferred size.
      if (!this.loop || this.loop.end - this.loop.start < WAIT_LOOP_MIN_SEC) {
        const dur = this.midi?.duration ?? 0
        if (dur <= 0) {
          this.loop = null
        } else {
          const c = Math.max(0, Math.min(dur, this.dragAnchor))
          let s = Math.max(0, c - 1)
          let e = Math.min(dur, c + 1)
          if (e - s < 2 * WAIT_LOOP_MIN_SEC) {
            s = Math.max(0, Math.min(s, dur - 2 * WAIT_LOOP_MIN_SEC))
            e = Math.min(dur, s + 2 * WAIT_LOOP_MIN_SEC)
          }
          this.loop = e - s >= WAIT_LOOP_MIN_SEC ? { start: s, end: e } : null
        }
      }
    }
    // Commit before unbracketing: endLoopEdit re-parks the playhead against
    // the controller's region, which must already be the new one — otherwise
    // it seeks to the stale loop (or no-ops on the pre-commit null).
    // The loop is always null or >= WAIT_LOOP_MIN_SEC here, so the
    // controller accepts whatever we send — no silent reject + snap-back.
    this.onLoopChange?.(this.loop ? { ...this.loop } : null)
    this.onLoopEditChange?.(false)
    this.restoreFocus()
  }

  private onCancel = (e: PointerEvent): void => {
    if (this.dragMode === 'none') return
    if (e.pointerId !== this.dragPointerId) return
    this.dragMode = 'none'
    this.dragPointerId = undefined
    this.dragScrollX = null
    // Aborted gesture: roll back to the pre-drag region and stay silent.
    this.loop = this.dragLoopBackup
    this.dragLoopBackup = null
    this.onLoopEditChange?.(false)
    this.restoreFocus()
  }

  // Wheel scrolls through the piece (vertical + horizontal deltas both scrub
  // time — the sheet is a horizontal timeline).
  private onWheel = (e: WheelEvent): void => {
    if (!this.midi || !this.onSeekRequest) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : 1
    const seconds = ((e.deltaY + e.deltaX) * unit) / this.pxPerSec
    if (seconds === 0) return
    const dur = this.midi.duration
    this.onSeekRequest(Math.max(0, Math.min(dur, this.lastTime + seconds)))
  }

  // Arrow keys scroll only when the sheet itself is focused, so global
  // transport shortcuts keep working everywhere else.
  private onKey = (e: KeyboardEvent): void => {
    if (!this.midi || !this.onSeekRequest) return
    const dur = this.midi.duration
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      const d = e.code === 'ArrowLeft' ? -5 : 5
      this.onSeekRequest(Math.max(0, Math.min(dur, this.lastTime + d)))
    } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      const t = this.lastTime
      if (e.code === 'ArrowUp') {
        let prev = 0
        for (const b of this.bars) {
          if (b.time < t - 0.05) prev = b.time
          else break
        }
        this.onSeekRequest(prev)
      } else {
        let next = dur
        for (const b of this.bars) {
          if (b.time > t + 0.05) {
            next = b.time
            break
          }
        }
        this.onSeekRequest(next)
      }
    }
  }

  // Focus fade: matches the old canvas renderer — sinking played notes,
  // full-strength window, far-future dim; pending / hit / miss punch through.
  private fadeAlpha(time: number, pitches: readonly number[]): number {
    const dt = this.lastTime - time
    let hot = false
    for (const p of pitches) {
      if (this.flashes.some((f) => f.pitch === p && Math.abs(time - f.time) < 0.12)) {
        hot = true
        break
      }
      if (this.pending?.has(p) && Math.abs(time - this.lastTime) < 1.2) hot = true
    }
    // Simply-style focus: played notes sink to 0.3, a ~2s lookahead window
    // pops at full strength, then the future falls off in steps so the
    // next phrase reads ahead without competing with the playhead.
    let alpha: number
    if (dt < -6) alpha = 0.28
    else if (dt < -2) alpha = 0.55
    else if (dt < -0.08) alpha = 1
    else if (dt < 0.17) alpha = 1 - ((dt + 0.08) / 0.25) * 0.7
    else alpha = 0.3
    if (hot) alpha = 1
    return alpha
  }

  // Scrub raw canvas state before a VexFlow drawWithStyle call. The loop
  // band (accent fill), playhead (wide tinted stroke) and letter-name fills
  // run on this same context every frame, and any VexFlow sub-element
  // without an explicit style inherits whatever is current — that leak is
  // the blue-staff bug. Ink here is always staff/note/rest ink, never the
  // accent / playhead / loop colors. Width matches the engraved element
  // (staff/stem/beam from notationWidths) so a leaked wide playhead stroke
  // can never thicken staff lines at small panes, nor a hairline thin them
  // at big panes.
  private resetCtx(ink: string, alpha: number, lineWidth: number): void {
    const c = this.ctx
    c.globalAlpha = alpha
    c.lineWidth = lineWidth
    c.strokeStyle = ink
    c.fillStyle = ink
  }

  // ── Drawing ───────────────────────────────────────────────────────────
  private draw(): void {
    const { ctx, w } = this
    const h = this.h
    if (w <= 0 || h <= 0) return
    // Live time, not the subscribe cache: MasterClock ticks on its own rAF,
    // so the cached lastTime lags this view's frame by up to a frame and the
    // playhead jitters against audio. The subscription stays for seek snaps.
    // (Guarded: a clock that hasn't produced a finite time yet — or a test
    // stub without one — must not poison the frame cache to NaN.)
    const live = this.clock.currentTime
    if (Number.isFinite(live)) this.lastTime = live
    const now = performance.now()
    this.flashes = this.flashes.filter((f) => f.until > now)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = this.pal.bg
    ctx.fillRect(0, 0, w, h)

    // Live grand-staff block shares sheetStaffGeometry with layoutScore so
    // barlines/playhead track divider drags instantly without clipping.
    const { ls, trebleTop, staffBottom, barTop, barBottom } = sheetStaffGeometry(h)
    const widths = notationWidths(ls)
    const playX = w * 0.22

    // Loop band behind everything, with an ✕ in the band to remove it.
    // Soft wash + glowing 3px rounded-cap edges so the accent frames the
    // region without dominating the ink.
    if (this.loop) {
      const xs = this.timeToX(this.loop.start)
      const xe = this.timeToX(this.loop.end)
      ctx.save()
      ctx.fillStyle = this.pal.loopEdge
      ctx.globalAlpha = 0.08
      ctx.fillRect(Math.max(0, xs), 0, Math.max(0, xe - xs), h)
      ctx.globalAlpha = 1
      ctx.strokeStyle = this.pal.loopEdge
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.shadowColor = this.pal.loopEdge
      ctx.shadowBlur = 10
      // Inset so the round caps clear the pane edges.
      line(ctx, xs, 4, xs, h - 4)
      line(ctx, xe, 4, xe, h - 4)
      ctx.restore()
    }
    // Keep the DOM remove-button centered in the visible part of the band.
    // Shown for any on-screen loop — a minimum-size (0.25s) band is only
    // ~48px wide at typical zoom, which the old 48px cutoff hid, leaving no
    // way to clear a freshly created loop.
    if (this.loopXBtn) {
      if (this.loop) {
        const xs = Math.max(0, this.timeToX(this.loop.start))
        const xe = Math.min(w, this.timeToX(this.loop.end))
        if (xe > 0 && xs < w && xe - xs > 4) {
          this.loopXBtn.style.display = ''
          const cx = Math.max(16, Math.min(w - 16, (xs + xe) / 2))
          this.loopXBtn.style.left = `${cx}px`
          this.loopXBtn.style.top = '8px'
        } else {
          this.loopXBtn.style.display = 'none'
        }
      } else {
        this.loopXBtn.style.display = 'none'
      }
    }

    // Engrave on demand: the backend may resolve after setData, and staff
    // geometry follows the canvas size. A width change re-layouts at once;
    // height-only drift (divider drag) waits until the resize settles so we
    // don't re-engrave every frame mid-playback (tolerance alone still
    // re-engraves continuously through a long drag). Never mid-drag: a
    // mid-gesture engraving would swap the samples under the frozen
    // dragScrollX mapping and yank the region (width swaps too, so it waits
    // for pointerup like height does).
    const dragging = this.dragMode !== 'none'
    if (this.vf && this.vfCtx && this.midi) {
      if (!this.score) {
        if (!dragging) this.layoutScore()
      } else if (this.score.layoutW !== this.w) {
        if (!dragging) this.layoutScore()
      } else if (shouldRelayoutScore(this.score.layoutH, h, now, this.lastResizeAt, dragging))
        this.layoutScore()
    }
    const score = this.score

    if (score) {
      // Scroll: translate the long system so the playhead stays fixed.
      const scroll = this.xAtTime(this.lastTime) - playX
      ctx.save()
      ctx.translate(-scroll, 0)
      // Staves span the system; the canvas clips them to the viewport.
      // VexFlow end caps stay NONE — bar lines are our manual meter-map
      // strokes below, so there is exactly one barline source.
      // resetCtx first: staff ink only, never accent / playhead / loop.
      // Width is the staff width so a leaked playhead/loop stroke can't
      // thicken the five lines (same 1.5px the engraving used).
      this.resetCtx(this.pal.staff, 1, widths.staff)
      score.treble.drawWithStyle()
      this.resetCtx(this.pal.staff, 1, widths.staff)
      score.bass.drawWithStyle()
      // Only the visible measure window is drawn.
      const t0 = this.timeAtX(scroll - 80)
      const t1 = this.timeAtX(scroll + w + 80)
      const [rlo, rhi] = indexWindow(score.recs, t0, t1)
      const visible = new Set<VFStaveNote>()
      for (let i = rlo; i < rhi; i++) {
        const rec = score.recs[i]!
        if (rec.end < t0) continue
        visible.add(rec.note)
        ctx.save()
        // Notehead scrub uses the stem width (same px the engraved stem/
        // head outline used), rest ink for rests so pitched heads lead.
        this.resetCtx(
          rec.pitches.length > 0 ? this.notationInk : this.restInk,
          this.fadeAlpha(rec.time, rec.pitches),
          widths.stem,
        )
        rec.note.drawWithStyle()
        ctx.restore()
      }
      ctx.globalAlpha = 1
      for (const b of score.beams) {
        // Beams sink and lift with their own noteheads (Simply-style focus):
        // strongest member alpha wins.
        let alpha = 0
        for (const n of b.getNotes()) {
          const rec = score.byNote.get(n as VFStaveNote)
          if (rec && visible.has(rec.note)) {
            const a = this.fadeAlpha(rec.time, rec.pitches)
            if (a > alpha) alpha = a
          }
        }
        if (alpha <= 0.02) continue
        ctx.save()
        this.resetCtx(this.notationInk, alpha, widths.beam)
        b.drawWithStyle()
        ctx.restore()
      }
      ctx.restore()

      // Bar lines from the meter map, in screen coords — x comes from the
      // SAME engraved timeline as the noteheads (barX interpolates the bar's
      // real second between the real-time onset samples + snaps to the
      // downbeat head), y spans the LIVE grand staff top→bottom so divider
      // drags track instantly (layout snapshot would lag until re-engrave).
      // Same staff ink, staff width like the staff lines (notationWidths).
      // Round caps so a 1.5px bar never reads short against the outer lines.
      ctx.strokeStyle = this.pal.staff
      ctx.globalAlpha = 0.75
      ctx.lineWidth = widths.staff
      ctx.lineCap = 'round'
      for (const b of this.bars) {
        const x = this.barX(b.time) - scroll
        if (x < -20 || x > w + 20) continue
        line(ctx, x, barTop, x, barBottom)
      }
      ctx.globalAlpha = 1

      // Pending / hit / miss overlays + letter names on near heads.
      // Larger halo (0.64ls) matches the bigger heads; bolder label type.
      const r = ls * 0.64
      ctx.textBaseline = 'middle'
      const [hlo, hhi] = indexWindow(score.hits, t0, t1)
      for (let i = hlo; i < hhi; i++) {
        const hit = score.hits[i]!
        const x = hit.x - scroll
        const dt = this.lastTime - hit.time
        const isPending = this.pending?.has(hit.pitch) && Math.abs(hit.time - this.lastTime) < 1.2
        const isAccepted = this.accepted?.has(hit.pitch) && isPending
        const isFlash = this.flashes.some(
          (f) => f.pitch === hit.pitch && Math.abs(hit.time - f.time) < 0.12,
        )
        let color: string | null = null
        if (isFlash) color = this.pal.miss
        else if (isPending) color = isAccepted ? this.pal.hit : this.pal.pending
        if (color) {
          ctx.globalAlpha = 1
          if (isPending) {
            ctx.fillStyle = color
            ctx.globalAlpha = 0.25
            ctx.beginPath()
            ctx.arc(x, hit.y, r * 1.8, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 1
          }
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.ellipse(x, hit.y, r, r * 0.78, -0.25, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = this.pal.label
          ctx.font = `800 ${Math.round(r * 1.15)}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillText(BASE_LETTER[hit.pitch % 12]!, x, hit.y + 0.5)
          ctx.textAlign = 'start'
        } else if (r >= 6 && hit.time - this.lastTime > -0.6 && hit.time - this.lastTime < 2) {
          // Letter name inside near heads — Simply's beginner cue for reading.
          // Tight ±(0.6s back / 2s ahead) window so only the playhead phrase
          // carries labels instead of cluttering the whole viewport.
          void dt
          ctx.fillStyle = this.pal.label
          ctx.globalAlpha = this.fadeAlpha(hit.time, [hit.pitch])
          ctx.font = `800 ${Math.round(r * 1.15)}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillText(BASE_LETTER[hit.pitch % 12]!, x, hit.y + 0.5)
          ctx.textAlign = 'start'
          ctx.globalAlpha = 1
        }
      }
    }

    // Playhead — a soft luminescent line: wide halo pass, then the core.
    // Same full-staff span as the barlines plus a small symmetric overshoot,
    // clamped into the canvas so a short pane clips nothing and the halo
    // never bleeds off an edge. Round caps + glow shadow keep the thin core
    // readable at a glance.
    const playTop = Math.max(2, trebleTop - 0.5 * ls)
    const playBottom = Math.min(h - 2, staffBottom + 0.5 * ls)
    ctx.save()
    ctx.strokeStyle = this.pal.playhead
    ctx.lineCap = 'round'
    ctx.shadowColor = this.pal.playhead
    ctx.shadowBlur = 12
    ctx.globalAlpha = 0.28
    ctx.lineWidth = 8
    line(ctx, playX, playTop, playX, playBottom)
    ctx.globalAlpha = 1
    ctx.lineWidth = 3
    line(ctx, playX, playTop, playX, playBottom)
    ctx.restore()
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}
