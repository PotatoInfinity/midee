// MIDI → notation IR for the future VexFlow renderer.
//
// Pure: seconds in, engrave-ready symbols out. This module decides *what*
// (chords, quantized durations, rests) and *where* (measures, voices); the
// renderer will decide how to draw it.
//
// Pipeline per voice (treble/bass via `staffForNote`):
//   1. Collect notes — skips drums + pitches outside 21..108, like sheetModel.
//   2. Fuse onsets within 0.04s into chords (mirrors SHEET_CHORD_GROUP_SEC).
//   3. Map seconds → quarter-note beats by integrating the tempo map, then
//      snap onsets/durations to a 32nd-note grid.
//   4. Split into measures at the time-signature boundaries. A meter change
//      resets bar counting — bars never straddle it (same rule as tempoMap).
//   5. Greedy rest-gap infill so every voice in every measure sums to exactly
//      the bar length (VexFlow strict mode requires complete bars).
//
// Spelling is C major (sharps): `pitches` stay MIDI numbers and the renderer
// spells them sharp via `pitchToNoteName`.
//
// Durations with dots: a chord keeps ONE symbol (no ties in IR v1), snapped
// to the nearest dotted value (up to double dots); a chord ringing past the
// bar line clamps at the bar. Rests instead split greedily (largest dotted
// values first) so gaps always fill exactly.

import type { MeterEntry, MidiFile, TempoEntry } from '../core/midi/types'
import { staffForNote } from '../learn/exercises/sight-reading/music'

export type NotationSymbol =
  | { kind: 'note'; pitches: number[]; beats: number; dots: number; time: number }
  | { kind: 'rest'; beats: number; dots: number }

export interface NotationMeasure {
  /** 1-based. Counting continues across meter changes. */
  number: number
  /** Measure start, seconds (for seek / cursor mapping). */
  time: number
  numerator: number
  denominator: number
  /** Actual bar length in quarter-note beats (truncated when a meter change or the piece end cuts the bar short). */
  beats: number
  treble: NotationSymbol[]
  bass: NotationSymbol[]
}

// Onset window fused into one chord — mirrors SHEET_CHORD_GROUP_SEC so
// notation chords and sheet steps agree.
export const NOTATION_CHORD_GROUP_SEC = 0.04

/** 32nd-note grid step, quarter-note beats. */
const GRID_BEATS = 0.125
const MIN_PITCH = 21
const MAX_PITCH = 108
const MAX_MEASURES = 10_000
const EPS = 1e-9

interface DurationClass {
  /** Length in 32nd-note grid units. */
  units: number
  /** Length in quarter-note beats (exact binary fraction). */
  beats: number
  dots: number
}

// Every (beats, dots) pair with dots ≤ 2 on the 32nd grid, ascending.
// Dots = 1 needs an even-unit base, dots = 2 a base divisible by 4 — hence
// the gaps (5, 9–11, …): those snap to the nearest entry.
const SINGLE_DURATIONS: DurationClass[] = [
  { units: 1, beats: 0.125, dots: 0 },
  { units: 2, beats: 0.25, dots: 0 },
  { units: 3, beats: 0.375, dots: 1 },
  { units: 4, beats: 0.5, dots: 0 },
  { units: 6, beats: 0.75, dots: 1 },
  { units: 7, beats: 0.875, dots: 2 },
  { units: 8, beats: 1, dots: 0 },
  { units: 12, beats: 1.5, dots: 1 },
  { units: 14, beats: 1.75, dots: 2 },
  { units: 16, beats: 2, dots: 0 },
  { units: 24, beats: 3, dots: 1 },
  { units: 28, beats: 3.5, dots: 2 },
  { units: 32, beats: 4, dots: 0 },
  { units: 48, beats: 6, dots: 1 },
  { units: 56, beats: 7, dots: 2 },
]

function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 120
  return Math.max(20, Math.min(400, bpm))
}

/** Nearest single dotted value for a grid-unit length (ties: fewer dots, then shorter). */
function snapUnits(units: number): DurationClass {
  const u = Math.max(1, Math.min(56, Math.round(units)))
  let best = SINGLE_DURATIONS[0]!
  let bestDist = Math.abs(best.units - u)
  for (const cand of SINGLE_DURATIONS) {
    const d = Math.abs(cand.units - u)
    if (
      d < bestDist ||
      (d === bestDist &&
        (cand.dots < best.dots || (cand.dots === best.dots && cand.units < best.units)))
    ) {
      best = cand
      bestDist = d
    }
  }
  return best
}

/** Largest table entry fitting in `cap` (cap ≥ 1, so this never misses). */
function fitUnits(wantUnits: number, roomUnits: number): DurationClass {
  const cap = Math.max(1, Math.min(wantUnits, roomUnits))
  let pick = SINGLE_DURATIONS[0]!
  for (const cand of SINGLE_DURATIONS) {
    if (cand.units > cap) break
    pick = cand
  }
  return pick
}

/** Greedy rest split: largest dotted values first; units = 1 always matches. */
function restSplit(units: number): DurationClass[] {
  const out: DurationClass[] = []
  let rest = Math.round(units)
  while (rest > 0) {
    let pick = SINGLE_DURATIONS[0]!
    for (let i = SINGLE_DURATIONS.length - 1; i >= 0; i--) {
      const cand = SINGLE_DURATIONS[i]!
      if (cand.units <= rest) {
        pick = cand
        break
      }
    }
    out.push(pick)
    rest -= pick.units
  }
  return out
}

/** Snap a quarter-beat duration to one dotted symbol (min 32nd, max double-dotted whole). */
export function quantizeDuration(beats: number): { beats: number; dots: number } {
  const snapped = snapUnits(beats / GRID_BEATS)
  return { beats: snapped.beats, dots: snapped.dots }
}

interface TempoSegment {
  /** Seconds (first entry extended back to 0; duplicates share the timestamp, last wins). */
  start: number
  /** Clamped bpm. */
  bpm: number
}

function tempoSegments(midi: MidiFile): TempoSegment[] {
  const entries: readonly TempoEntry[] =
    midi.tempos.length > 0 ? midi.tempos : [{ time: 0, bpm: midi.bpm || 120 }]
  const sorted = [...entries].sort((a, b) => a.time - b.time)
  const segs: TempoSegment[] = [{ start: 0, bpm: clampBpm(sorted[0]?.bpm ?? 120) }]
  for (const e of sorted) {
    const start = Math.max(0, e.time)
    const last = segs[segs.length - 1]!
    if (start <= last.start + EPS) {
      last.bpm = clampBpm(e.bpm)
      continue
    }
    segs.push({ start, bpm: clampBpm(e.bpm) })
  }
  return segs
}

/** Quarter-note beats elapsed at second `t` — integrates the tempo map. */
function secondsToBeats(segs: readonly TempoSegment[], t: number): number {
  if (t <= 0) return 0
  let beats = 0
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (seg.start >= t) break
    const end = segs[i + 1]?.start ?? t
    beats += (Math.min(t, end) - seg.start) * (seg.bpm / 60)
  }
  return beats
}

/** Inverse: second at which `beat` quarter-note beats have elapsed. */
function beatsToSeconds(segs: readonly TempoSegment[], beat: number): number {
  if (beat <= 0) return 0
  let acc = 0
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    const next = segs[i + 1]?.start
    if (next === undefined) return seg.start + ((beat - acc) * 60) / seg.bpm
    const segBeats = (next - seg.start) * (seg.bpm / 60)
    if (acc + segBeats >= beat) return seg.start + ((beat - acc) * 60) / seg.bpm
    acc += segBeats
  }
  const last = segs[segs.length - 1]!
  return last.start + ((beat - acc) * 60) / last.bpm
}

interface MeasureSpan {
  startBeat: number
  endBeat: number
  /** Bar length in grid units (≥ 1) — what the voice symbols sum to. */
  units: number
  numerator: number
  denominator: number
}

function layoutMeasures(
  midi: MidiFile,
  segs: readonly TempoSegment[],
  pieceEndBeat: number,
): MeasureSpan[] {
  const entries: readonly MeterEntry[] =
    midi.timeSignatures.length > 0
      ? midi.timeSignatures
      : [{ time: 0, numerator: 4, denominator: 4 }]
  const sigs = [...entries].sort((a, b) => a.time - b.time)
  const spans: MeasureSpan[] = []
  let cursor = 0
  for (let mi = 0; mi < sigs.length && spans.length < MAX_MEASURES; mi++) {
    const sig = sigs[mi]!
    const num = sig.numerator > 0 ? sig.numerator : 4
    const den = sig.denominator > 0 ? sig.denominator : 4
    // The first meter extends back to the piece start; later ones reset bar
    // counting at their own timestamp. Out-of-order beat positions clamp so
    // a stray entry can never move the cursor backwards.
    const next = sigs[mi + 1]
    const segEnd = next
      ? Math.max(cursor, secondsToBeats(segs, Math.max(0, next.time)))
      : pieceEndBeat
    const barBeats = (num * 4) / den
    while (cursor < segEnd - EPS && spans.length < MAX_MEASURES) {
      const end = Math.min(cursor + barBeats, segEnd)
      spans.push({
        startBeat: cursor,
        endBeat: end,
        units: Math.max(1, Math.round((end - cursor) / GRID_BEATS)),
        numerator: num,
        denominator: den,
      })
      cursor = end
    }
    cursor = Math.max(cursor, segEnd)
  }
  if (spans.length === 0) {
    const first = sigs[0] ?? { time: 0, numerator: 4, denominator: 4 }
    const num = first.numerator > 0 ? first.numerator : 4
    const den = first.denominator > 0 ? first.denominator : 4
    spans.push({
      startBeat: 0,
      endBeat: (num * 4) / den,
      units: Math.max(1, Math.round((num * 4) / den / GRID_BEATS)),
      numerator: num,
      denominator: den,
    })
  }
  return spans
}

function findMeasure(spans: readonly MeasureSpan[], beat: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (beat < spans[i]!.endBeat - EPS) return i
  }
  return spans.length - 1
}

interface VoiceNote {
  beat: number
  endBeat: number
  pitch: number
  time: number
}

function collectVoice(
  midi: MidiFile,
  segs: readonly TempoSegment[],
  visibleIds: ReadonlySet<string> | null,
  staff: 'treble' | 'bass',
): VoiceNote[] {
  const out: VoiceNote[] = []
  for (const track of midi.tracks) {
    if (track.isDrum) continue
    if (visibleIds && !visibleIds.has(track.id)) continue
    for (const n of track.notes) {
      if (n.pitch < MIN_PITCH || n.pitch > MAX_PITCH) continue
      if (staffForNote(n.pitch) !== staff) continue
      const beat = secondsToBeats(segs, n.time)
      const endBeat = Math.max(beat, secondsToBeats(segs, n.time + Math.max(0, n.duration)))
      out.push({ beat, endBeat, pitch: n.pitch, time: n.time })
    }
  }
  out.sort((a, b) => a.time - b.time || a.pitch - b.pitch)
  return out
}

interface Chord {
  beat: number
  endBeat: number
  pitches: number[]
  /** Original onset seconds (for playback highlighting). */
  time: number
}

function groupChords(notes: readonly VoiceNote[]): Chord[] {
  const chords: Chord[] = []
  for (const n of notes) {
    const cur = chords[chords.length - 1]
    if (cur && n.time - cur.time <= NOTATION_CHORD_GROUP_SEC + 1e-9) {
      if (!cur.pitches.includes(n.pitch)) {
        cur.pitches.push(n.pitch)
        cur.pitches.sort((a, b) => a - b)
      }
      cur.endBeat = Math.max(cur.endBeat, n.endBeat)
    } else {
      chords.push({ beat: n.beat, endBeat: n.endBeat, pitches: [n.pitch], time: n.time })
    }
  }
  return chords
}

function emitVoice(chords: readonly Chord[], spans: readonly MeasureSpan[]): NotationSymbol[][] {
  const out: NotationSymbol[][] = spans.map(() => [])
  const buckets: Chord[][] = spans.map(() => [])
  for (const c of chords) buckets[findMeasure(spans, c.beat)]!.push(c)
  let carry: Chord[] = []
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!
    // Carried chords sound before the bucket's own (they rounded past the
    // previous bar line), so they come first.
    const pending = carry.length > 0 ? [...carry, ...buckets[i]!] : buckets[i]!
    carry = []
    let cursor = 0
    for (const c of pending) {
      let start = Math.round((c.beat - span.startBeat) / GRID_BEATS)
      if (start < 0) start = 0
      if (start >= span.units) {
        // Rounded past the bar line — belongs to the next downbeat.
        if (i + 1 < spans.length) {
          carry.push(c)
          continue
        }
        start = span.units - 1
      }
      // Overlapping onset: the previous chord is still ringing, so start
      // here instead of double-counting the overlap.
      if (start < cursor) start = cursor
      // Bar already full — without ties IR v1 cannot represent the onset.
      if (start >= span.units) continue
      if (start > cursor) {
        for (const r of restSplit(start - cursor)) {
          out[i]!.push({ kind: 'rest', beats: r.beats, dots: r.dots })
        }
        cursor = start
      }
      const room = span.units - start
      const want = snapUnits((c.endBeat - c.beat) / GRID_BEATS).units
      const entry = fitUnits(want, room)
      out[i]!.push({
        kind: 'note',
        pitches: [...c.pitches],
        beats: entry.beats,
        dots: entry.dots,
        time: c.time,
      })
      cursor = start + entry.units
    }
    if (cursor < span.units) {
      for (const r of restSplit(span.units - cursor)) {
        out[i]!.push({ kind: 'rest', beats: r.beats, dots: r.dots })
      }
    }
  }
  return out
}

export function buildNotation(
  midi: MidiFile,
  visibleIds: ReadonlySet<string> | null,
): NotationMeasure[] {
  const segs = tempoSegments(midi)
  const trebleNotes = collectVoice(midi, segs, visibleIds, 'treble')
  const bassNotes = collectVoice(midi, segs, visibleIds, 'bass')
  const fileEnd = Number.isFinite(midi.duration) ? Math.max(0, midi.duration) : 0
  let pieceEndBeat = secondsToBeats(segs, fileEnd)
  for (const n of trebleNotes) pieceEndBeat = Math.max(pieceEndBeat, n.endBeat)
  for (const n of bassNotes) pieceEndBeat = Math.max(pieceEndBeat, n.endBeat)
  const spans = layoutMeasures(midi, segs, pieceEndBeat)
  const treble = emitVoice(groupChords(trebleNotes), spans)
  const bass = emitVoice(groupChords(bassNotes), spans)
  return spans.map((span, i) => ({
    number: i + 1,
    time: beatsToSeconds(segs, span.startBeat),
    numerator: span.numerator,
    denominator: span.denominator,
    beats: span.units * GRID_BEATS,
    treble: treble[i]!,
    bass: bass[i]!,
  }))
}
