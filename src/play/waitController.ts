// Play-mode wait controller — Synthesia-style "wait for the right notes"
// folded into Play (no separate Learn tab).
//
// Strict (wait) vs Flow (no-wait):
//   - strict: PracticeEngine halts the clock at each chord until the player
//     clears it. Wrong pitches bump errors + flash red on the sheet.
//   - flow:  clock never pauses for input. Presses are graded against notes
//     sounding near the playhead; wrong pitches flash red on the sheet and
//     playback continues uninterrupted (final full-speed flow-state revision).
//
// Loop lives here too so it works in *both* normal play and wait — the sheet
// is the loop editor (drag to create/trim), the HUD pill just toggles.

import { createSignal } from 'solid-js'
import type { BusNoteEvent } from '../core/input/InputBus'
import { MIDI_MAX, MIDI_MIN, type MidiFile } from '../core/midi/types'
import type { AppServices } from '../core/services'
import { classifyArticulation, classifyTiming } from '../learn/core/scoring'
import { type LoopRegion, wrapIfAtEnd } from '../learn/engines/LoopRegion'
import { PracticeEngine } from '../learn/engines/PracticeEngine'

export const WAIT_LOOP_MIN_SEC = 0.25
const DEFAULT_LOOP_SEC = 8
const MIN_LOOP_FRACTION = 0.08

export interface WaitControllerOptions {
  services: AppServices
  isTrackVisible: (trackId: string) => boolean
  onErrorFlash?: (pitch: number, time: number) => void
  onPendingChange?: (
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ) => void
}

export class PlayWaitController {
  readonly practice: PracticeEngine

  private readonly _enabled = createSignal(false)
  private readonly _strict = createSignal(true)
  private readonly _loop = createSignal<LoopRegion | null>(null)
  private readonly _perfect = createSignal(0)
  private readonly _good = createSignal(0)
  private readonly _errors = createSignal(0)
  private readonly _streak = createSignal(0)
  private readonly _userWantsToPlay = createSignal(false)
  private readonly _isWaiting = createSignal(false)

  private midi: MidiFile | null = null
  private unsubs: Array<() => void> = []
  private editingLoop = false
  constructor(private opts: WaitControllerOptions) {
    const { services } = opts
    this.practice = new PracticeEngine(services.clock, {
      onWaitStart: () => {
        services.clock.pause()
        opts.services.store.setState('status', 'paused')
        this._isWaiting[1](true)
      },
      onWaitEnd: (resumeAt: number) => {
        services.clock.seek(resumeAt)
        services.synth.seek(resumeAt)
        this._isWaiting[1](false)
        if (this._userWantsToPlay[0]()) {
          opts.services.store.setState('status', 'playing')
          services.clock.play()
        }
      },
    })
    // Keep renderer keyboard hints in sync with the waited chord.
    this.unsubs.push(
      this.practice.status.subscribe((s) => {
        if (!s.waiting) this.opts.onPendingChange?.(null, null)
        else this.opts.onPendingChange?.(s.pending, s.accepted)
      }),
    )
  }

  // ── Reactive reads (for Solid HUD / TopStrip) ──────────────────────────
  enabled = (): boolean => this._enabled[0]()
  strict = (): boolean => this._strict[0]()
  loopRegion = (): LoopRegion | null => this._loop[0]()
  perfect = (): number => this._perfect[0]()
  good = (): number => this._good[0]()
  errors = (): number => this._errors[0]()
  streak = (): number => this._streak[0]()
  userWantsToPlay = (): boolean => this._userWantsToPlay[0]()
  isWaiting = (): boolean => this._isWaiting[0]()
  accuracy = (): number => {
    const hits = this._perfect[0]() + this._good[0]()
    const attempts = hits + this._errors[0]()
    return attempts === 0 ? 100 : Math.round((100 * hits) / attempts)
  }

  get enabledSignal(): () => boolean {
    return this._enabled[0]
  }
  get strictSignal(): () => boolean {
    return this._strict[0]
  }
  get loopSignal(): () => LoopRegion | null {
    return this._loop[0]
  }

  attach(midi: MidiFile | null): void {
    this.midi = midi
    this.practice.loadMidi(midi)
    this.syncTracks()
    this._perfect[1](0)
    this._good[1](0)
    this._errors[1](0)
    this._streak[1](0)
    this._loop[1](null)
    this._isWaiting[1](false)
    // Fresh file = fresh session: never inherit play intent (or restart()
    // would autoplay a piece the user hasn't asked to hear yet).
    this._userWantsToPlay[1](false)
    this.opts.onPendingChange?.(null, null)
    if (this._enabled[0]()) {
      this.practice.setEnabled(this._strict[0]())
      this.practice.notifySeek(this.opts.services.clock.currentTime)
    } else {
      this.practice.setEnabled(false)
    }
  }

  detach(): void {
    this._userWantsToPlay[1](false)
    this.practice.setEnabled(false)
    this._isWaiting[1](false)
  }

  setEnabled(on: boolean): void {
    if (this._enabled[0]() === on) return
    this._enabled[1](on)
    if (!this.midi) return
    if (on) {
      this.practice.notifySeek(this.opts.services.clock.currentTime)
      this.practice.setEnabled(this._strict[0]())
      // Entering wait keeps the transport as-is; the HUD play button resumes.
    } else {
      this.practice.setEnabled(false)
      this._isWaiting[1](false)
      this.opts.onPendingChange?.(null, null)
    }
  }

  setStrict(strict: boolean): void {
    if (this._strict[0]() === strict) return
    this._strict[1](strict)
    if (!this._enabled[0]() || !this.midi) return
    // Toggling strictness mid-wait releases the hold silently; the clock
    // stays where it is and the user resumes via play when ready.
    this.practice.setEnabled(strict)
    this._isWaiting[1](false)
    if (!strict) this.opts.onPendingChange?.(null, null)
    else this.practice.notifySeek(this.opts.services.clock.currentTime)
  }

  syncTracks(): void {
    if (!this.midi) return
    const visible = this.midi.tracks.filter((t) => this.opts.isTrackVisible(t.id)).map((t) => t.id)
    // PracticeEngine treats `null` as "all tracks".
    const allVisible = this.midi.tracks.every((t) => t.isDrum || this.opts.isTrackVisible(t.id))
    this.practice.setVisibleTracks(allVisible ? null : visible)
  }

  // ── Transport (used by the wait HUD when enabled) ──────────────────────
  play(): void {
    if (!this.midi) return
    this._userWantsToPlay[1](true)
    const { services } = this.opts
    this.practice.notifySeek(services.clock.currentTime)
    // notifySeek releases a hold silently — drop the HUD hint with it so the
    // "play these notes" cue can't stick while the transport runs.
    this._isWaiting[1](false)
    this.opts.onPendingChange?.(null, null)
    services.store.setState('status', 'playing')
    services.clock.play()
  }

  pause(): void {
    this._userWantsToPlay[1](false)
    const { services } = this.opts
    services.clock.pause()
    services.store.setState('status', 'paused')
    this._isWaiting[1](false)
    this.opts.onPendingChange?.(null, null)
  }

  togglePlay(): void {
    if (this._userWantsToPlay[0]()) this.pause()
    else this.play()
  }

  restart(): void {
    this.seek(this._loop[0]()?.start ?? 0)
    if (!this._userWantsToPlay[0]()) this.play()
  }

  seek(time: number): void {
    const dur = this.midi?.duration ?? 0
    const clamped = Math.max(0, Math.min(dur || time, time))
    const { services } = this.opts
    const wasIntent = this._userWantsToPlay[0]()
    // A plain-playing transport (wait off) has no intent flag — capture the
    // clock state before pausing so loop edits and toggleLoop don't stall a
    // running piece. In wait mode clock.playing implies intent, so behavior
    // there is unchanged.
    const wasPlaying = services.clock.playing
    services.clock.pause()
    services.store.setState('status', 'paused')
    // Recompute wait steps against the TARGET first: the clock.seek below
    // emits synchronously, and a stale nextStepIdx would spuriously re-engage
    // a wait (pause/status flicker) before we get to notifySeek.
    this.practice.notifySeek(clamped)
    services.clock.seek(clamped)
    services.synth.seek(clamped)
    this._isWaiting[1](false)
    if (wasIntent || wasPlaying) {
      services.store.setState('status', 'playing')
      services.clock.play()
    }
  }

  // ── Loop (works in normal play too) ────────────────────────────────────
  toggleLoop(playhead: number): LoopRegion | null {
    const cur = this._loop[0]()
    if (cur) {
      this.clearLoop()
      return null
    }
    const dur = this.midi?.duration ?? 0
    if (dur <= 0) return null
    const span = Math.min(Math.max(DEFAULT_LOOP_SEC, dur * MIN_LOOP_FRACTION), dur)
    const start = Math.max(0, Math.min(Math.max(0, playhead), dur - span))
    const region: LoopRegion = { start, end: Math.min(dur, start + span) }
    this._loop[1](region)
    this.seek(region.start)
    return region
  }

  clearLoop(): void {
    this._loop[1](null)
  }

  setLoop(region: LoopRegion | null): void {
    if (!region) {
      this._loop[1](null)
      return
    }
    const dur = this.midi?.duration ?? 0
    const s = Math.max(0, Math.min(region.start, dur))
    const e = Math.max(0, Math.min(region.end, dur))
    if (e - s < WAIT_LOOP_MIN_SEC) return
    this._loop[1]({ start: s, end: e })
  }

  setLoopEdge(edge: 'start' | 'end', time: number): LoopRegion | null {
    const region = this._loop[0]()
    if (!region) return null
    const dur = this.midi?.duration ?? 0
    const t = Math.max(0, Math.min(dur, time))
    const next: LoopRegion =
      edge === 'start'
        ? { start: Math.min(t, region.end - WAIT_LOOP_MIN_SEC), end: region.end }
        : { start: region.start, end: Math.max(t, region.start + WAIT_LOOP_MIN_SEC) }
    this._loop[1]({ start: Math.max(0, next.start), end: Math.min(dur, next.end) })
    return this._loop[0]()
  }

  beginLoopEdit(): void {
    this.editingLoop = true
  }
  endLoopEdit(): void {
    this.editingLoop = false
    const region = this._loop[0]()
    if (!region) return
    const t = this.opts.services.clock.currentTime
    if (t < region.start || t >= region.end) this.seek(region.start)
  }

  onTick(time: number): void {
    const region = this._loop[0]()
    if (!region || this.editingLoop) {
      // No loop set: wrap the whole piece and keep playing.
      const dur = this.midi?.duration ?? 0
      if (!region && dur > 0 && time >= dur && this._userWantsToPlay[0]()) {
        this.seek(0)
      }
      return
    }
    // Only wrap while the transport is running (or holding for wait) — a
    // paused scrub must be able to park the playhead at the loop end.
    if (!this.opts.services.clock.playing && !this._userWantsToPlay[0]()) return
    const wrapTo = wrapIfAtEnd(time, region)
    if (wrapTo !== null) {
      const { services } = this.opts
      services.clock.seek(wrapTo)
      services.synth.seek(wrapTo)
      this.practice.notifySeek(wrapTo)
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────
  onNoteOn(evt: BusNoteEvent): 'advanced' | 'rejected' | 'none' {
    if (!this._enabled[0]() || !this.midi) return 'none'
    // Off the 88 keys the engine never waits on — ignore, don't penalize.
    if (evt.pitch < MIDI_MIN || evt.pitch > MIDI_MAX) return 'none'
    // Noodling while paused (no intent to play) isn't practice — ignore it
    // instead of racking errors. Strict holds keep intent=true, so they
    // still score.
    if (!this.opts.services.clock.playing && !this._userWantsToPlay[0]()) return 'none'
    if (this._strict[0]()) {
      const outcome = this.practice.notePressed(evt.pitch)
      if (outcome.kind === 'advanced') {
        const verdict = classifyArticulation(outcome.articulationMs)
        if (verdict === 'perfect') this._perfect[1](this._perfect[0]() + 1)
        else this._good[1](this._good[0]() + 1)
        this._streak[1](this._streak[0]() + 1)
        return 'advanced'
      }
      if (outcome.kind === 'rejected' && this.practice.isWaiting) {
        this._errors[1](this._errors[0]() + 1)
        this._streak[1](0)
        this.opts.onErrorFlash?.(evt.pitch, this.opts.services.clock.currentTime)
        return 'rejected'
      }
      return 'none'
    }
    // Flow: grade against notes sounding near the playhead, never pause.
    // Prefer the event's own clock time over a re-read so input latency
    // doesn't bias the ±50 ms perfect window.
    const t =
      typeof evt.clockTime === 'number' && evt.clockTime >= 0
        ? evt.clockTime
        : this.opts.services.clock.currentTime
    const hit = this.flowHit(evt.pitch, t)
    if (hit === 'perfect') {
      this._perfect[1](this._perfect[0]() + 1)
      this._streak[1](this._streak[0]() + 1)
      return 'advanced'
    }
    if (hit === 'good') {
      this._good[1](this._good[0]() + 1)
      this._streak[1](this._streak[0]() + 1)
      return 'advanced'
    }
    this._errors[1](this._errors[0]() + 1)
    this._streak[1](0)
    this.opts.onErrorFlash?.(evt.pitch, t)
    return 'rejected'
  }

  onNoteOff(_evt: BusNoteEvent): void {
    // No held-bonus in the minimal wait HUD — scores are hits/errors only.
  }

  private flowHit(pitch: number, time: number): 'perfect' | 'good' | 'miss' {
    if (!this.midi) return 'miss'
    let best: 'perfect' | 'good' | 'miss' = 'miss'
    for (const track of this.midi.tracks) {
      if (track.isDrum) continue
      if (!this.opts.isTrackVisible(track.id)) continue
      for (const n of track.notes) {
        if (n.pitch !== pitch) continue
        // Only consider notes near the playhead.
        if (n.time > time + 0.35 || n.time + n.duration < time - 0.35) continue
        const v = classifyTiming(time, n.time)
        if (v === 'perfect') return 'perfect'
        if (v === 'good' || v === 'early' || v === 'late') best = 'good'
      }
    }
    return best
  }

  dispose(): void {
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.practice.dispose()
  }
}
