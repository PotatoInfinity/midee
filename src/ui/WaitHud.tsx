// Minimal wait-mode HUD: score %, Wait/Flow toggle, speed chip, transport
// scrubber. Loop lives entirely on the sheet; hands are covered by track
// selection. Drag + pin come from FloatingHud.

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import type { AppServices } from '../core/services'
import { t } from '../i18n'
import type { PlayWaitController } from '../play/waitController'
import { formatSpeed, stepSpeedPreset } from './ControlsView'
import { FloatingHud } from './FloatingHud'
import { icons } from './icons'

const PLAY_GLYPH =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4 3 L13 8 L4 13 Z"/></svg>'
const PAUSE_GLYPH =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>'

function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function WaitHudView(props: {
  controller: PlayWaitController
  services: AppServices
  visible: () => boolean
}) {
  const c = props.controller
  let scrubberEl!: HTMLInputElement
  let wrapEl!: HTMLDivElement
  let timeEl!: HTMLSpanElement
  // Scrub state lives outside reactivity: the 60 Hz clock tick reads it
  // directly, and making it a signal would re-render on every gesture.
  let scrubbing = false
  let hudWake: (() => void) | null = null
  const [collapsed, setCollapsed] = createSignal(false)

  // Last painted values — the clock fires at ~60 Hz; writing textContent and
  // the --pct custom property every tick thrashes layout. Paint only on
  // whole-second changes (>= 0.1% fill deltas), mirroring Controls.tsx.
  let lastSec = -1
  let lastPct = -1

  function endScrub(): void {
    scrubbing = false
  }

  onMount(() => {
    // Subscribe once per mount (never in the component body / render path:
    // re-running subscribe on every reactive re-evaluation stacks duplicate
    // tick handlers that fight the main HUD scrubber and leak on Show
    // toggles). onCleanup tears it down exactly once.
    const tickUnsub = props.services.clock.subscribe((t) => {
      // Hidden (Show=false) leaves scrubberEl/timeEl pointing at detached
      // nodes — skip DOM writes, and skip while collapsed to a mini chip.
      if (!props.visible() || collapsed()) return
      if (scrubberEl?.isConnected && !scrubbing) {
        scrubberEl.value = String(t)
        const pct = (t / (Number(scrubberEl.max) || 1)) * 100
        const clamped = Math.max(0, Math.min(100, pct))
        if (Math.abs(clamped - lastPct) >= 0.1) {
          lastPct = clamped
          wrapEl?.style.setProperty('--pct', `${clamped.toFixed(1)}%`)
        }
      }
      if (timeEl?.isConnected) {
        const sec = Math.floor(t)
        if (sec !== lastSec) {
          lastSec = sec
          timeEl.textContent = fmtTime(t)
        }
      }
    })
    onCleanup(tickUnsub)

    // Pointer capture can be lost without pointerup (blur, alert, touch
    // cancel routed elsewhere) — a stuck `scrubbing=true` freezes the
    // playhead forever. Global listeners guarantee release.
    window.addEventListener('pointerup', endScrub)
    window.addEventListener('pointercancel', endScrub)
    window.addEventListener('blur', endScrub)
    onCleanup(() => {
      window.removeEventListener('pointerup', endScrub)
      window.removeEventListener('pointercancel', endScrub)
      window.removeEventListener('blur', endScrub)
    })
  })

  createEffect(() => {
    const d = props.services.store.state.duration
    if (scrubberEl) scrubberEl.max = String(d || 1)
  })

  const speed = (): number => props.services.store.state.speed ?? 1

  return (
    <Show when={props.visible()}>
      <FloatingHud
        class="wait-hud"
        anchor="top"
        storageKey="midee.wait"
        idleEnabled={() => c.userWantsToPlay()}
        collapsed={collapsed}
        onClose={() => setCollapsed(true)}
        onReopen={() => setCollapsed(false)}
        collapsedContent={
          <span
            class="wait-hud__mini"
            style={{
              display: 'inline-block',
              'min-width': '4ch',
              'text-align': 'center',
              'font-variant-numeric': 'tabular-nums',
              'line-height': '1.2',
              'letter-spacing': '0.01em',
            }}
          >
            {c.accuracy()}%
          </span>
        }
        wakeRef={(fn) => {
          hudWake = fn
        }}
      >
        <div class="wait-hud__body">
          <div class="wait-hud__row wait-hud__row--transport">
            <button
              class="wait-hud__play"
              id="wait-play"
              type="button"
              aria-label={c.userWantsToPlay() ? t('learn.pa.pauseAria') : t('learn.pa.playAria')}
              data-tip={t('learn.pa.playTip')}
              onClick={() => {
                c.togglePlay()
                hudWake?.()
              }}
            >
              {/* Glyph lives in a stable child span: swapping innerHTML on the
                  button itself replaces its children and can drop focus /
                  restart CSS state on every play-state flip. The button
                  element stays put; only the span's content swaps. */}
              <span
                class="wait-hud__play-glyph"
                aria-hidden="true"
                innerHTML={c.userWantsToPlay() ? PAUSE_GLYPH : PLAY_GLYPH}
              />
            </button>
            <div class="wait-hud__scrub">
              <span
                class="wait-hud__time"
                ref={timeEl}
                style={{
                  'font-variant-numeric': 'tabular-nums',
                  'line-height': '1.2',
                  'letter-spacing': '0.01em',
                }}
              >
                0:00
              </span>
              <div class="wait-hud__scrubber-wrap" ref={wrapEl}>
                <input
                  class="wait-hud__scrubber"
                  id="wait-scrubber"
                  ref={scrubberEl}
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value="0"
                  aria-label={t('learn.pa.scrubAria')}
                  onPointerDown={() => {
                    scrubbing = true
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget
                    const pct = (Number(el.value) / (Number(el.max) || 1)) * 100
                    lastPct = Math.max(0, Math.min(100, pct))
                    wrapEl?.style.setProperty('--pct', `${lastPct.toFixed(1)}%`)
                    lastSec = Math.floor(Number(el.value))
                    if (timeEl) timeEl.textContent = fmtTime(Number(el.value))
                    c.seek(Number(el.value))
                  }}
                  onPointerUp={endScrub}
                  onPointerCancel={endScrub}
                  onLostPointerCapture={endScrub}
                  onChange={endScrub}
                />
              </div>
              <span
                class="wait-hud__time wait-hud__time--muted"
                style={{
                  'font-variant-numeric': 'tabular-nums',
                  'line-height': '1.2',
                  'letter-spacing': '0.01em',
                }}
              >
                {fmtTime(props.services.store.state.duration)}
              </span>
            </div>
          </div>
          <div class="wait-hud__row wait-hud__row--options">
            <span
              class="wait-hud__score"
              role="status"
              aria-label={t('wait.score.aria')}
              data-tip={t('wait.score.tip')}
              style={{
                'font-variant-numeric': 'tabular-nums',
                'line-height': '1.2',
                'letter-spacing': '0.01em',
              }}
            >
              {c.accuracy()}%
            </span>
            <button
              class="wait-hud__pill"
              type="button"
              aria-pressed={c.strict() ? 'true' : 'false'}
              data-tip={c.strict() ? t('wait.waitTip') : t('wait.flowTip')}
              aria-label={c.strict() ? t('wait.waitTip') : t('wait.flowTip')}
              onClick={() => c.setStrict(!c.strict())}
            >
              <span aria-hidden="true" innerHTML={icons.waitClock(13)} />
              <span>{c.strict() ? t('wait.waitLabel') : t('wait.flowLabel')}</span>
            </button>
            <button
              class="wait-hud__speed"
              type="button"
              data-tip={t('hud.speed')}
              aria-label={t('hud.aria.speed')}
              style={{
                'font-variant-numeric': 'tabular-nums',
                'line-height': '1.2',
                'letter-spacing': '0.01em',
              }}
              onClick={(e) => {
                const next = stepSpeedPreset(speed(), e.shiftKey ? -1 : 1)
                props.services.store.setState('speed', next)
              }}
            >
              {formatSpeed(speed())}
            </button>
          </div>
        </div>
      </FloatingHud>
    </Show>
  )
}

export function mountWaitHud(
  container: HTMLElement,
  controller: PlayWaitController,
  services: AppServices,
  visible: () => boolean,
): () => void {
  const host = document.createElement('div')
  host.style.display = 'contents'
  container.appendChild(host)
  const dispose = render(
    () => <WaitHudView controller={controller} services={services} visible={visible} />,
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}
