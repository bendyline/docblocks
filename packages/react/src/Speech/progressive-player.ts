/**
 * A sentence-buffered Web Audio player for narration that is still being
 * synthesized, ported from Gezel's `ProgressiveNarrationPlayer`.
 *
 * Chunks share one timeline, so a newly arrived sentence is scheduled after
 * the audio already playing without restarting it, and chunks that arrive out
 * of order wait for their predecessors. The one change from Gezel: chunks are
 * mono float32 PCM rather than WAV, so they become AudioBuffers directly, and
 * each keeps the slice of text it speaks so the UI can follow along.
 */

export interface PlayerChunk {
  readonly index: number;
  readonly pcm: ArrayBuffer;
  readonly sampleRate: number;
  /** Optional label for following along, e.g. the source text range. */
  readonly textStart?: number;
  readonly textEnd?: number;
}

export interface ProgressivePlayerSnapshot {
  readonly currentTime: number;
  readonly bufferedDuration: number;
  readonly isPlaying: boolean;
  /** Playback caught up with synthesis and is waiting for the next sentence. */
  readonly waitingForAudio: boolean;
  readonly complete: boolean;
  /** The chunk under the playhead, or null before the first one. */
  readonly currentChunk: number | null;
}

interface Scheduled {
  readonly index: number;
  readonly start: number;
  readonly buffer: AudioBuffer;
}

/** The slice of AudioContext the player uses; injected in tests. */
export type PlayerAudioContext = Pick<
  AudioContext,
  'createBuffer' | 'createBufferSource' | 'currentTime' | 'destination' | 'resume' | 'close'
>;

export class ProgressivePlayer {
  static create(onChange: (snapshot: ProgressivePlayerSnapshot) => void): ProgressivePlayer | null {
    const Context = globalThis.AudioContext;
    if (!Context) return null;
    try {
      return new ProgressivePlayer(new Context(), onChange);
    } catch {
      return null;
    }
  }

  private readonly chunks: Scheduled[] = [];
  private readonly pending = new Map<number, AudioBuffer>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private bufferedDuration = 0;
  private playbackOffset = 0;
  private playbackStartedAt = 0;
  private playing = false;
  private complete = false;
  private disposed = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly context: PlayerAudioContext,
    private readonly onChange: (snapshot: ProgressivePlayerSnapshot) => void,
  ) {}

  /** Call synchronously from the click that starts playback, to keep audio permission. */
  prime(): void {
    void this.context.resume().catch(() => undefined);
  }

  append(chunk: PlayerChunk): void {
    if (this.disposed || chunk.index < this.chunks.length || this.pending.has(chunk.index)) return;
    const samples = new Float32Array(chunk.pcm);
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, chunk.sampleRate);
    buffer.copyToChannel(samples, 0);
    this.pending.set(chunk.index, buffer);
    while (this.pending.has(this.chunks.length)) {
      const index = this.chunks.length;
      const next = this.pending.get(index)!;
      this.pending.delete(index);
      const scheduled = { index, start: this.bufferedDuration, buffer: next };
      this.chunks.push(scheduled);
      this.bufferedDuration += next.duration;
      if (this.playing) this.schedule(scheduled);
    }
    this.refreshEndTimer();
    this.emit();
  }

  async play(): Promise<boolean> {
    if (this.disposed || this.bufferedDuration <= 0) return false;
    if (this.playing) return true;
    if (this.playbackOffset >= this.bufferedDuration - 0.02) {
      if (!this.complete) {
        this.emit();
        return false;
      }
      this.playbackOffset = 0;
    }
    await this.context.resume();
    this.stopSources();
    this.playing = true;
    this.playbackStartedAt = this.context.currentTime + 0.025;
    for (const chunk of this.chunks) this.schedule(chunk);
    this.refreshEndTimer();
    this.emit();
    return true;
  }

  pause(): void {
    if (!this.playing) return;
    this.playbackOffset = this.currentTime();
    this.playing = false;
    this.stopSources();
    this.clearEndTimer();
    this.emit();
  }

  seek(seconds: number): void {
    const wasPlaying = this.playing;
    this.playbackOffset = Math.max(0, Math.min(this.bufferedDuration, seconds));
    this.playing = false;
    this.stopSources();
    this.clearEndTimer();
    if (wasPlaying) void this.play();
    else this.emit();
  }

  /** No more chunks will arrive. */
  finish(): void {
    this.complete = true;
    this.refreshEndTimer();
    this.emit();
  }

  snapshot(): ProgressivePlayerSnapshot {
    const currentTime = this.currentTime();
    return {
      currentTime,
      bufferedDuration: this.bufferedDuration,
      isPlaying: this.playing,
      waitingForAudio:
        !this.complete &&
        !this.playing &&
        this.bufferedDuration > 0 &&
        currentTime >= this.bufferedDuration - 0.05,
      complete: this.complete,
      currentChunk: this.chunkAt(currentTime),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.stopSources();
    this.clearEndTimer();
    void this.context.close().catch(() => undefined);
  }

  private chunkAt(time: number): number | null {
    let found: number | null = null;
    for (const chunk of this.chunks) {
      if (chunk.start <= time + 0.001) found = chunk.index;
      else break;
    }
    return found;
  }

  private currentTime(): number {
    if (!this.playing) return this.playbackOffset;
    return Math.min(
      this.bufferedDuration,
      this.playbackOffset + Math.max(0, this.context.currentTime - this.playbackStartedAt),
    );
  }

  private schedule(chunk: Scheduled): void {
    const chunkEnd = chunk.start + chunk.buffer.duration;
    if (!this.playing || chunkEnd <= this.playbackOffset + 0.005) return;
    let sourceOffset = Math.max(0, this.playbackOffset - chunk.start);
    let when = this.playbackStartedAt + Math.max(0, chunk.start - this.playbackOffset);
    if (when < this.context.currentTime) {
      sourceOffset += this.context.currentTime - when;
      when = this.context.currentTime;
    }
    if (sourceOffset >= chunk.buffer.duration - 0.005) return;
    const source = this.context.createBufferSource();
    source.buffer = chunk.buffer;
    source.connect(this.context.destination);
    source.addEventListener('ended', () => this.sources.delete(source), { once: true });
    this.sources.add(source);
    source.start(when, sourceOffset);
  }

  private refreshEndTimer(): void {
    this.clearEndTimer();
    if (!this.playing) return;
    const remainingMs = Math.max(20, (this.bufferedDuration - this.currentTime()) * 1000 + 40);
    this.endTimer = setTimeout(() => {
      if (!this.playing) return;
      if (this.currentTime() < this.bufferedDuration - 0.05) {
        this.refreshEndTimer();
        return;
      }
      this.playbackOffset = this.bufferedDuration;
      this.playing = false;
      this.stopSources();
      this.clearEndTimer();
      this.emit();
    }, remainingMs);
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source that ended naturally may already be stopped.
      }
    }
    this.sources.clear();
  }

  private clearEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private emit(): void {
    if (!this.disposed) this.onChange(this.snapshot());
  }
}

/**
 * When streamed narration may start on its own — Gezel's `DocumentNarration`
 * rule. Rates are measured from the first chunk onward, so model load time is
 * not counted against synthesis. Playback starts once at least 4 s is buffered
 * ahead and either audio is being generated at 1.15× realtime or better, or the
 * buffer already covers the estimated remaining generation time plus 3 s.
 */
export class AutoPlayGate {
  private firstAt: number | null = null;
  private firstDuration = 0;
  private firstCharacters = 0;

  /** Call after each appended chunk; true when it is safe to start playing. */
  ready(
    snapshot: ProgressivePlayerSnapshot,
    progress: { readonly completedCharacters: number; readonly totalCharacters: number } | null,
    nowMs: number,
  ): boolean {
    if (this.firstAt === null) {
      this.firstAt = nowMs;
      this.firstDuration = snapshot.bufferedDuration;
      this.firstCharacters = progress?.completedCharacters ?? 0;
    }
    const elapsed = (nowMs - this.firstAt) / 1000;
    const audioRate =
      elapsed > 0.25 ? (snapshot.bufferedDuration - this.firstDuration) / elapsed : 0;
    const characterRate =
      elapsed > 0.25 ? ((progress?.completedCharacters ?? 0) - this.firstCharacters) / elapsed : 0;
    const remaining =
      progress && characterRate > 0
        ? (progress.totalCharacters - progress.completedCharacters) / characterRate
        : Number.POSITIVE_INFINITY;
    const ahead = snapshot.bufferedDuration - snapshot.currentTime;
    return ahead >= 4 && (audioRate >= 1.15 || ahead >= remaining + 3);
  }
}
