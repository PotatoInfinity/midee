import { describe, expect, it, vi } from 'vitest'
import type { MidiFile } from '../core/midi/types'
import { PlayWaitController } from './waitController'

function midi(): MidiFile {
  return {
    name: 't',
    duration: 10,
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
          { pitch: 60, time: 1, duration: 0.5, velocity: 0.8 },
          { pitch: 62, time: 2, duration: 0.5, velocity: 0.8 },
        ],
      },
    ],
  }
}

function services() {
  const clockState = { currentTime: 0 }
  return {
    clock: {
      get currentTime() {
        return clockState.currentTime
      },
      set currentTime(v: number) {
        clockState.currentTime = v
      },
      playing: false,
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn((t: number) => {
        clockState.currentTime = t
      }),
      subscribe: () => () => {},
    },
    synth: { seek: vi.fn() },
    store: { setState: vi.fn() },
  } as unknown as ServicesT
}

type ServicesT = import('../core/services').AppServices

function setTime(s: ServicesT, t: number): void {
  ;(s.clock as unknown as { currentTime: number }).currentTime = t
}

describe('PlayWaitController', () => {
  it('scores strict wait via PracticeEngine', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    c.play()
    // strict by default; simulate waiting by seeking to just before first note
    setTime(servicesObj, 0.995)
    const r1 = c.onNoteOn({ pitch: 60, velocity: 0.8, clockTime: 0.995 } as never)
    expect(r1).toBe('advanced')
    expect(c.accuracy()).toBe(100)
    c.dispose()
  })

  it('ignores presses while paused with no intent to play', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    setTime(servicesObj, 1.0)
    // strict: no intent, clock stopped → no scoring
    expect(c.onNoteOn({ pitch: 61, velocity: 0.8, clockTime: 1.0 } as never)).toBe('none')
    expect(c.errors()).toBe(0)
    c.setStrict(false)
    expect(c.onNoteOn({ pitch: 61, velocity: 0.8, clockTime: 1.0 } as never)).toBe('none')
    expect(c.errors()).toBe(0)
    c.dispose()
  })

  it('ignores out-of-range pitches instead of penalizing them', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    c.setStrict(false)
    c.play()
    setTime(servicesObj, 1.0)
    expect(c.onNoteOn({ pitch: 200, velocity: 0.8, clockTime: 1.0 } as never)).toBe('none')
    expect(c.errors()).toBe(0)
    c.dispose()
  })

  it('scores while the clock runs even without explicit intent', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    c.setStrict(false)
    ;(servicesObj.clock as unknown as { playing: boolean }).playing = true
    setTime(servicesObj, 1.0)
    expect(c.onNoteOn({ pitch: 60, velocity: 0.8, clockTime: 1.0 } as never)).toBe('advanced')
    c.dispose()
  })

  it('attach() drops stale play intent from the previous file', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    c.play()
    expect(c.userWantsToPlay()).toBe(true)
    c.attach(midi())
    expect(c.userWantsToPlay()).toBe(false)
    c.dispose()
  })

  it('play() clears a stuck wait hint', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    c.play()
    setTime(servicesObj, 0.995)
    // Early press engages the wait (single-note chord clears it, but the
    // engage path runs first).
    c.onNoteOn({ pitch: 60, velocity: 0.8, clockTime: 0.995 } as never)
    c.play()
    expect(c.isWaiting()).toBe(false)
    c.dispose()
  })

  it('wraps to the top at end of piece only with intent to play', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setEnabled(true)
    const seek = servicesObj.clock.seek as unknown as ReturnType<typeof vi.fn>
    // No intent: parked at the end, no wrap.
    c.onTick(10)
    expect(seek).not.toHaveBeenCalled()
    // With intent: wraps to 0 and keeps going.
    c.play()
    seek.mockClear()
    c.onTick(10)
    expect(seek).toHaveBeenCalledWith(0)
    c.dispose()
  })

  it('flow mode grades without pausing', () => {
    const servicesObj = services()
    const flashes: number[] = []
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
      onErrorFlash: (p) => flashes.push(p),
    })
    c.attach(midi())
    c.setEnabled(true)
    c.setStrict(false)
    c.play()
    setTime(servicesObj, 1.0)
    const r = c.onNoteOn({ pitch: 60, velocity: 0.8, clockTime: 1.0 } as never)
    expect(r).toBe('advanced')
    expect(c.errors()).toBe(0)
    setTime(servicesObj, 5.0)
    const r2 = c.onNoteOn({ pitch: 99, velocity: 0.8, clockTime: 5.0 } as never)
    expect(r2).toBe('rejected')
    expect(c.errors()).toBe(1)
    expect(flashes).toContain(99)
    c.dispose()
  })

  it('loop toggle creates and clears a region', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    const region = c.toggleLoop(1)
    expect(region).not.toBeNull()
    expect(c.loopRegion()).not.toBeNull()
    c.toggleLoop(1)
    expect(c.loopRegion()).toBeNull()
    c.dispose()
  })

  it('sub-min regions are rejected, never partially applied', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setLoop({ start: 2, end: 4 })
    c.setLoop({ start: 2, end: 2.1 })
    expect(c.loopRegion()).toEqual({ start: 2, end: 4 })
    c.dispose()
  })

  it('seek() resumes a running plain-playback transport (loop-safe)', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    // Normal play: clock running, no wait intent.
    ;(servicesObj.clock as unknown as { playing: boolean }).playing = true
    const play = servicesObj.clock.play as unknown as ReturnType<typeof vi.fn>
    c.seek(3)
    expect((servicesObj.clock as unknown as { currentTime: number }).currentTime).toBe(3)
    expect(play).toHaveBeenCalled()
    expect(servicesObj.store.setState).toHaveBeenLastCalledWith('status', 'playing')
    c.dispose()
  })

  it('seek() while paused stays paused', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    const play = servicesObj.clock.play as unknown as ReturnType<typeof vi.fn>
    c.seek(3)
    expect(play).not.toHaveBeenCalled()
    expect(servicesObj.store.setState).toHaveBeenLastCalledWith('status', 'paused')
    c.dispose()
  })

  it('onTick suppresses wraps while a loop edit is in flight', () => {
    const servicesObj = services()
    const c = new PlayWaitController({
      services: servicesObj,
      isTrackVisible: () => true,
    })
    c.attach(midi())
    c.setLoop({ start: 2, end: 4 })
    ;(servicesObj.clock as unknown as { playing: boolean }).playing = true
    const seek = servicesObj.clock.seek as unknown as ReturnType<typeof vi.fn>
    c.beginLoopEdit()
    c.onTick(5)
    expect(seek).not.toHaveBeenCalled()
    // Ending the edit re-parks the playhead when it lies outside the region.
    setTime(servicesObj, 5)
    c.endLoopEdit()
    expect(seek).toHaveBeenCalledWith(2)
    c.dispose()
  })
})
