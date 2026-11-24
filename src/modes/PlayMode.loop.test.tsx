// Regression: a sheet loop must survive pointer release.
//
// Root cause this locks in: <PlayMode/>'s createEffect re-ran on EVERY loop
// change, because it read `waitController.loopRegion()` (a Solid signal) while
// syncing the sheet. The commit path is:
//
//   pointerup -> SheetView.onUp -> onLoopChange -> waitController.setLoop
//     -> _loop signal fires -> PlayMode effect re-runs -> attach(same midi)
//     -> loop cleared to null -> sheetView.setLoop(null)
//
// …so the orange band + ✕ vanished in the same frame the pointer lifted.
// The effect must only re-attach on a genuinely new file (transpose keeps the
// loop: same sourceMidi, new loadedMidi twin).
//
// jsdom has no 2D canvas and VexFlow is mocked to fail loading, so the sheet
// falls back to its deterministic time<->x line (x = 8 + t*185, w = 800),
// exactly like SheetView.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vexflow', () => {
  throw new Error('vexflow unavailable in jsdom')
})

import { renderWithApp } from '../test/renderWithApp'
import { PlayWaitController } from '../play/waitController'
import { SheetView } from '../sheet/SheetView'
import { createAppStore } from '../store/state'
import { WAIT_LOOP_MIN_SEC } from '../play/waitController'
import { PlayMode } from './PlayMode'

function stubCanvas(): void {
  const noop = (): void => {}
  const ctxStub = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'canvas') return {}
        if (prop === 'measureText') return () => ({ width: 10 })
        if (prop === 'getImageData') return () => ({ data: [] })
        return noop
      },
      set: () => true,
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub as never)
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback): number => window.setTimeout(() => cb(performance.now()), 16),
    writable: true,
    configurable: true,
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    value: (id: number): void => window.clearTimeout(id),
    writable: true,
    configurable: true,
  })
}

function makeMidi(): never {
  return {
    name: 't',
    duration: 60,
    bpm: 120,
    timeSignature: [4, 4],
    tempos: [{ time: 0, bpm: 120 }],
    timeSignatures: [{ time: 0, numerator: 4, denominator: 4 }],
    pedal: [],
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
  } as never
}

function makeClock(): {
  currentTime: number
  playing: boolean
  subscribe: (cb: (t: number) => void) => () => void
  play: () => void
  pause: () => void
  seek: (t: number) => void
} {
  const subs = new Set<(t: number) => void>()
  const clock = {
    currentTime: 0,
    playing: false,
    subscribe: (cb: (t: number) => void) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    play: () => {
      clock.playing = true
    },
    pause: () => {
      clock.playing = false
    },
    seek: (t: number) => {
      clock.currentTime = t
    },
  }
  return clock
}

function sheetLoopOf(view: SheetView): { start: number; end: number } | null {
  return (view as unknown as { loop: { start: number; end: number } | null }).loop
}

describe('PlayMode loop survival', () => {
  beforeEach(stubCanvas)
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('a 2s drag still shows its band after pointer release', () => {
    const store = createAppStore()
    const clock = makeClock()
    const synth = { seek: vi.fn() }
    const services = { store, clock, synth }
    const controller = new PlayWaitController({
      services: services as never,
      isTrackVisible: () => true,
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new SheetView(host, clock as never)
    try {
      view.resize(800, 300)
      view.canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 300, right: 800, bottom: 300, x: 0, y: 0 }) as DOMRect
      // Prod wiring, exactly as App creates it.
      view.onLoopChange = (region) => {
        controller.setLoop(region)
        view.setLoop(controller.loopRegion())
      }
      view.onLoopEditChange = (editing) => {
        if (editing) controller.beginLoopEdit()
        else controller.endLoopEdit()
      }
      view.onSeekRequest = (t) => {
        clock.seek(t)
      }
      renderWithApp(() => <PlayMode />, {
        services: services as never,
        waitController: controller as never,
        sheetView: view as never,
      })
      store.completePlayLoad(makeMidi())
      expect(controller.loopRegion()).toBeNull()

      // 300px at the 185px/s fallback slope ≈ 1.62s of loop.
      view.canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, clientY: 150 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 150 }))
      window.dispatchEvent(new MouseEvent('pointerup'))

      const committed = controller.loopRegion()
      expect(committed).not.toBeNull()
      expect(committed!.end - committed!.start).toBeGreaterThanOrEqual(WAIT_LOOP_MIN_SEC)
      // The band itself must mirror the commit — this is what vanished.
      expect(sheetLoopOf(view)).toEqual(committed)
    } finally {
      view.dispose()
    }
  })

  it('transpose keeps the loop (same piece, re-pitched)', () => {
    const store = createAppStore()
    const clock = makeClock()
    const synth = { seek: vi.fn() }
    const services = { store, clock, synth }
    const controller = new PlayWaitController({
      services: services as never,
      isTrackVisible: () => true,
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new SheetView(host, clock as never)
    try {
      view.resize(800, 300)
      view.canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 300, right: 800, bottom: 300, x: 0, y: 0 }) as DOMRect
      view.onLoopChange = (region) => {
        controller.setLoop(region)
        view.setLoop(controller.loopRegion())
      }
      view.onLoopEditChange = (editing) => {
        if (editing) controller.beginLoopEdit()
        else controller.endLoopEdit()
      }
      renderWithApp(() => <PlayMode />, {
        services: services as never,
        waitController: controller as never,
        sheetView: view as never,
      })
      store.completePlayLoad(makeMidi())
      controller.setLoop({ start: 2, end: 6 })
      view.setLoop(controller.loopRegion())

      store.setTranspose(2)

      expect(controller.loopRegion()).toEqual({ start: 2, end: 6 })
      expect(sheetLoopOf(view)).toEqual({ start: 2, end: 6 })
    } finally {
      view.dispose()
    }
  })
})
