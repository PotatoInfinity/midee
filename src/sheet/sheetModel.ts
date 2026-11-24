// Scrolling sheet model — time-based slot builder.
//
// Approach inspired by PianoBooster's scrolling stave core (GPLv3):
//   - chord grouping (notes within ~40ms form one step — same window our
//     PracticeEngine uses),
//   - bar/beat tracking from the time signature + tempo map (cf. CBar),
//   - per-bar accidental suppression (cf. CNotation::detectSuppressedNatural).
//
// This implementation is original (no PianoBooster code copied): it operates
// on seconds (not ppqn ticks), assumes C major spelling (sharps for black
// keys), and emits flat time-sorted arrays the canvas renderer draws with a
// simple time→x mapping. Only the *ideas* are borrowed.

import type { MidiFile } from '../core/midi/types'
import { isAccidental, staffForNote } from '../learn/exercises/sight-reading/music'

export interface SheetNote {
  time: number
  pitch: number
  duration: number
  trackId: string
  staff: 'treble' | 'bass'
  accidental: boolean
  showAccidental: boolean
}

export interface SheetBar {
  time: number
  number: number
}

// Grouping window for chord steps — mirrors STEP_GROUPING_SEC in
// PracticeEngine so sheet chords and wait steps agree.
export const SHEET_CHORD_GROUP_SEC = 0.04

export function buildSheetNotes(
  midi: MidiFile,
  visibleTrackIds: ReadonlySet<string> | null,
): SheetNote[] {
  const notes: SheetNote[] = []
  for (const track of midi.tracks) {
    if (track.isDrum) continue
    if (visibleTrackIds && !visibleTrackIds.has(track.id)) continue
    for (const n of track.notes) {
      if (n.pitch < 21 || n.pitch > 108) continue
      const acc = isAccidental(n.pitch)
      notes.push({
        time: n.time,
        pitch: n.pitch,
        duration: n.duration,
        trackId: track.id,
        staff: staffForNote(n.pitch),
        accidental: acc,
        showAccidental: acc, // fixed up per-bar below
      })
    }
  }
  notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch)
  return notes
}

// Bar lines from the meter + tempo maps. Walks each time-signature segment,
// subdividing by tempo changes, emitting a line every barLen seconds.
// Mirrors CBar's beatLength = quarter * 4/bottom, barLength = beat * top.
export function buildBarLines(midi: MidiFile): SheetBar[] {
  const bars: SheetBar[] = []
  const sigs =
    midi.timeSignatures.length > 0
      ? midi.timeSignatures
      : [{ time: 0, numerator: 4, denominator: 4 }]
  const tempos = midi.tempos.length > 0 ? midi.tempos : [{ time: 0, bpm: midi.bpm || 120 }]
  let number = 1
  for (let si = 0; si < sigs.length; si++) {
    const sig = sigs[si]!
    const segStart = Math.max(0, sig.time)
    const segEnd = si + 1 < sigs.length ? sigs[si + 1]!.time : midi.duration
    if (segEnd <= segStart) continue
    // Tempo sub-segments inside this meter segment.
    const bounds: number[] = [segStart]
    for (const tp of tempos) {
      if (tp.time > segStart && tp.time < segEnd) bounds.push(tp.time)
    }
    bounds.push(segEnd)
    bounds.sort((a, b) => a - b)
    for (let bi = 0; bi + 1 < bounds.length; bi++) {
      const subStart = bounds[bi]!
      const subEnd = bounds[bi + 1]!
      const bpm = tempoAt(tempos, subStart) || midi.bpm || 120
      const beatLen = (60 / Math.max(20, Math.min(400, bpm))) * (4 / sig.denominator)
      const barLen = Math.max(0.2, beatLen * sig.numerator)
      // First line of the piece / segment.
      if (bars.length === 0 || Math.abs(bars[bars.length - 1]!.time - subStart) > 1e-6) {
        // Avoid duplicating a line at a segment joint.
        if (bars.length === 0) {
          bars.push({ time: 0, number: number++ })
        } else if (subStart > bars[bars.length - 1]!.time + 1e-6) {
          bars.push({ time: subStart, number: number++ })
        }
      }
      let t = (bars.length > 0 ? bars[bars.length - 1]!.time : subStart) + barLen
      // If we just pushed subStart, step from there.
      if (bars.length > 0 && Math.abs(bars[bars.length - 1]!.time - subStart) < 1e-6) {
        t = subStart + barLen
      }
      while (t < subEnd - 1e-6) {
        bars.push({ time: t, number: number++ })
        t += barLen
      }
    }
  }
  bars.sort((a, b) => a.time - b.time)
  return bars
}

function tempoAt(tempos: { time: number; bpm: number }[], t: number): number {
  let bpm = tempos[0]?.bpm ?? 120
  for (const tp of tempos) {
    if (tp.time <= t + 1e-9) bpm = tp.bpm
    else break
  }
  return bpm
}

// Per-bar accidental suppression: the first sharp of a pitch class in a bar
// shows ♯, repeats in the same bar don't. Resets at every bar line — the
// same rule PianoBooster applies (minus key signatures / courtesy naturals).
export function applyAccidentalSuppression(notes: SheetNote[], bars: SheetBar[]): void {
  const barTimes = bars.map((b) => b.time)
  let barIdx = -1
  let seen = new Set<number>()
  for (const n of notes) {
    while (barIdx + 1 < barTimes.length && barTimes[barIdx + 1]! <= n.time + 1e-9) {
      barIdx++
      seen = new Set()
    }
    if (!n.accidental) {
      n.showAccidental = false
      continue
    }
    const pc = n.pitch % 12
    if (seen.has(pc)) n.showAccidental = false
    else {
      n.showAccidental = true
      seen.add(pc)
    }
  }
}

export interface SheetData {
  notes: SheetNote[]
  bars: SheetBar[]
}
export function buildSheetData(
  midi: MidiFile,
  visibleTrackIds: ReadonlySet<string> | null,
): SheetData {
  const notes = buildSheetNotes(midi, visibleTrackIds)
  const bars = buildBarLines(midi)
  applyAccidentalSuppression(notes, bars)
  return { notes, bars }
}

// One x per onset for the sheet's time<->x maps. Laid-out notehead centers
// come one per pitch: chord members share an x exactly and the treble/bass
// doubles of a slice sit a few px apart. Collapsing each onset to its mean x
// keeps the forward map time-ordered with distinct times, so neither binary
// search can strand a drag between two same-time samples.
export interface TimeSample {
  t: number
  x: number
}

export function collapseToOnsets(points: ReadonlyArray<TimeSample>): TimeSample[] {
  const ordered = [...points].sort((a, b) => a.t - b.t || a.x - b.x)
  const out: TimeSample[] = []
  for (const s of ordered) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(s.t - prev.t) <= 1e-9) {
      const n = (prev as TimeSample & { n?: number }).n ?? 1
      ;(prev as TimeSample & { n?: number }).n = n + 1
      prev.x += (s.x - prev.x) / (n + 1)
    } else {
      out.push({ t: s.t, x: s.x })
    }
  }
  for (const s of out) delete (s as TimeSample & { n?: number }).n
  return out
}

// Snap a bar's interpolated x to its downbeat onset so meter lines never
// float between heads: bars come from the meter/tempo map (seconds) while
// notehead x comes from the Formatter-justified engraving (quantized beats).
// Interpolating a bar time between the real-time onset samples already puts
// it on the same timeline; snapping finishes the job when a downbeat onset
// is adjacent in time (<= BAR_SNAP_SEC) or the interpolation already lands
// within a staff-wobble (<= BAR_SNAP_PX) of a laid-out head.
export const BAR_SNAP_SEC = 0.15
export const BAR_SNAP_PX = 12

/** Linear interpolation between onset samples (extrapolates past the ends). */
export function interpolateX(t: number, samples: ReadonlyArray<TimeSample>): number | null {
  if (samples.length === 0) return null
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  if (t <= first.t) {
    if (samples.length < 2) return first.x
    const b = samples[1]!
    const dt = b.t - first.t
    if (dt <= 1e-9) return first.x
    return first.x - ((first.t - t) / dt) * (b.x - first.x)
  }
  if (t >= last.t) {
    if (samples.length < 2) return last.x
    const a = samples[samples.length - 2]!
    const dt = last.t - a.t
    if (dt <= 1e-9) return last.x
    return last.x + ((t - last.t) / dt) * (last.x - a.x)
  }
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid]!.t <= t) lo = mid
    else hi = mid
  }
  const A = samples[lo]!
  const B = samples[hi]!
  const span = B.t - A.t
  if (span <= 1e-9) return A.x
  return A.x + ((t - A.t) / span) * (B.x - A.x)
}

/** Nearest onset sample to a time (by |t|). */
export function nearestSampleByTime(
  t: number,
  samples: ReadonlyArray<TimeSample>,
): TimeSample | null {
  if (samples.length === 0) return null
  let best = samples[0]!
  let bestDt = Math.abs(best.t - t)
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.abs(samples[i]!.t - t)
    if (dt < bestDt) {
      bestDt = dt
      best = samples[i]!
    }
  }
  return best
}

/**
 * Bar-line x on the SAME engraved timeline as the noteheads: interpolate the
 * bar's real second between the real-time onset samples, then lock to the
 * downbeat head when one is adjacent. Returns null with no samples.
 */
export function barXForTime(t: number, samples: ReadonlyArray<TimeSample>): number | null {
  const x = interpolateX(t, samples)
  if (x === null) return null
  const near = nearestSampleByTime(t, samples)
  if (near && Math.abs(near.t - t) <= BAR_SNAP_SEC) return near.x
  let bestX = x
  let bestDx = Infinity
  for (const s of samples) {
    const dx = Math.abs(s.x - x)
    if (dx < bestDx) {
      bestDx = dx
      bestX = s.x
    }
  }
  if (bestDx <= BAR_SNAP_PX) return bestX
  return x
}

// Inverse lookup needs x order; laid-out x is only near-monotonic in time
// (formatter widths differ per staff), so keep a dedicated x-sorted copy.
// Residual equal-x entries are dropped — inverting through them would
// average two different times into a phantom position mid-drag.
export function buildInverseSamples(samples: ReadonlyArray<TimeSample>): TimeSample[] {
  const inv = [...samples].sort((a, b) => a.x - b.x || a.t - b.t)
  for (let i = inv.length - 1; i > 0; i--) {
    if (Math.abs(inv[i]!.x - inv[i - 1]!.x) <= 1e-9) inv.splice(i, 1)
  }
  return inv
}
