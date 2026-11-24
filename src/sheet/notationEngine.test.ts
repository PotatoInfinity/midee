import { describe, expect, it } from 'vitest'
import type { MidiFile, MidiTrack } from '../core/midi/types'
import {
  buildNotation,
  type NotationMeasure,
  type NotationSymbol,
  quantizeDuration,
} from './notationEngine'

interface NoteSpec {
  pitch: number
  time: number
  duration: number
}

function track(id: string, notes: NoteSpec[], isDrum = false): MidiTrack {
  return {
    id,
    name: id,
    channel: 0,
    instrument: 0,
    isDrum,
    colorIndex: 0,
    notes: notes.map((n) => ({ ...n, velocity: 0.8 })),
  }
}

function file(opts: {
  tracks: MidiTrack[]
  duration?: number
  bpm?: number
  tempos?: { time: number; bpm: number }[]
  timeSignatures?: { time: number; numerator: number; denominator: number }[]
}): MidiFile {
  const bpm = opts.bpm ?? 120
  return {
    name: 't',
    duration: opts.duration ?? 8,
    bpm,
    timeSignature: [4, 4],
    tempos: opts.tempos ?? [{ time: 0, bpm }],
    timeSignatures: opts.timeSignatures ?? [{ time: 0, numerator: 4, denominator: 4 }],
    tracks: opts.tracks,
  }
}

function sumBeats(syms: readonly NotationSymbol[]): number {
  return syms.reduce((acc, s) => acc + s.beats, 0)
}

function noteAt(m: NotationMeasure, voice: 'treble' | 'bass', index: number): NotationSymbol {
  const s = m[voice][index]
  if (!s) throw new Error(`missing ${voice}[${index}] in measure ${m.number}`)
  return s
}

describe('quantizeDuration', () => {
  it('maps exact note values without dots', () => {
    expect(quantizeDuration(4)).toEqual({ beats: 4, dots: 0 })
    expect(quantizeDuration(2)).toEqual({ beats: 2, dots: 0 })
    expect(quantizeDuration(1)).toEqual({ beats: 1, dots: 0 })
    expect(quantizeDuration(0.5)).toEqual({ beats: 0.5, dots: 0 })
    expect(quantizeDuration(0.25)).toEqual({ beats: 0.25, dots: 0 })
    expect(quantizeDuration(0.125)).toEqual({ beats: 0.125, dots: 0 })
  })

  it('uses single dots for dotted values', () => {
    expect(quantizeDuration(3)).toEqual({ beats: 3, dots: 1 })
    expect(quantizeDuration(1.5)).toEqual({ beats: 1.5, dots: 1 })
    expect(quantizeDuration(0.75)).toEqual({ beats: 0.75, dots: 1 })
    expect(quantizeDuration(0.375)).toEqual({ beats: 0.375, dots: 1 })
  })

  it('uses double dots for doubly-dotted values', () => {
    expect(quantizeDuration(3.5)).toEqual({ beats: 3.5, dots: 2 })
    expect(quantizeDuration(1.75)).toEqual({ beats: 1.75, dots: 2 })
    expect(quantizeDuration(0.875)).toEqual({ beats: 0.875, dots: 2 })
  })

  it('clamps tiny durations to a 32nd', () => {
    expect(quantizeDuration(0.01)).toEqual({ beats: 0.125, dots: 0 })
    expect(quantizeDuration(0)).toEqual({ beats: 0.125, dots: 0 })
  })
})

describe('buildNotation chords', () => {
  it('fuses onsets within 0.04s into one chord', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 67, time: 0.039, duration: 0.5 },
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 64, time: 0.02, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar).toBeDefined()
    expect(bar!.treble).toHaveLength(2)
    const chord = noteAt(bar!, 'treble', 0)
    expect(chord).toMatchObject({ kind: 'note', pitches: [60, 64, 67], beats: 1, dots: 0, time: 0 })
    // 1-beat chord + 3-beat (dotted-half) rest fills the 4/4 bar exactly.
    expect(noteAt(bar!, 'treble', 1)).toMatchObject({ kind: 'rest', beats: 3, dots: 1 })
  })

  it('splits onsets past the 0.04s window', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 64, time: 0.05, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble.filter((s) => s.kind === 'note')).toHaveLength(2)
  })

  it('takes the longest duration in a chord', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 64, time: 0.01, duration: 1.0 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    // 1.0s @120bpm = half note.
    expect(noteAt(bar!, 'treble', 0)).toMatchObject({ kind: 'note', beats: 2, dots: 0 })
  })

  it('dedupes doubled pitches in one chord', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('a', [{ pitch: 60, time: 0, duration: 0.5 }]),
        track('b', [{ pitch: 60, time: 0.01, duration: 0.5 }]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(noteAt(bar!, 'treble', 0)).toMatchObject({ kind: 'note', pitches: [60] })
  })
})

describe('buildNotation rests', () => {
  it('fills every voice to exact bar beats', () => {
    const m = file({
      duration: 8,
      tracks: [track('p', [{ pitch: 60, time: 0, duration: 0.5 }])],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(4)
    for (const bar of bars) {
      expect(sumBeats(bar.treble)).toBeCloseTo(4, 10)
      expect(sumBeats(bar.bass)).toBeCloseTo(4, 10)
    }
    // Untouched bass voice is a single whole rest.
    expect(bars[0]!.bass).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
  })

  it('inserts a middle rest between two notes', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 62, time: 1.0, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble).toEqual([
      { kind: 'note', pitches: [60], beats: 1, dots: 0, time: 0 },
      { kind: 'rest', beats: 1, dots: 0 },
      { kind: 'note', pitches: [62], beats: 1, dots: 0, time: 1 },
      { kind: 'rest', beats: 1, dots: 0 },
    ])
  })

  it('splits unrepresentable gaps greedily', () => {
    // Gap of 2.5 beats (units 20) → half rest + eighth rest.
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 62, time: 1.75, duration: 0.125 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble).toEqual([
      { kind: 'note', pitches: [60], beats: 1, dots: 0, time: 0 },
      { kind: 'rest', beats: 2, dots: 0 },
      { kind: 'rest', beats: 0.5, dots: 0 },
      { kind: 'note', pitches: [62], beats: 0.25, dots: 0, time: 1.75 },
      { kind: 'rest', beats: 0.25, dots: 0 },
    ])
  })

  it('renders a 6/8 bar as a dotted-half rest when empty', () => {
    const m = file({
      duration: 1.5,
      tracks: [],
      timeSignatures: [{ time: 0, numerator: 6, denominator: 8 }],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ numerator: 6, denominator: 8, beats: 3 })
    expect(bars[0]!.treble).toEqual([{ kind: 'rest', beats: 3, dots: 1 }])
    expect(bars[0]!.bass).toEqual([{ kind: 'rest', beats: 3, dots: 1 }])
  })
})

describe('buildNotation meter changes', () => {
  it('splits measures at the meter boundary and keeps exact sums', () => {
    const m = file({
      duration: 5,
      tracks: [track('p', [{ pitch: 60, time: 0, duration: 0.5 }])],
      timeSignatures: [
        { time: 0, numerator: 4, denominator: 4 },
        { time: 2, numerator: 3, denominator: 4 },
      ],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(3)
    expect(bars[0]).toMatchObject({ number: 1, numerator: 4, denominator: 4, beats: 4 })
    expect(bars[1]).toMatchObject({ number: 2, numerator: 3, denominator: 4, beats: 3 })
    expect(bars[2]).toMatchObject({ number: 3, numerator: 3, denominator: 4, beats: 3 })
    expect(bars[0]!.time).toBeCloseTo(0, 10)
    expect(bars[1]!.time).toBeCloseTo(2, 10)
    expect(bars[2]!.time).toBeCloseTo(3.5, 10)
    for (const bar of bars) {
      expect(sumBeats(bar.treble)).toBeCloseTo(bar.beats, 10)
      expect(sumBeats(bar.bass)).toBeCloseTo(bar.beats, 10)
    }
  })
})

describe('buildNotation tempo map', () => {
  it('integrates seconds→beats across a tempo change', () => {
    const m = file({
      duration: 6,
      tracks: [track('p', [{ pitch: 72, time: 3.0, duration: 0.5 }])],
      tempos: [
        { time: 0, bpm: 120 },
        { time: 2, bpm: 60 },
      ],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(2)
    // 0–2s @120bpm = 4 beats (bar 1); 2–6s @60bpm = 4 beats (bar 2).
    // Onset @3s = beat 5 → 1 beat into bar 2; 0.5s @60bpm = half-note beat.
    expect(bars[0]!.treble).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
    expect(bars[1]!.treble).toEqual([
      { kind: 'rest', beats: 1, dots: 0 },
      { kind: 'note', pitches: [72], beats: 0.5, dots: 0, time: 3 },
      { kind: 'rest', beats: 2, dots: 0 },
      { kind: 'rest', beats: 0.5, dots: 0 },
    ])
  })
})

describe('buildNotation voices and filtering', () => {
  it('splits staves at middle C via staffForNote', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 59, time: 0, duration: 0.5 },
          { pitch: 60, time: 0, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(noteAt(bar!, 'bass', 0)).toMatchObject({ kind: 'note', pitches: [59] })
    expect(noteAt(bar!, 'treble', 0)).toMatchObject({ kind: 'note', pitches: [60] })
  })

  it('skips drums and out-of-range pitches, keeping boundary pitches', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('drums', [{ pitch: 60, time: 0, duration: 0.5 }], true),
        track('p', [
          { pitch: 20, time: 0, duration: 0.5 },
          { pitch: 109, time: 0, duration: 0.5 },
          { pitch: 21, time: 0, duration: 0.5 },
          { pitch: 108, time: 0, duration: 0.5 },
          { pitch: 60, time: 0.5, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    const pitches = [...bar!.treble, ...bar!.bass]
      .filter((s) => s.kind === 'note')
      .flatMap((s) => (s.kind === 'note' ? s.pitches : []))
    expect(pitches).toContain(21)
    expect(pitches).toContain(108)
    expect(pitches).toContain(60)
    expect(pitches).not.toContain(20)
    expect(pitches).not.toContain(109)
    // Drum 60 @0 would have fused into the treble chord — it must be absent.
    expect(noteAt(bar!, 'treble', 0)).toMatchObject({ kind: 'note', pitches: [108] })
    expect(pitches.filter((p) => p === 60)).toHaveLength(1)
  })

  it('filters by visibleIds, with null meaning all tracks', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('a', [{ pitch: 60, time: 0, duration: 0.5 }]),
        track('b', [{ pitch: 72, time: 1.0, duration: 0.5 }]),
      ],
    })
    const onlyB = buildNotation(m, new Set(['b']))
    expect(onlyB[0]!.treble.filter((s) => s.kind === 'note')).toHaveLength(1)
    expect(noteAt(onlyB[0]!, 'treble', 1)).toMatchObject({ kind: 'note', pitches: [72], time: 1 })
    const all = buildNotation(m, null)
    expect(all[0]!.treble.filter((s) => s.kind === 'note')).toHaveLength(2)
  })

  it('clamps an overlong chord at the bar line without spilling', () => {
    const m = file({
      duration: 8,
      tracks: [track('p', [{ pitch: 60, time: 0, duration: 8 }])],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(4)
    // 16 beats wanted, 4 fit: no ties in IR v1, so the whole-note fills bar 1…
    expect(bars[0]!.treble).toEqual([{ kind: 'note', pitches: [60], beats: 4, dots: 0, time: 0 }])
    // …and nothing spills into the later bars.
    for (const bar of bars.slice(1)) {
      expect(bar.treble).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
    }
  })
})

describe('quantizeDuration dotted limits', () => {
  it('snaps unsupported lengths to fewer dots, never triple dots', () => {
    // 15 grid units (triple-dotted quarter) ties 14↔16 → fewer dots wins.
    expect(quantizeDuration(1.875)).toEqual({ beats: 2, dots: 0 })
    // 5 units ties 4↔6 → plain eighth wins over dotted eighth.
    expect(quantizeDuration(0.625)).toEqual({ beats: 0.5, dots: 0 })
  })

  it('never returns dots > 2 anywhere on the grid', () => {
    for (let units = 1; units <= 64; units++) {
      const { dots } = quantizeDuration(units * 0.125)
      expect(dots).toBeLessThanOrEqual(2)
    }
  })

  it('caps oversize durations at the double-dotted whole', () => {
    expect(quantizeDuration(8)).toEqual({ beats: 7, dots: 2 })
  })
})

describe('buildNotation dotted notes and rests', () => {
  it('emits a double-dotted note for 1.75 beats', () => {
    const m = file({
      duration: 2,
      tracks: [track('p', [{ pitch: 60, time: 0, duration: 0.875 }])],
    })
    const [bar] = buildNotation(m, null)
    expect(noteAt(bar!, 'treble', 0)).toMatchObject({ kind: 'note', beats: 1.75, dots: 2 })
  })

  it('renders a 7-unit gap as one double-dotted rest', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 62, time: 0.9375, duration: 0.0625 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble).toEqual([
      { kind: 'note', pitches: [60], beats: 1, dots: 0, time: 0 },
      { kind: 'rest', beats: 0.875, dots: 2 },
      { kind: 'note', pitches: [62], beats: 0.125, dots: 0, time: 0.9375 },
      { kind: 'rest', beats: 2, dots: 0 },
    ])
  })
})

describe('buildNotation triplet snap', () => {
  it('snaps triplet durations to the nearest 32nd', () => {
    // Triplet eighth (1/3 beat) rounds to 3 units: dotted eighth.
    expect(quantizeDuration(1 / 3)).toEqual({ beats: 0.375, dots: 1 })
    // Triplet quarter (2/3 beat) rounds to 5 units, which ties 4↔6 → plain eighth.
    expect(quantizeDuration(2 / 3)).toEqual({ beats: 0.5, dots: 0 })
  })

  it('snaps a triplet onset to the nearest 32nd and still fills the bar', () => {
    const m = file({
      duration: 2,
      tracks: [track('p', [{ pitch: 60, time: 1 / 6, duration: 0.0625 }])],
    })
    const [bar] = buildNotation(m, null)
    // Beat 1/3 snaps to 3 units, so the leading gap is a dotted-eighth rest.
    expect(bar!.treble).toEqual([
      { kind: 'rest', beats: 0.375, dots: 1 },
      { kind: 'note', pitches: [60], beats: 0.125, dots: 0, time: 1 / 6 },
      { kind: 'rest', beats: 3.5, dots: 2 },
    ])
    expect(sumBeats(bar!.treble)).toBeCloseTo(4, 10)
  })
})

describe('buildNotation meter change mid-piece', () => {
  it('truncates the bar at the boundary and resets counting', () => {
    const m = file({
      duration: 3,
      tracks: [],
      timeSignatures: [
        { time: 0, numerator: 4, denominator: 4 },
        { time: 1.5, numerator: 3, denominator: 4 },
      ],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ number: 1, numerator: 4, denominator: 4, beats: 3 })
    expect(bars[1]).toMatchObject({ number: 2, numerator: 3, denominator: 4, beats: 3 })
    expect(bars[1]!.time).toBeCloseTo(1.5, 10)
    for (const bar of bars) {
      expect(bar.treble).toEqual([{ kind: 'rest', beats: 3, dots: 1 }])
      expect(bar.bass).toEqual([{ kind: 'rest', beats: 3, dots: 1 }])
    }
  })

  it('clamps a note ringing past the boundary instead of straddling it', () => {
    const sigs = [
      { time: 0, numerator: 4, denominator: 4 },
      { time: 1.5, numerator: 3, denominator: 4 },
    ]
    const m = file({
      duration: 3,
      tracks: [track('p', [{ pitch: 60, time: 1.0, duration: 2.0 }])],
      timeSignatures: sigs,
    })
    const bars = buildNotation(m, null)
    // Onset beat 2 sits 16 units into the truncated 24-unit bar 1 → 8 units of room.
    expect(bars[0]!.treble).toEqual([
      { kind: 'rest', beats: 2, dots: 0 },
      { kind: 'note', pitches: [60], beats: 1, dots: 0, time: 1.0 },
    ])
    // No tie in IR v1: nothing spills into bar 2.
    expect(bars[1]!.treble).toEqual([{ kind: 'rest', beats: 3, dots: 1 }])
  })
})

describe('buildNotation tempo change both directions', () => {
  it('inverts beats↔seconds for measure starts', () => {
    const m = file({
      duration: 6,
      tracks: [],
      tempos: [
        { time: 0, bpm: 120 },
        { time: 2, bpm: 60 },
      ],
    })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ beats: 4, time: 0 })
    // 4 beats elapse by 2s, so bar 2 starts at second 2 (beatsToSeconds inverts it).
    expect(bars[1]!.time).toBeCloseTo(2, 10)
    expect(bars[1]).toMatchObject({ beats: 4 })
  })

  it('scales identical seconds to different beats across the change', () => {
    const tempos = [
      { time: 0, bpm: 120 },
      { time: 2, bpm: 60 },
    ]
    const m = file({
      duration: 6,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 72, time: 3, duration: 0.5 },
        ]),
      ],
      tempos,
    })
    const bars = buildNotation(m, null)
    // 0.5s @120bpm = quarter; 0.5s @60bpm = eighth.
    expect(noteAt(bars[0]!, 'treble', 0)).toMatchObject({
      kind: 'note',
      pitches: [60],
      beats: 1,
      dots: 0,
      time: 0,
    })
    expect(bars[1]!.treble[0]).toMatchObject({ kind: 'rest', beats: 1, dots: 0 })
    const notes = bars[1]!.treble.filter((s) => s.kind === 'note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'note', pitches: [72], beats: 0.5, dots: 0, time: 3 })
  })
})

describe('buildNotation overlapping legato', () => {
  it('shifts an overlapping same-pitch onset forward without double-counting', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 1.0 },
          { pitch: 60, time: 0.5, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble).toEqual([
      { kind: 'note', pitches: [60], beats: 2, dots: 0, time: 0 },
      { kind: 'note', pitches: [60], beats: 1, dots: 0, time: 0.5 },
      { kind: 'rest', beats: 1, dots: 0 },
    ])
    expect(sumBeats(bar!.treble)).toBeCloseTo(4, 10)
  })

  it('keeps back-to-back notes with no gap rest', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 60, time: 0, duration: 0.5 },
          { pitch: 62, time: 0.5, duration: 0.5 },
        ]),
      ],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble.slice(0, 2)).toEqual([
      { kind: 'note', pitches: [60], beats: 1, dots: 0, time: 0 },
      { kind: 'note', pitches: [62], beats: 1, dots: 0, time: 0.5 },
    ])
  })
})

describe('buildNotation empty voices', () => {
  it('fills a fully empty bar with whole rests in both voices', () => {
    const m = file({ duration: 2, tracks: [] })
    const bars = buildNotation(m, null)
    expect(bars).toHaveLength(1)
    expect(bars[0]!.treble).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
    expect(bars[0]!.bass).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
  })

  it('leaves the untouched treble as a whole rest for bass-only notes', () => {
    const m = file({
      duration: 2,
      tracks: [track('p', [{ pitch: 40, time: 0, duration: 0.5 }])],
    })
    const [bar] = buildNotation(m, null)
    expect(bar!.treble).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
    expect(bar!.bass[0]).toMatchObject({ kind: 'note', pitches: [40], beats: 1, time: 0 })
    expect(sumBeats(bar!.bass)).toBeCloseTo(4, 10)
  })
})

describe('buildNotation visibleIds with drums and range', () => {
  it('still skips drums even when only the drum track is visible', () => {
    const m = file({
      duration: 2,
      tracks: [
        track('d', [{ pitch: 60, time: 0, duration: 0.5 }], true),
        track('p', [{ pitch: 72, time: 0, duration: 0.5 }]),
      ],
    })
    const bars = buildNotation(m, new Set(['d']))
    expect(bars[0]!.treble).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
    expect(bars[0]!.bass).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
  })

  it('still drops out-of-range pitches for a visible track; empty set means no notes', () => {
    const mixed = file({
      duration: 2,
      tracks: [
        track('p', [
          { pitch: 20, time: 0, duration: 0.5 },
          { pitch: 108, time: 0, duration: 0.5 },
        ]),
      ],
    })
    const bars = buildNotation(mixed, new Set(['p']))
    const pitches = bars[0]!.treble.flatMap((s) => (s.kind === 'note' ? s.pitches : []))
    expect(pitches).toEqual([108])
    const none = buildNotation(mixed, new Set([]))
    expect(none[0]!.treble).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
    expect(none[0]!.bass).toEqual([{ kind: 'rest', beats: 4, dots: 0 }])
  })
})
