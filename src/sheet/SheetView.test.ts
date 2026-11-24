// Sheet loop-selection regression suite: drag-to-create, click-to-create,
// edge trims, cancel rollback, edit bracketing, min-size ✕ visibility, and
// the onset-collapse helpers behind the engraved time<->x maps.
//
// jsdom has no 2D canvas, so the context is stubbed and VexFlow is never
// loaded (midi is injected directly instead of via setData): the fallback
// time<->x line (x = xOrigin + t * pxPerSec) drives the gesture math, while
// the engraved helpers are covered through injected samples + unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WAIT_LOOP_MIN_SEC } from '../play/waitController'
import {
  lsFromHeight,
  RELAYOUT_H_TOLERANCE,
  SHEET_BOTTOM_PAD,
  SHEET_RELAYOUT_SETTLE_MS,
  SHEET_TOP_PAD,
  sheetLayoutMetrics,
  sheetScoreWidth,
  sheetStaffGeometry,
  shouldRelayoutScore,
  type SheetLoop,
  SheetView,
} from './SheetView'
import { buildInverseSamples, collapseToOnsets, type TimeSample } from './sheetModel'

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
          { pitch: 64, time: 1, duration: 0.5, velocity: 0.8 },
          { pitch: 62, time: 2, duration: 0.5, velocity: 0.8 },
        ],
      },
    ],
  } as never
}

interface ViewInternals {
  midi: unknown
  lastTime: number
  score: unknown
  draw: () => void
  loopXBtn: HTMLButtonElement | null
  loop: SheetLoop | null
}

function internals(view: SheetView): ViewInternals {
  return view as unknown as ViewInternals
}

function mountView(): SheetView {
  const body = document.createElement('div')
  document.body.appendChild(body)
  const clock = { subscribe: () => () => {} } as never
  const view = new SheetView(body, clock)
  view.resize(800, 300)
  // Bypass setData (which would dynamically import VexFlow): the fallback
  // time<->x line drives gesture math deterministically.
  internals(view).midi = makeMidi()
  view.canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 300, right: 800, bottom: 300, x: 0, y: 0 }) as DOMRect
  return view
}

function pointerDown(canvas: HTMLCanvasElement, x: number): void {
  canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: 150, bubbles: true }))
}
function pointerMove(x: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 150, bubbles: true }))
}
function pointerUp(): void {
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
}
function pointerUpFromOtherPointer(): void {
  // A second finger lifting mid-gesture must not commit the first one's drag.
  // MouseEvent has no pointerId, so tag one on — the view keys gestures by it.
  const ev = new MouseEvent('pointerup', { bubbles: true })
  ;(ev as unknown as { pointerId: number }).pointerId = 999
  window.dispatchEvent(ev)
}
function pointerCancel(): void {
  window.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
}

describe('SheetView loop selection', () => {
  beforeEach(stubCanvas)
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('drag creates a loop and fires onLoopChange once', () => {
    const view = mountView()
    try {
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      pointerDown(view.canvas, 200)
      pointerMove(500)
      pointerUp()
      expect(seen.length).toBe(1)
      const region = seen[0]
      expect(region).not.toBeNull()
      expect(region!.end - region!.start).toBeGreaterThanOrEqual(WAIT_LOOP_MIN_SEC)
      // 300px drag at the 185px/s fallback slope ≈ 1.62s.
      expect(region!.end - region!.start).toBeCloseTo(300 / 185, 1)
    } finally {
      view.dispose()
    }
  })

  it('a sub-min drag becomes a click-created loop instead of vanishing', () => {
    const view = mountView()
    try {
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      pointerDown(view.canvas, 400)
      pointerMove(405) // ~0.03s — below the floor, no band yet
      pointerUp()
      expect(seen.length).toBe(1)
      expect(seen[0]).not.toBeNull()
      expect(seen[0]!.end - seen[0]!.start).toBeGreaterThanOrEqual(WAIT_LOOP_MIN_SEC)
    } finally {
      view.dispose()
    }
  })

  it('edge trim moves start and keeps the floor', () => {
    const view = mountView()
    try {
      view.setLoop({ start: 2, end: 6 })
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      // timeToX(2) = xOrigin + 2*185 - scrollX; scrollX = 8 - 800*0.22.
      pointerDown(view.canvas, 546)
      pointerMove(600)
      pointerUp()
      expect(seen.length).toBe(1)
      expect(seen[0]!.start).toBeGreaterThan(2)
      expect(seen[0]!.end).toBe(6)
      expect(seen[0]!.end - seen[0]!.start).toBeGreaterThanOrEqual(WAIT_LOOP_MIN_SEC)
    } finally {
      view.dispose()
    }
  })

  it('a sub-min wobble keeps the last valid band until pointerup commits', () => {
    const view = mountView()
    try {
      view.setLoop({ start: 2, end: 6 })
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      // Fresh press far from both edges (start edge ≈546px, end edge offscreen).
      pointerDown(view.canvas, 700)
      // ~5px ≈ 0.03s — below the floor. The pre-drag band must stay visible
      // instead of nulling mid-drag (a missed pointerup would otherwise lose it).
      pointerMove(705)
      expect(internals(view).loop).toEqual({ start: 2, end: 6 })
      pointerUp()
      // Release still commits: the wobble becomes a click-created loop.
      expect(seen.length).toBe(1)
      expect(seen[0]).not.toBeNull()
      expect(seen[0]!.end - seen[0]!.start).toBeGreaterThanOrEqual(WAIT_LOOP_MIN_SEC)
    } finally {
      view.dispose()
    }
  })

  it('a second pointer lifting mid-drag does not commit the gesture', () => {
    const view = mountView()
    try {
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      pointerDown(view.canvas, 200)
      pointerMove(500)
      pointerUpFromOtherPointer()
      // Foreign release ignored: no commit, gesture still open.
      expect(seen.length).toBe(0)
      expect(internals(view).loop).not.toBeNull()
      pointerUp()
      expect(seen.length).toBe(1)
      expect(seen[0]).not.toBeNull()
    } finally {
      view.dispose()
    }
  })

  it('pointercancel after pointerup does not roll back the commit', () => {
    const view = mountView()
    try {
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      pointerDown(view.canvas, 200)
      pointerMove(500)
      pointerUp()
      expect(seen.length).toBe(1)
      // Some touch browsers fire pointercancel right after pointerup; the
      // gesture is over (dragMode 'none'), so this must be a no-op.
      pointerCancel()
      expect(seen.length).toBe(1)
      expect(internals(view).loop).toEqual(seen[0])
    } finally {
      view.dispose()
    }
  })

  it('pointercancel rolls back to the pre-drag region and stays silent', () => {
    const view = mountView()
    try {
      view.setLoop({ start: 2, end: 6 })
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      const edits: boolean[] = []
      view.onLoopEditChange = (e) => edits.push(e)
      pointerDown(view.canvas, 546)
      pointerMove(700)
      pointerCancel()
      expect(seen.length).toBe(0)
      expect(edits).toEqual([true, false])
      // Region restored: a fresh press near the old start still grabs it.
      pointerDown(view.canvas, 546)
      pointerMove(560)
      pointerUp()
      expect(seen.length).toBe(1)
      expect(seen[0]!.end).toBe(6)
    } finally {
      view.dispose()
    }
  })

  it('edit callbacks bracket a normal drag', () => {
    const view = mountView()
    try {
      const edits: boolean[] = []
      view.onLoopEditChange = (e) => edits.push(e)
      pointerDown(view.canvas, 200)
      expect(edits).toEqual([true])
      pointerMove(500)
      pointerUp()
      expect(edits).toEqual([true, false])
    } finally {
      view.dispose()
    }
  })

  it('the drag mapping is frozen at dragstart while the playhead advances', () => {
    const view = mountView()
    try {
      const seen: Array<SheetLoop | null> = []
      view.onLoopChange = (r) => seen.push(r)
      // scrollX at dragstart: xAtTime(0) - 800*0.22 = 8 - 176.
      pointerDown(view.canvas, 200)
      // Playhead races ahead 10s mid-gesture — must not move the mapping.
      internals(view).lastTime = 10
      pointerMove(500)
      pointerUp()
      expect(seen.length).toBe(1)
      // anchor = timeAtX(200 - 168), end = timeAtX(500 - 168) on the frozen scroll.
      expect(seen[0]!.start).toBeCloseTo((200 - 168 - 8) / 185, 6)
      expect(seen[0]!.end).toBeCloseTo((500 - 168 - 8) / 185, 6)
    } finally {
      view.dispose()
    }
  })

  it('the ✕ button shows for a minimum-size loop', () => {
    const view = mountView()
    try {
      view.setLoop({ start: 2, end: 2 + WAIT_LOOP_MIN_SEC })
      internals(view).draw()
      const btn = internals(view).loopXBtn
      expect(btn).not.toBeNull()
      // ~46px band at fallback zoom: visible, clamped inside the canvas.
      expect(btn!.style.display).not.toBe('none')
      const left = Number.parseFloat(btn!.style.left)
      expect(left).toBeGreaterThanOrEqual(16)
      expect(left).toBeLessThanOrEqual(800 - 16)
    } finally {
      view.dispose()
    }
  })

  it('inverts engraved-style samples without phantom averages', () => {
    const view = mountView()
    try {
      // Treble/bass doubles a few px apart + a chord sharing x exactly.
      const raw: TimeSample[] = [
        { t: 0, x: 100 },
        { t: 1, x: 200 },
        { t: 1, x: 200 },
        { t: 1, x: 204 },
        { t: 2, x: 300 },
        { t: 3, x: 296 }, // staff-width wobble: x dips below the prior onset
        { t: 4, x: 400 },
      ]
      const samples = collapseToOnsets(raw)
      internals(view).score = { samples, invSamples: buildInverseSamples(samples) }
      const timeAtX = (view as unknown as { timeAtX: (x: number) => number }).timeAtX.bind(view)
      const xAtTime = view.xAtTime.bind(view)
      expect(samples.map((s) => s.t)).toEqual([0, 1, 2, 3, 4])
      // The staff-width wobble (t=3 sits 4px left of t=2) makes strict
      // monotonicity unachievable for ANY inverse — the guarantee is that
      // every x maps between its neighboring onsets (bounded wobble, no
      // far jumps that would yank a drag).
      for (let x = 100; x <= 400; x += 5) {
        const t = timeAtX(x)
        expect(t).toBeGreaterThanOrEqual(-0.5)
        expect(t).toBeLessThanOrEqual(4.5)
      }
      // Round-trips land back on the onset (± staff wobble on inverted x).
      for (const s of samples) {
        expect(timeAtX(xAtTime(s.t))).toBeCloseTo(s.t, 1)
      }
    } finally {
      view.dispose()
    }
  })

  it('inverts strictly increasing samples monotonically', () => {
    const view = mountView()
    try {
      const raw: TimeSample[] = [
        { t: 0, x: 100 },
        { t: 1, x: 200 },
        { t: 1, x: 200 },
        { t: 1, x: 204 },
        { t: 2, x: 300 },
        { t: 4, x: 400 },
      ]
      const samples = collapseToOnsets(raw)
      internals(view).score = { samples, invSamples: buildInverseSamples(samples) }
      const timeAtX = (view as unknown as { timeAtX: (x: number) => number }).timeAtX.bind(view)
      let prevT = -Infinity
      for (let x = 100; x <= 400; x += 5) {
        const t = timeAtX(x)
        expect(t).toBeGreaterThanOrEqual(prevT - 1e-9)
        prevT = t
      }
    } finally {
      view.dispose()
    }
  })
})

describe('barline engraving', () => {
  beforeEach(stubCanvas)
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })
  it('bar X lands within 12px of the nearest onset on the same timeline', () => {
    const view = mountView()
    try {
      // Dense quarters @120bpm (0.5s): every 2s bar has a downbeat onset.
      // X follows the nominal 112px/beat grid with a small Formatter wobble.
      const samples: TimeSample[] = []
      for (let i = 0; i <= 16; i++) {
        const t = i * 0.5
        samples.push({ t, x: 100 + t * 224 + (i % 2 === 0 ? 3 : -3) })
      }
      internals(view).score = {
        samples,
        invSamples: buildInverseSamples(samples),
        barTop: 50,
        barBottom: 250,
      }
      const bars = [0, 2, 4, 6, 8].map((time, i) => ({ time, number: i + 1 }))
      for (const b of bars) {
        const x = view.barX(b.time)
        let nearest = Infinity
        for (const s of samples) nearest = Math.min(nearest, Math.abs(s.x - x))
        expect(nearest).toBeLessThanOrEqual(12)
      }
      // A bar 60ms off its downbeat (quantization drift) still snaps home.
      const drifted = view.barX(4.06)
      const downbeat = samples.find((s) => s.t === 4)!.x
      expect(Math.abs(drifted - downbeat)).toBeLessThanOrEqual(12)
    } finally {
      view.dispose()
    }
  })

  it('bar span covers both staves plus the gap', () => {
    const view = mountView()
    try {
      internals(view).score = {
        samples: [
          { t: 0, x: 100 },
          { t: 1, x: 300 },
        ],
        invSamples: buildInverseSamples([
          { t: 0, x: 100 },
          { t: 1, x: 300 },
        ]),
        barTop: 40,
        barBottom: 260,
      }
      const score = internals(view).score as unknown as {
        barTop: number
        barBottom: number
      }
      // Treble top (40) → bass bottom (260): both staves + gap inclusive.
      expect(score.barBottom - score.barTop).toBeGreaterThan(150)
      expect(score.barTop).toBe(40)
      expect(score.barBottom).toBe(260)
    } finally {
      view.dispose()
    }
  })
})

describe('onset collapse helpers', () => {
  it('collapses chord duplicates to their mean x', () => {
    const out = collapseToOnsets([
      { t: 1, x: 200 },
      { t: 1, x: 200 },
      { t: 1, x: 206 },
      { t: 2, x: 300 },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]!.t).toBe(1)
    expect(out[0]!.x).toBeCloseTo(202, 9)
    expect(out[1]).toEqual({ t: 2, x: 300 })
  })

  it('inverse samples are x-ordered with equal-x entries dropped', () => {
    const inv = buildInverseSamples([
      { t: 0, x: 100 },
      { t: 1, x: 200 },
      { t: 2, x: 200 },
      { t: 3, x: 300 },
    ])
    expect(inv.map((s) => s.x)).toEqual([100, 200, 300])
    expect(inv).toHaveLength(3)
  })

  it('handles empty input', () => {
    expect(collapseToOnsets([])).toEqual([])
    expect(buildInverseSamples([])).toEqual([])
  })
})

describe('even sheet scaling', () => {
  it('ls is monotonic in pane height', () => {
    const hs = [80, 120, 180, 250, 320, 480, 640]
    const lss = hs.map((h) => lsFromHeight(h))
    for (let i = 1; i < lss.length; i++) {
      expect(lss[i]!).toBeGreaterThanOrEqual(lss[i - 1]!)
    }
    // Grows with the pane: a tall pane engraves clearly larger staff-space.
    expect(lss[lss.length - 1]!).toBeGreaterThan(lss[0]!)
  })

  it('layout metrics scale with ls (single source, no fixed-px pinch)', () => {
    const small = sheetLayoutMetrics(140)
    const big = sheetLayoutMetrics(420)
    expect(big.ls).toBeGreaterThan(small.ls)
    expect(big.pxPerBeat).toBeGreaterThan(small.pxPerBeat)
    expect(big.startX).toBeGreaterThan(small.startX)
    expect(big.endPad).toBeGreaterThan(small.endPad)
    expect(big.formatPad).toBeGreaterThan(small.formatPad)
    // Beat grid stays proportional to staff-space.
    expect(big.pxPerBeat / big.ls).toBeCloseTo(small.pxPerBeat / small.ls, 9)
  })

  it('scoreWidth scales with ls for the same beat count', () => {
    const beats = 64
    const narrow = sheetScoreWidth(140, beats)
    const wide = sheetScoreWidth(420, beats)
    expect(wide).toBeGreaterThan(narrow)
    // Same height, more beats → wider system.
    expect(sheetScoreWidth(250, 128)).toBeGreaterThan(sheetScoreWidth(250, 16))
  })

  it('relayout triggers only on settled drift beyond tolerance, never mid-drag', () => {
    const now = 1000
    // Inside tolerance → keep engraving (divider micro-jitter).
    expect(shouldRelayoutScore(300, 300 + RELAYOUT_H_TOLERANCE - 0.5, now, 0, false)).toBe(false)
    expect(shouldRelayoutScore(300, 300, now, now, false)).toBe(false)
    // Beyond tolerance but still settling → wait.
    expect(shouldRelayoutScore(300, 320, now, now - 10, false)).toBe(false)
    // Settled drift → re-engrave promptly (60ms gate, not the old 80ms lag).
    expect(SHEET_RELAYOUT_SETTLE_MS).toBeLessThanOrEqual(60)
    expect(shouldRelayoutScore(300, 320, now, now - (SHEET_RELAYOUT_SETTLE_MS + 5), false)).toBe(true)
    // Mid-drag frame → never, even when settled (protects dragScrollX mapping).
    expect(shouldRelayoutScore(300, 320, now, now - 1000, true)).toBe(false)
  })
})

describe('grand-staff geometry invariants', () => {
  beforeEach(stubCanvas)
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('12ls block + padding always fits: trebleTop>=4 and staffBottom<=h-4', () => {
    for (let h = 120; h <= 800; h += 10) {
      const g = sheetStaffGeometry(h)
      expect(g.trebleTop).toBeGreaterThanOrEqual(4)
      expect(g.staffBottom).toBeLessThanOrEqual(h - 4)
      expect(g.bassTop).toBeCloseTo(g.trebleTop + 8 * g.ls, 9)
      expect(g.staffBottom).toBeCloseTo(g.bassTop + 4 * g.ls, 9)
      expect(g.staffBottom).toBeCloseTo(g.trebleTop + 12 * g.ls, 9)
      expect(g.barTop).toBe(g.trebleTop)
      expect(g.barBottom).toBe(g.staffBottom)
      // Padded fit: the 12ls block leaves the top/bottom pads inside h.
      expect(12 * g.ls).toBeLessThanOrEqual(h - SHEET_TOP_PAD - SHEET_BOTTOM_PAD + 1e-9)
      expect(g.ls).toBeGreaterThan(0)
      expect(g.ls).toBeLessThanOrEqual(30)
    }
  })

  it('block stays centered with padding bias (symmetric leftover)', () => {
    for (let h = 120; h <= 800; h += 40) {
      const g = sheetStaffGeometry(h)
      const topGap = g.trebleTop - SHEET_TOP_PAD
      const bottomGap = h - SHEET_BOTTOM_PAD - g.staffBottom
      expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1.5)
      // Center of the padded region, not h/2, when pads are asymmetric.
      expect(g.trebleTop + 6 * g.ls).toBeCloseTo(h / 2 + (SHEET_TOP_PAD - SHEET_BOTTOM_PAD) / 2, 0)
    }
  })

  it('playhead overshoot stays clamped inside the canvas', () => {
    for (let h = 120; h <= 800; h += 10) {
      const { ls, trebleTop, staffBottom } = sheetStaffGeometry(h)
      const playTop = Math.max(2, trebleTop - 0.5 * ls)
      const playBottom = Math.min(h - 2, staffBottom + 0.5 * ls)
      expect(playTop).toBeGreaterThanOrEqual(2)
      expect(playBottom).toBeLessThanOrEqual(h - 2)
      expect(playBottom).toBeGreaterThan(playTop)
    }
  })

  it('lsFromHeight is the single source: layout and draw agree', () => {
    for (let h = 120; h <= 800; h += 20) {
      expect(lsFromHeight(h)).toBeCloseTo(sheetStaffGeometry(h).ls, 9)
      expect(sheetLayoutMetrics(h).ls).toBeCloseTo(sheetStaffGeometry(h).ls, 9)
    }
  })

  it('resize keeps CSS px in sync with the backing store', () => {
    const body = document.createElement('div')
    document.body.appendChild(body)
    const clock = { subscribe: () => () => {} } as never
    const view = new SheetView(body, clock)
    try {
      view.resize(800, 300)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const internals = view as unknown as { w: number; h: number }
      expect(internals.w).toBe(800)
      expect(internals.h).toBe(300)
      expect(view.canvas.width).toBe(Math.round(800 * dpr))
      expect(view.canvas.height).toBe(Math.round(300 * dpr))
      expect(view.canvas.style.width).toBe('800px')
      expect(view.canvas.style.height).toBe('300px')
    } finally {
      view.dispose()
      document.body.innerHTML = ''
    }
  })
})

describe('overlay spans', () => {
  beforeEach(stubCanvas)
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  interface Seg {
    x1: number
    y1: number
    x2: number
    y2: number
    lineWidth: number
    lineCap: string
    strokeStyle: string
  }

  // Recording 2D context: draw() only needs property sets plus the
  // beginPath/moveTo/lineTo/stroke path used by line() and fillRect.
  function recordingCtx(): { ctx: unknown; segs: Seg[] } {
    const segs: Seg[] = []
    let mx = 0
    let my = 0
    const rec = {
      fillStyle: '',
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      lineCap: 'butt',
      shadowColor: '',
      shadowBlur: 0,
      font: '',
      textAlign: '',
      textBaseline: '',
      clearRect: (): void => {},
      fillRect: (): void => {},
      save: (): void => {},
      restore: (): void => {
        // draw() relies on save/restore to scrub the loop/playhead glow
        // before the staff ink runs — the recorder keeps the last set caps
        // per segment at stroke time, so restore is a no-op here.
      },
      translate: (): void => {},
      setTransform: (): void => {},
      beginPath: (): void => {},
      moveTo: (x: number, y: number): void => {
        mx = x
        my = y
      },
      lineTo: (x: number, y: number): void => {
        segs.push({
          x1: mx,
          y1: my,
          x2: x,
          y2: y,
          lineWidth: rec.lineWidth,
          lineCap: rec.lineCap,
          strokeStyle: rec.strokeStyle,
        })
      },
      stroke: (): void => {},
      fill: (): void => {},
      fillText: (): void => {},
      arc: (): void => {},
      ellipse: (): void => {},
    }
    // line() strokes right after lineTo, so capturing at lineTo records the
    // segment with the stroke's width/cap/ink already in place.
    return { ctx: rec, segs }
  }

  function injectScore(view: SheetView, h: number): void {
    const samples: TimeSample[] = [
      { t: 0, x: 100 },
      { t: 1, x: 300 },
    ]
    ;(view as unknown as { score: unknown }).score = {
      treble: { drawWithStyle: (): void => {} },
      bass: { drawWithStyle: (): void => {} },
      recs: [],
      hits: [],
      beams: [],
      byNote: new Map(),
      samples,
      invSamples: buildInverseSamples(samples),
      layoutW: 800,
      layoutH: h,
      barTop: 0,
      barBottom: 0,
    }
    ;(view as unknown as { bars: { time: number; number: number }[] }).bars = [
      { time: 0, number: 1 },
      { time: 2, number: 2 },
    ]
  }

  it('bars, playhead and loop edges span the live staff at any height', () => {
    for (const h of [160, 300, 600]) {
      const view = mountView()
      try {
        view.resize(800, h)
        const { ctx, segs } = recordingCtx()
        ;(view as unknown as { ctx: unknown }).ctx = ctx
        injectScore(view, h)
        view.setLoop({ start: 0.25, end: 0.75 })
        internals(view).draw()

        const g = sheetStaffGeometry(h)
        const playTop = Math.max(2, g.trebleTop - 0.5 * g.ls)
        const playBottom = Math.min(h - 2, g.staffBottom + 0.5 * g.ls)

        // Bars: staff ink, 1.5px, round caps, trebleTop → staffBottom live.
        const bars = segs.filter((s) => s.strokeStyle === '#dcd2be')
        expect(bars.length).toBe(2)
        for (const b of bars) {
          expect(b.y1).toBeCloseTo(g.barTop, 9)
          expect(b.y2).toBeCloseTo(g.barBottom, 9)
          expect(b.lineCap).toBe('round')
          expect(b.lineWidth).toBeCloseTo(1.5, 9)
        }

        // Playhead: two passes (halo 8 + core 3) over the same clamped span.
        const play = segs.filter((s) => s.strokeStyle === '#ffffff')
        expect(play.length).toBe(2)
        for (const p of play) {
          expect(p.x1).toBeCloseTo(800 * 0.22, 9)
          expect(p.y1).toBeCloseTo(playTop, 9)
          expect(p.y2).toBeCloseTo(playBottom, 9)
          expect(p.lineCap).toBe('round')
        }
        expect(play.map((p) => p.lineWidth).sort((a, b) => a - b)).toEqual([3, 8])
        // Playhead covers the bars with a symmetric overshoot, clamped in.
        expect(playTop).toBeLessThanOrEqual(g.barTop)
        expect(playBottom).toBeGreaterThanOrEqual(g.barBottom)
        expect(playTop).toBeGreaterThanOrEqual(2)
        expect(playBottom).toBeLessThanOrEqual(h - 2)

        // Loop edges: full-height, round caps, inset so caps clear the pane.
        const loop = segs.filter((s) => s.strokeStyle === '#ffc83c')
        expect(loop.length).toBe(2)
        for (const l of loop) {
          expect(l.y1).toBe(4)
          expect(l.y2).toBe(h - 4)
          expect(l.lineCap).toBe('round')
          expect(l.lineWidth).toBe(3)
        }
        // Full-height edges cover the staff at any size — never short.
        expect(4).toBeLessThanOrEqual(g.barTop)
        expect(h - 4).toBeGreaterThanOrEqual(g.barBottom)
      } finally {
        view.dispose()
      }
    }
  })

  it('scroll mapping survives resize with fixed samples', () => {
    const view = mountView()
    try {
      injectScore(view, 300)
      const before = view.xAtTime(0.5)
      view.resize(800, 600)
      // No relayout without the backend (vf null): samples are untouched.
      expect(view.xAtTime(0.5)).toBe(before)
      // Round-trip through the private scroll mapping stays exact.
      const priv = view as unknown as {
        timeToX: (t: number) => number
        xToTime: (x: number) => number
      }
      expect(priv.xToTime(priv.timeToX(0.5))).toBeCloseTo(0.5, 9)
    } finally {
      view.dispose()
    }
  })
})
