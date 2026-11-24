import { getContext, getTransport, immediate, Part, start as toneStart } from 'tone'
import { audibleDuration, type MidiFile } from '../core/midi/types'
import { createEventSignal } from '../store/eventSignal'
import type { AudioEngine } from './AudioEngine'
import {
  createInstrument,
  type InstrumentId,
  type InstrumentRuntime,
  midiToNoteName,
} from './instruments'
import { isMusicDucked, setMasterVolume, setMusicDucked } from './masterBus'

export type { InstrumentId, InstrumentInfo } from './instruments'
export { INSTRUMENTS } from './instruments'

interface NoteEvent {
  note: string
  // Audible (pedal-extended) length at 1× speed. Divided by the CURRENT speed
  // at trigger time — the transport-bpm trick scales event spacing only, and
  // setSpeed can land mid-playback without rebuilding the Part.
  duration: number
  velocity: number
  trackId: string
}

export class SynthEngine implements AudioEngine {
  private instruments = new Map<InstrumentId, InstrumentRuntime>()
  private loadingPromises = new Map<InstrumentId, Promise<InstrumentRuntime>>()
  // Default voice is Upright (1.2 MB of our own samples) instead of the 30 MB
  // Salamander Grand set that @tonejs/piano pulls from an external CDN —
  // 25× lighter first-load, bulletproof against upstream CDN outages, still
  // musically pleasing. Users who specifically want the concert grand are
  // one tap away in the instrument dropdown.
  private currentId: InstrumentId = 'upright'
  // Emits the currently-active instrument id while its samples/patch are
  // loading, null otherwise. Only tracks the *current* instrument — background
  // preloads of other voices don't flicker the signal.
  readonly loadingInstrument = createEventSignal<InstrumentId | null>(null)
  private midi: MidiFile | null = null
  // Tone.Part holding every note as a single transport entry. Replaces N×2
  // transport.schedule calls on play/seek — O(N) work to build, but building a
  // Part is ~10× faster than N individual schedules on dense MIDIs (tested
  // 10k+ notes), and seek reuses the same Part via `part.start(0, offset)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scheduledPart: any | null = null
  private _speed = 1
  private scheduledFromTime = 0
  // Pause-time snapshot of the transport cursor + the speed in effect then.
  // Captured in pause() BEFORE transport.pause() freezes the clock, so both
  // resume checks in play() share one predicate that stays valid when
  // setSpeed lands mid-pause (re-scaling the OLD cursor at the NEW speed
  // would point at the wrong musical moment). Cleared on stop()/rebuild.
  private pausedTransportSeconds: number | null = null
  private pausedSpeed = 1
  private readyPromise: Promise<void> = Promise.resolve()
  private readyResolved = true
  private liveWarmupStarted = false
  // Latest-wins guard for `play()`. `play()` is async (awaits readyPromise +
  // Tone.start) and can be racing against a subsequent `pause()`. Without
  // this, calling pause during the async window lets the next transport.start
  // at the tail of play() fire after we thought we paused — audio leaks.
  // Each play() call increments; if a newer call or a pause() ran, the older
  // play() bails before hitting transport.start.
  private playGeneration = 0
  // Tracks the user has muted via the Tracks panel. Checked at trigger time
  // inside the scheduled Part — new notes from a disabled track are skipped,
  // notes already in flight finish their natural decay (we don't track per-track
  // voice handles, and stealing them mid-note would click).
  private disabledTrackIds = new Set<string>()

  async load(source: MidiFile | AudioBuffer): Promise<void> {
    if (!(source instanceof AudioBuffer)) {
      this.midi = source as MidiFile
    }
    // A new file's tracks are unrelated to whatever the user muted previously.
    this.disabledTrackIds.clear()
    this.readyResolved = false
    this.readyPromise = this.ensureInstrument(this.currentId).then(() => {
      this.readyResolved = true
    })
    return this.readyPromise
  }

  setTrackEnabled(trackId: string, enabled: boolean): void {
    if (enabled) this.disabledTrackIds.delete(trackId)
    else this.disabledTrackIds.add(trackId)
  }

  getDisabledTrackIds(): ReadonlySet<string> {
    return this.disabledTrackIds
  }

  // Kick off piano sample download in the background — safe to call at app
  // boot. AudioContext still requires a user gesture before `play()`.
  preloadDefault(): void {
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  // Switch the active instrument for both scheduled and live playback.
  // Loading is lazy; selecting an unloaded instrument kicks off its init.
  async setInstrument(id: InstrumentId): Promise<void> {
    if (id === this.currentId) return
    // Release anything currently sounding on the old instrument
    this.instruments.get(this.currentId)?.releaseAll()
    this.currentId = id
    this.readyResolved = false
    await this.ensureInstrument(id)
    this.readyResolved = true
  }

  get instrument(): InstrumentId {
    return this.currentId
  }

  private ensureInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
    const cached = this.instruments.get(id)
    if (cached) return Promise.resolve(cached)
    const existing = this.loadingPromises.get(id)
    if (existing) return existing

    // Reflect loading in the signal only when we're loading the *current*
    // instrument — preloads of others happen silently in the background.
    if (id === this.currentId) this.loadingInstrument.set(id)

    const clearIfCurrent = (): void => {
      if (this.loadingInstrument.value === id) this.loadingInstrument.set(null)
    }
    const promise = createInstrument(id).then(
      (inst) => {
        this.instruments.set(id, inst)
        this.loadingPromises.delete(id)
        clearIfCurrent()
        return inst
      },
      (err) => {
        this.loadingPromises.delete(id)
        clearIfCurrent()
        throw err
      },
    )
    this.loadingPromises.set(id, promise)
    return promise
  }

  async play(fromTime: number): Promise<void> {
    if (!this.midi) return
    const gen = ++this.playGeneration
    const transport = getTransport()

    // Any fresh start restores full level first — a hushed bus must never
    // swallow the downbeat.
    this.unduck()

    // Fast resume: the transport is paused at (nearly) the requested spot
    // (wait-mode releases, pause→play without seeking). Restarting in place
    // skips the full Part rebuild + async gap, which read as late,
    // stuttering audio on every chord. Uses the pause()-time snapshot, not a
    // live transport.seconds read, so a mid-pause setSpeed can't move the
    // resume point.
    if (this.tryResume(fromTime)) return

    // Fast path: instrument ready and the context running means the awaits
    // below resolve to no-ops — skipping them starts the transport in the
    // same task as the caller's clock.play(), so visuals and audio share
    // the same start instant instead of drifting apart by the await gap.
    if (!this.readyResolved || !this.contextRunning()) {
      await this.readyPromise
      await toneStart()
      // A pause() or a newer play() happened during the awaits — abandon this
      // invocation so we don't resurrect transport audio against user intent.
      if (gen !== this.playGeneration) return
    }

    // Post-await resume: the SAME single predicate as the fast path. The
    // pre-await check misses when play() was already parked at `await
    // toneStart()` before the pause landed; re-checking here (after the
    // generation guard) resumes in place all the same instead of rebuilding.
    if (this.tryResume(fromTime)) return

    this.clearScheduled()
    transport.stop()
    // A rebuild invalidates the pause snapshot — the new Part starts at
    // fromTime, and a stale snapshot would resume into the old position.
    this.pausedTransportSeconds = null
    transport.position = 0
    this.scheduledFromTime = fromTime

    // Tone converts seconds→ticks using the *current* bpm at schedule time.
    // We schedule at the nominal tempo so every event's tick position encodes
    // the note's original musical moment, then reapply the speed-scaled bpm
    // right before start(). The transport then ticks `speed ×` faster and
    // events fire at `t / speed` wall time — matching MasterClock.currentTime,
    // which advances at `speed × wall`. If we schedule while bpm is already
    // `midi.bpm × speed`, the two scalings cancel and audio plays at 1× while
    // the visual clock is at `speed ×` → desync on fresh play / seek.
    const nominalBpm = this.midi.bpm
    transport.bpm.value = nominalBpm

    // Build (or rebuild) a single Tone.Part containing every note from fromTime
    // onward. One transport entry instead of 2×N — on a 10k-note MIDI, seek
    // goes from "visible stall" to "imperceptible".
    //
    // Notes are time-sorted (parser invariant) so binary-search skips past
    // events before fromTime without scanning them.
    const partEvents: [number, NoteEvent][] = []
    for (const track of this.midi.tracks) {
      const notes = track.notes
      let lo = 0
      let hi = notes.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (notes[mid]!.time < fromTime) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < notes.length; i++) {
        const note = notes[i]!
        partEvents.push([
          note.time - fromTime,
          {
            note: midiToNoteName(note.pitch),
            duration: audibleDuration(note),
            velocity: note.velocity,
            trackId: track.id,
          },
        ])
      }
    }

    // Tone's Part type wants events with a `time` field, but the runtime also
    // accepts `[time, payload]` tuples — cheaper for our 2-key payload. Cast
    // at the boundary; the named import still tree-shakes unused synths.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const part = new (Part as any)((time: number, ev: NoteEvent) => {
      // Re-resolve the instrument each tick so mid-playback switches take
      // effect without rebuilding the Part. setInstrument() releases the old
      // voice so overlapping notes from the previous instrument don't linger.
      if (this.disabledTrackIds.has(ev.trackId)) return
      const inst = this.instruments.get(this.currentId)
      const speed = this._speed > 0 ? this._speed : 1
      inst?.triggerAttackRelease(ev.note, ev.duration / speed, time, ev.velocity)
    }, partEvents)
    part.start(0)
    this.scheduledPart = part

    transport.bpm.value = nominalBpm * this._speed
    transport.start()
  }

  pause(): void {
    // Bump the generation so any in-flight `play()` aborts before it can
    // reach `transport.start()` and resurrect audio after the pause.
    this.playGeneration++
    const transport = getTransport()
    // Snapshot the cursor + speed BEFORE pausing: after transport.pause() the
    // seconds readout is frozen, and a later setSpeed must not rescale this
    // (musical) position. tryResume() consumes the snapshot.
    this.pausedTransportSeconds = transport.seconds
    this.pausedSpeed = this._speed > 0 ? this._speed : 1
    transport.pause()
    this.releaseAllInstruments()
  }

  // Hush the music bus (~50 ms fade) so release envelopes and reverb tails
  // can't ring on after an explicit stop. Only for deliberate user stops and
  // surface resets — wait-mode holds never hush, so the player's own presses
  // stay audible while hunting the chord. `play()` / `seek()` / live input
  // restore full level via `unduck()`.
  hush(): void {
    setMusicDucked(true)
  }

  unduck(): void {
    if (isMusicDucked()) setMusicDucked(false)
  }

  private contextRunning(): boolean {
    try {
      const raw = getContext().rawContext as AudioContext | undefined
      return !!raw && raw.state === 'running'
    } catch {
      return false
    }
  }

  seek(time: number): void {
    const wasPlaying = getTransport().state === 'started'
    // Same latest-wins guard — a concurrent play() racing with a seek would
    // otherwise restart transport at a stale fromTime.
    this.playGeneration++
    getTransport().stop()
    this.clearScheduled()
    // Seeking parks the transport at a new spot — a pause snapshot (if any)
    // belongs to the old one.
    this.pausedTransportSeconds = null
    this.releaseAllInstruments()
    if (wasPlaying) void this.play(time)
  }

  setVolume(v: number): void {
    setMasterVolume(v)
  }

  setSpeed(s: number): void {
    this._speed = s
    getTransport().bpm.value = (this.midi?.bpm ?? 120) * s
  }

  // ── Live MIDI keyboard input ───────────────────────────────────────────

  primeLiveInput(): void {
    if (this.liveWarmupStarted) return
    this.liveWarmupStarted = true
    void toneStart().catch(() => undefined)
    void this.ensureInstrument(this.currentId).catch(() => undefined)
  }

  liveNoteOn(pitch: number, velocity: number): void {
    this.primeLiveInput()
    // A fresh attack always restores full level — noodling while paused
    // (after an explicit hush) must be heard.
    this.unduck()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return // still loading — first notes may drop, acceptable tradeoff
    inst.triggerAttack(midiToNoteName(pitch), immediate(), velocity)
  }

  liveNoteOff(pitch: number): void {
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), immediate())
  }

  liveReleaseAll(): void {
    this.releaseAllInstruments()
  }

  // Scheduled variants for loop playback. Caller supplies an AudioContext time
  // so notes land sample-accurately even if the UI thread stalls.
  scheduleNoteOn(pitch: number, velocity: number, ctxTime: number): void {
    this.primeLiveInput()
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerAttack(midiToNoteName(pitch), ctxTime, velocity)
  }

  scheduleNoteOff(pitch: number, ctxTime: number): void {
    const inst = this.instruments.get(this.currentId)
    if (!inst) return
    inst.triggerRelease(midiToNoteName(pitch), ctxTime)
  }

  // Exposed so non-audio modules (UI, visuals) can convert AudioContext time
  // into a setTimeout delay without pulling Tone into their imports.
  get audioContextTime(): number {
    return getContext().currentTime
  }

  // ── Scheduled playback (internal) ──────────────────────────────────────

  // Musical position frozen at pause(): the Part was scheduled from
  // scheduledFromTime and the transport had advanced pausedTransportSeconds
  // of transport time at pausedSpeed. Null when there is nothing resumable
  // (never paused, or stop()/rebuild/resume cleared the snapshot).
  private pausedPosition(): number | null {
    if (!this.scheduledPart || this.pausedTransportSeconds === null) return null
    return this.scheduledFromTime + this.pausedTransportSeconds * this.pausedSpeed
  }

  // Single resume predicate shared by BOTH resume paths in play(). Restarts
  // the paused transport in place when fromTime lands within 80 ms of the
  // pause-time position — no Part rebuild, no async gap.
  private tryResume(fromTime: number): boolean {
    const transport = getTransport()
    if (transport.state !== 'paused') return false
    const pos = this.pausedPosition()
    if (pos === null || Math.abs(fromTime - pos) >= 0.08) return false
    transport.start()
    this.pausedTransportSeconds = null
    return true
  }

  private clearScheduled(): void {
    if (this.scheduledPart) {
      this.scheduledPart.stop(0)
      this.scheduledPart.clear()
      this.scheduledPart.dispose()
      this.scheduledPart = null
    }
  }

  private releaseAllInstruments(): void {
    for (const inst of this.instruments.values()) inst.releaseAll()
  }

  dispose(): void {
    this.clearScheduled()
    getTransport().stop()
    this.pausedTransportSeconds = null
    for (const inst of this.instruments.values()) inst.dispose()
    this.instruments.clear()
  }
}
