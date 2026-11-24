// Stage split layout — falling notes (Pixi canvas) + scrolling sheet.
//
// Default: sheet bottom, falling notes top. The divider drag resizes; dragging
// the sheet grip (or the swap button) swaps top/bottom; X hides a pane and the
// other takes full. X hides when only one pane is on screen.

import { createSignal } from 'solid-js'
import { t } from '../i18n'
import type { PianoRollRenderer } from '../renderer/PianoRollRenderer'
import type { SheetView } from '../sheet/SheetView'
import { icons } from '../ui/icons'

export class StageLayout {
  private readonly _sheetVisible = createSignal(false)
  private readonly _rollVisible = createSignal(true)
  private sheetOnTop = false
  private fraction = 0.34
  // Must match `.sheet-head` height in main.css (inline `head.style.height`
  // below). The body + canvas get sheetH - HEAD, never a stale constant.
  private static readonly HEAD_H = 32
  // Px floors so the grand staff keeps a readable window on short viewports:
  // the fraction clamp (0.15–0.7) alone can shrink the body below one staff
  // system and the bottom staff clips under the pane edge.
  private static readonly MIN_SHEET_H = 148
  private static readonly MIN_ROLL_H = 80

  private sheetPane!: HTMLDivElement
  sheetBody!: HTMLDivElement
  private divider!: HTMLDivElement
  private sheetCloseBtn!: HTMLButtonElement
  private rollCloseBtn!: HTMLButtonElement
  private swapBtn!: HTMLButtonElement
  private showNotesBtn!: HTMLButtonElement

  private onChange: (() => void) | null = null

  constructor(
    private appRoot: HTMLElement,
    private canvas: HTMLCanvasElement,
    private renderer: PianoRollRenderer,
    public sheetView: SheetView | null,
  ) {
    this.buildDom()
    this.layout()
    window.addEventListener('resize', this.onResize)
  }

  sheetVisible = (): boolean => this._sheetVisible[0]()
  rollVisible = (): boolean => this._rollVisible[0]()

  onVisibilityChange(cb: () => void): void {
    this.onChange = cb
  }

  setSheetView(view: SheetView): void {
    // Wired after construction (SheetView needs its body element).
    this.sheetView = view
    this.layout()
  }

  showSheet(): void {
    if (this._sheetVisible[0]()) return
    this._sheetVisible[1](true)
    if (!this._rollVisible[0]()) this._rollVisible[1](true)
    this.layout()
    this.onChange?.()
  }

  hideSheet(): void {
    if (!this._sheetVisible[0]()) return
    this._sheetVisible[1](false)
    if (!this._rollVisible[0]()) this._rollVisible[1](true)
    this.layout()
    this.onChange?.()
  }

  toggleSheet(): void {
    if (this._sheetVisible[0]()) this.hideSheet()
    else this.showSheet()
  }

  hideRoll(): void {
    if (!this._sheetVisible[0]()) return // never strand a blank stage
    this._rollVisible[1](false)
    this.layout()
    this.onChange?.()
  }

  showRoll(): void {
    if (this._rollVisible[0]()) return
    this._rollVisible[1](true)
    this.layout()
    this.onChange?.()
  }

  swap(): void {
    this.sheetOnTop = !this.sheetOnTop
    this.layout()
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    this.sheetPane.remove()
    this.divider.remove()
    this.rollCloseBtn.remove()
  }

  // ── DOM ───────────────────────────────────────────────────────────────
  private buildDom(): void {
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.width = '100%'

    // Sheet pane.
    const pane = document.createElement('div')
    pane.id = 'sheet-pane'
    pane.style.position = 'absolute'
    pane.style.left = '0'
    pane.style.width = '100%'
    pane.style.display = 'flex'
    pane.style.flexDirection = 'column'
    pane.style.zIndex = '4'
    // Paint (background, accent top border, shadow) lives in CSS so the
    // paper theme can re-skin it; structure stays here.
    const head = document.createElement('div')
    head.className = 'sheet-head'
    head.style.display = 'flex'
    head.style.alignItems = 'center'
    head.style.gap = '8px'
    head.style.height = '32px'
    head.style.padding = '0 10px'
    head.style.flex = '0 0 auto'
    head.style.userSelect = 'none'
    // Grip doubles as the swap-drag handle.
    const grip = document.createElement('button')
    grip.className = 'sheet-grip'
    grip.type = 'button'
    grip.setAttribute('aria-label', t('wait.swapTip'))
    grip.setAttribute('data-tip', t('wait.swapTip'))
    grip.innerHTML = icons.grip(12)
    grip.style.cursor = 'grab'
    head.appendChild(grip)
    const title = document.createElement('span')
    title.className = 'sheet-title'
    title.textContent = t('wait.sheetTitle')
    head.appendChild(title)
    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    head.appendChild(spacer)
    this.showNotesBtn = document.createElement('button')
    this.showNotesBtn.className = 'sheet-show-notes'
    this.showNotesBtn.type = 'button'
    this.showNotesBtn.textContent = '♪+'
    this.showNotesBtn.title = 'Show falling notes'
    this.showNotesBtn.style.display = 'none'
    this.showNotesBtn.addEventListener('click', () => this.showRoll())
    head.appendChild(this.showNotesBtn)
    this.swapBtn = document.createElement('button')
    this.swapBtn.className = 'sheet-swap'
    this.swapBtn.type = 'button'
    this.swapBtn.setAttribute('aria-label', t('wait.swapTip'))
    this.swapBtn.setAttribute('data-tip', t('wait.swapTip'))
    this.swapBtn.innerHTML = '⇅'
    this.swapBtn.addEventListener('click', () => this.swap())
    head.appendChild(this.swapBtn)
    this.sheetCloseBtn = document.createElement('button')
    this.sheetCloseBtn.className = 'sheet-close'
    this.sheetCloseBtn.type = 'button'
    this.sheetCloseBtn.setAttribute('aria-label', t('wait.closePaneTip'))
    this.sheetCloseBtn.setAttribute('data-tip', t('wait.closePaneTip'))
    this.sheetCloseBtn.innerHTML = icons.smallClose(10)
    this.sheetCloseBtn.addEventListener('click', () => this.hideSheet())
    head.appendChild(this.sheetCloseBtn)
    pane.appendChild(head)
    this.sheetBody = document.createElement('div')
    this.sheetBody.id = 'sheet-body'
    this.sheetBody.style.position = 'relative'
    this.sheetBody.style.flex = '1'
    this.sheetBody.style.minHeight = '0'
    pane.appendChild(this.sheetBody)
    this.appRoot.appendChild(pane)
    this.sheetPane = pane

    // Divider.
    const div = document.createElement('div')
    div.id = 'stage-divider'
    div.style.position = 'absolute'
    div.style.left = '0'
    div.style.width = '100%'
    div.style.height = '12px'
    div.style.marginTop = '-6px'
    div.style.cursor = 'ns-resize'
    div.style.zIndex = '6'
    div.style.display = 'flex'
    div.style.alignItems = 'center'
    div.style.justifyContent = 'center'
    // Touch drag must move the split, never scroll the page; the rAF
    // throttle in onDividerDown keeps pixi rebuilds at 60Hz while dragging.
    div.style.touchAction = 'none'
    div.style.background = 'transparent'
    div.innerHTML = `<span class="stage-divider-handle"></span>`
    div.addEventListener('pointerdown', this.onDividerDown)
    this.appRoot.appendChild(div)
    this.divider = div

    // Roll close (floating over the canvas).
    const rc = document.createElement('button')
    rc.id = 'roll-close'
    rc.type = 'button'
    rc.setAttribute('aria-label', t('wait.closePaneTip'))
    rc.setAttribute('data-tip', t('wait.closePaneTip'))
    rc.innerHTML = icons.smallClose(10)
    rc.style.position = 'absolute'
    rc.style.zIndex = '6'
    rc.style.display = 'none'
    rc.addEventListener('click', () => this.hideRoll())
    this.appRoot.appendChild(rc)
    this.rollCloseBtn = rc

    // Swap-drag on the sheet grip.
    let startY = 0
    let dragging = false
    grip.addEventListener('pointerdown', (e) => {
      dragging = true
      startY = e.clientY
      grip.setPointerCapture?.(e.pointerId)
    })
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const dy = e.clientY - startY
      if (!this.sheetOnTop && dy < -90) {
        dragging = false
        this.swap()
      } else if (this.sheetOnTop && dy > 90) {
        dragging = false
        this.swap()
      }
    })
    grip.addEventListener('pointerup', () => {
      dragging = false
    })
  }

  private dividerDrag: { startY: number; startFrac: number } | null = null
  private layoutQueued = false
  private onDividerDown = (e: PointerEvent): void => {
    this.dividerDrag = { startY: e.clientY, startFrac: this.fraction }
    this.divider.setPointerCapture?.(e.pointerId)
    const stageH = this.stageH()
    const move = (ev: PointerEvent): void => {
      if (!this.dividerDrag) return
      let f = this.dividerDrag.startFrac
      const dy = ev.clientY - this.dividerDrag.startY
      // Sheet bottom: dragging up grows the sheet. Sheet top: dragging down grows it.
      f = this.sheetOnTop ? f + dy / stageH : f - dy / stageH
      this.fraction = Math.max(0.15, Math.min(0.7, f))
      // Coalesce layout + renderer/sheet resizes to one rAF per frame so a
      // fast drag can't queue a pixi rebuildStaticLayers per pointermove.
      if (!this.layoutQueued) {
        this.layoutQueued = true
        requestAnimationFrame(() => {
          this.layoutQueued = false
          this.layout()
        })
      }
    }
    const up = (): void => {
      this.dividerDrag = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // Flush any queued frame synchronously so the final position lands
      // even if the rAF hasn't fired yet.
      if (this.layoutQueued) {
        this.layoutQueued = false
        this.layout()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.preventDefault()
  }

  private onResize = (): void => {
    this.layout()
  }

  // Stage size comes from #app (100svh), never window.innerHeight: on mobile
  // innerHeight tracks the large viewport while svh excludes browser chrome,
  // so window math pushes the pane bottom under the chrome and the bottom
  // staff hides. clientWidth/Height are the pane's own coordinate space.
  private stageW(): number {
    return this.appRoot.clientWidth || window.innerWidth
  }

  private stageH(): number {
    return this.appRoot.clientHeight || window.innerHeight
  }

  private layout(): void {
    const vw = this.stageW()
    const vh = this.stageH()
    const HEAD = StageLayout.HEAD_H
    const sheetOn = this._sheetVisible[0]()
    const rollOn = this._rollVisible[0]()
    const root = document.documentElement

    if (!sheetOn && rollOn) {
      this.sheetPane.style.display = 'none'
      this.divider.style.display = 'none'
      this.rollCloseBtn.style.display = 'none'
      this.canvas.style.display = ''
      this.canvas.style.top = '0'
      this.canvas.style.height = `${vh}px`
      this.renderer.resize(vw, vh)
      root.style.setProperty('--sheet-bottom-h', '0px')
      root.style.setProperty('--sheet-top-h', '0px')
      return
    }
    if (sheetOn && !rollOn) {
      this.sheetPane.style.display = 'flex'
      this.sheetPane.style.top = '0'
      this.sheetPane.style.height = `${vh}px`
      this.divider.style.display = 'none'
      this.rollCloseBtn.style.display = 'none'
      this.sheetCloseBtn.style.display = 'none'
      this.showNotesBtn.style.display = ''
      this.canvas.style.display = 'none'
      // HEAD, not a stale -30: body + canvas == pane - header exactly, so no
      // 2px overflow spilling the bottom staff under the pane edge.
      this.sheetView?.resize(vw, Math.max(1, vh - HEAD))
      root.style.setProperty('--sheet-bottom-h', '0px')
      root.style.setProperty('--sheet-top-h', `${vh}px`)
      return
    }
    // Both on: fraction gives the split, px floors keep both panes usable on
    // short viewports (fraction alone can shrink the body under one staff).
    let sheetH = Math.round(vh * this.fraction)
    sheetH = Math.max(sheetH, StageLayout.MIN_SHEET_H)
    sheetH = Math.min(sheetH, vh - StageLayout.MIN_ROLL_H)
    // Degenerate viewport (shorter than both floors): keep at least the
    // header + a sliver of staff instead of inverting the split.
    if (sheetH < StageLayout.MIN_SHEET_H) sheetH = Math.max(HEAD + 32, vh - StageLayout.MIN_ROLL_H)
    const rollH = Math.max(1, vh - sheetH)
    const bodyH = Math.max(1, sheetH - HEAD)
    this.sheetPane.style.display = 'flex'
    this.divider.style.display = 'flex'
    this.rollCloseBtn.style.display = ''
    this.sheetCloseBtn.style.display = ''
    this.showNotesBtn.style.display = 'none'
    this.canvas.style.display = ''
    if (!this.sheetOnTop) {
      // Default: sheet bottom, falling notes top.
      this.canvas.style.top = '0'
      this.canvas.style.height = `${rollH}px`
      this.sheetPane.style.top = `${rollH}px`
      this.sheetPane.style.height = `${sheetH}px`
      this.divider.style.top = `${rollH}px`
      this.rollCloseBtn.style.top = '64px'
      this.rollCloseBtn.style.right = '12px'
      root.style.setProperty('--sheet-bottom-h', `${sheetH}px`)
      root.style.setProperty('--sheet-top-h', '0px')
      // Style first, resize after: pixi + sheet backing stores (see
      // resize() in both views) must match the laid-out CSS px, otherwise a
      // stale backing store stretches/squashes one frame behind the pane.
      this.renderer.resize(vw, rollH)
      this.sheetView?.resize(vw, bodyH)
    } else {
      this.sheetPane.style.top = '0'
      this.sheetPane.style.height = `${sheetH}px`
      this.canvas.style.top = `${sheetH}px`
      this.canvas.style.height = `${rollH}px`
      this.divider.style.top = `${sheetH}px`
      this.rollCloseBtn.style.top = `${sheetH + 8}px`
      this.rollCloseBtn.style.right = '12px'
      root.style.setProperty('--sheet-bottom-h', '0px')
      root.style.setProperty('--sheet-top-h', `${sheetH}px`)
      this.renderer.resize(vw, rollH)
      this.sheetView?.resize(vw, bodyH)
    }
  }
}
