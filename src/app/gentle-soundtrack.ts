/**
 * Background score with real recorded instruments: piano, violins and cellos
 * (public/trilha-romantica.mp3, composed for this film).
 *
 * Instrument samples:
 * - Salamander Grand Piano V3, by Alexander Holm (CC BY 3.0).
 * - VSCO-2 Community Edition violin and cello sections, by Sam Gossner (CC0).
 *
 * The track follows the film: 0–66s are the five scenes, then the letter theme
 * plays (66–90s) and keeps looping seamlessly (90–114s). The title screen loops
 * the letter theme quietly. If the film skips ahead, the music jumps with a crossfade.
 */
const TRACK_URL = 'trilha-romantica.mp3';
const LOOP_START = 90;
const LOOP_END = 114;
/** Where each scene starts in the track (index = scene number). */
const SCENE_START = [LOOP_START, 0, 12, 24, 36, 51, 66];
const FILM_VOLUME = 0.85;
const TITLE_VOLUME = 0.5;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Track position at `startedAt`. */
  offset: number;
  startedAt: number;
}

export class GentleSoundtrack {
  private context?: AudioContext;
  private master?: GainNode;
  private buffer?: Promise<AudioBuffer>;
  private voice?: Voice;
  private scene = 0;
  private enabled = false;
  private suspended = false;
  private disposed = false;
  private pauseToken = 0;

  async play(): Promise<void> {
    if (this.disposed) return;
    this.context ??= new AudioContext();
    const context = this.context;
    await context.resume();
    if (!this.buffer) {
      const loading = fetch(TRACK_URL)
        .then((response) => {
          if (!response.ok) throw new Error(`Trilha indisponível (${response.status})`);
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data));
      this.buffer = loading;
      loading.catch(() => {
        if (this.buffer === loading) this.buffer = undefined;
      });
    }
    await this.buffer;
    if (this.disposed) {
      void context.close();
      return;
    }
    if (!this.master) {
      this.master = context.createGain();
      this.master.gain.value = 0;
      this.master.connect(context.destination);
    }
    this.enabled = true;
    if (!this.suspended) await this.begin();
  }
  stop(): void {
    this.enabled = false;
    this.fadeMaster(0, 0.15);
    const voice = this.voice;
    this.voice = undefined;
    if (voice && this.context) voice.source.stop(this.context.currentTime + 0.8);
  }
  pause(paused: boolean): void {
    this.suspended = paused;
    if (paused) {
      // Fade out, then freeze the clock so the music resumes exactly where the film does.
      this.fadeMaster(0, 0.06);
      const token = ++this.pauseToken;
      setTimeout(() => {
        if (token === this.pauseToken && this.suspended) void this.context?.suspend();
      }, 250);
    } else {
      this.pauseToken++;
      if (this.enabled) void this.begin();
    }
  }
  /** Keeps the music in step with the film. */
  setScene(scene: number): void {
    const previous = this.scene;
    this.scene = Math.max(0, Math.min(6, scene));
    if (!this.voice || !this.context || this.scene === previous) return;
    if (!this.suspended) this.fadeMaster(this.volume(), 1.2);
    const target = SCENE_START[this.scene];
    const position = this.position();
    const lost =
      this.scene === 0
        ? position < 66
        : this.scene === 6
          ? position < target - 1.5
          : Math.abs(position - target) > 1.5;
    if (lost) void this.startAt(target, 1);
  }

  private async begin(): Promise<void> {
    const context = this.context;
    if (!context || !this.master || !this.buffer) return;
    await context.resume();
    if (!this.enabled || this.suspended) return;
    if (!this.voice) await this.startAt(SCENE_START[this.scene], 0.05);
    this.fadeMaster(this.volume(), 0.5);
  }
  private volume(): number {
    return this.scene === 0 ? TITLE_VOLUME : FILM_VOLUME;
  }
  private fadeMaster(level: number, smoothing: number): void {
    if (!this.context || !this.master) return;
    const gain = this.master.gain;
    gain.cancelScheduledValues(this.context.currentTime);
    gain.setTargetAtTime(level, this.context.currentTime, smoothing);
  }
  /** Current position in the track, taking the letter loop into account. */
  private position(): number {
    if (!this.voice || !this.context) return 0;
    const raw = this.voice.offset + (this.context.currentTime - this.voice.startedAt);
    return raw < LOOP_END ? raw : LOOP_START + ((raw - LOOP_START) % (LOOP_END - LOOP_START));
  }
  /** Starts the track at `offset`, crossfading from whatever was playing. */
  private async startAt(offset: number, fade: number): Promise<void> {
    const context = this.context,
      master = this.master;
    if (!context || !master || !this.buffer) return;
    const buffer = await this.buffer;
    const now = context.currentTime;
    const old = this.voice;
    if (old) {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fade);
      old.source.stop(now + fade + 0.05);
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = LOOP_START;
    source.loopEnd = LOOP_END;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fade);
    source.connect(gain);
    gain.connect(master);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start(now, offset);
    this.voice = { source, gain, offset, startedAt: now };
  }

  destroy(): void {
    this.disposed = true;
    this.enabled = false;
    try {
      this.voice?.source.stop();
    } catch {
      /* already stopped */
    }
    this.voice = undefined;
    void this.context?.close();
  }
}
