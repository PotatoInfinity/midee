import { describe, expect, it } from 'vitest'
import type { MidiFile } from '../core/midi/types'
import {
  applyAccidentalSuppression,
  barXForTime,
  buildBarLines,
  buildSheetNotes,
} from './sheetModel'

function midi(): MidiFile {
  return {
    name: 't',
    duration: 8,
    bpm: 120,
    timeSignature: [4, 4],
    tempos: [{ time: 0, bpm: 120 }],
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        id: 'p1',
        name: 'p',
        channel: 0,
        instrument: 0,
        isDrum: false,
        colorIndex: 0,
        notes: [
          { pitch: 60, time: 0, duration: 0.5, velocity: 0.8 },
          { pitch: 61, time: 0.01, duration: 0.5, velocity: 0.8 },
          { pitch: 61, time: 1, duration: 0.5, velocity: 0.8 },
          { pitch: 59, time: 3, duration: 0.5, velocity: 0.8 },
        ],
      },
    ],
  }
}

describe('sheetModel', () => {
  it('builds notes with staff split', () => {
    const notes = buildSheetNotes(midi(), null)
    expect(notes).toHaveLength(4)
    // 61 (C#4) is treble, 59 (B3) is bass
    expect(notes.find((n) => n.pitch === 59)?.staff).toBe('bass')
    expect(notes.find((n) => n.pitch === 60)?.staff).toBe('treble')
  })

  it('suppresses repeated accidentals within a bar', () => {
    const m = midi()
    const notes = buildSheetNotes(m, null)
    const bars = buildBarLines(m)
    expect(bars.length).toBeGreaterThan(1)
    applyAccidentalSuppression(notes, bars)
    const firstSharp = notes.find((n) => n.pitch === 61 && Math.abs(n.time - 0.01) < 1e-6)
    const secondSharp = notes.find((n) => n.pitch === 61 && Math.abs(n.time - 1) < 1e-6)
    expect(firstSharp?.showAccidental).toBe(true)
    // same bar (4/4 @120bpm = 2s bars), same pitch class → suppressed
    expect(secondSharp?.showAccidental).toBe(false)
  })

  it('emits bar lines every 2s at 120bpm 4/4', () => {
    const bars = buildBarLines(midi())
    expect(bars[0]?.time).toBe(0)
    expect(bars[1]?.time).toBeCloseTo(2, 5)
    expect(bars[2]?.time).toBeCloseTo(4, 5)
  })

  it('maps bar times through onset samples within 12px of a head', () => {
    // Same timeline for bars + heads: quarters every 0.5s on a 224px/s grid.
    const samples = Array.from({ length: 17 }, (_, i) => ({
      t: i * 0.5,
      x: 100 + i * 0.5 * 224,
    }))
    for (const b of buildBarLines(midi())) {
      const x = barXForTime(b.time, samples)
      expect(x).not.toBeNull()
      let nearest = Infinity
      for (const s of samples) nearest = Math.min(nearest, Math.abs(s.x - x!))
      expect(nearest).toBeLessThanOrEqual(12)
    }
    expect(barXForTime(99, [])).toBeNull()
  })
})
