import { expect } from 'chai';
import type { SpeechSynthesizeEvent } from '@bendyline/docblocks/host';
import { createSpeechApi, type SpeechIpc } from '../preload/speech-bridge.js';

type Listener = (event: unknown, payload: unknown) => void;

/** A fake IPC whose invoke answers come from a table and whose events we push. */
class FakeIpc implements SpeechIpc {
  readonly invoked: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, Set<Listener>>();
  constructor(private readonly answers: Record<string, unknown>) {}
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    const answer = this.answers[channel];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function'
      ? (answer as (...a: unknown[]) => unknown)(...args)
      : answer;
  }
  on(channel: string, listener: Listener): void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
  }
  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener);
  }
  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({}, payload);
  }
}

let counter = 0;
const mintId = (prefix: string) => `${prefix}-${++counter}`;

describe('speech preload bridge', () => {
  it('exposes only the engines main reported', () => {
    const ipc = new FakeIpc({});
    expect(createSpeechApi(ipc, { stt: true, tts: false }, mintId).transcribe).to.be.a('function');
    expect(createSpeechApi(ipc, { stt: true, tts: false }, mintId).synthesize).to.equal(undefined);
    expect(createSpeechApi(ipc, { stt: false, tts: true }, mintId).transcribe).to.equal(undefined);
  });

  it('re-parses status and degrades an unreadable one to unavailable', async () => {
    const good = {
      stt: { state: 'ready', model: 'whisper-base.en' },
      tts: { state: 'unavailable' },
    };
    expect(
      await createSpeechApi(
        new FakeIpc({ 'speech:status': good }),
        { stt: true, tts: true },
        mintId,
      ).status(),
    ).to.deep.equal(good);
    const bad = await createSpeechApi(
      new FakeIpc({ 'speech:status': { stt: 'x' } }),
      { stt: true, tts: true },
      mintId,
    ).status();
    expect(bad.stt.state).to.equal('unavailable');
  });

  it('turns a rejected transcription into an error result', async () => {
    const api = createSpeechApi(
      new FakeIpc({ 'speech:transcribe': new Error('boom') }),
      { stt: true, tts: false },
      mintId,
    );
    const result = await api.transcribe!({ audio: new ArrayBuffer(44), mimeType: 'audio/wav' });
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.error.detail).to.equal('boom');
  });

  it('streams synthesis events for its own request id only', async () => {
    const ipc = new FakeIpc({ 'speech:synthesize:start': undefined });
    const api = createSpeechApi(ipc, { stt: false, tts: true }, mintId);
    const events: SpeechSynthesizeEvent[] = [];
    const handle = api.synthesize!({ text: 'Hi.' }, (event) => events.push(event));
    const requestId = ipc.invoked.find((call) => call.channel === 'speech:synthesize:start')
      ?.args[0];
    ipc.emit('speech:synthesize:event', {
      requestId: 'someone-else',
      event: { kind: 'error', error: { code: 'unknown', message: 'not mine' } },
    });
    ipc.emit('speech:synthesize:event', {
      requestId,
      event: {
        kind: 'chunk',
        chunk: {
          index: 0,
          pcm: new Float32Array(4),
          sampleRate: 24_000,
          durationSec: 0.1,
          textStart: 0,
          textEnd: 3,
        },
      },
    });
    ipc.emit('speech:synthesize:event', {
      requestId,
      event: {
        kind: 'done',
        summary: {
          voice: 'af_heart',
          model: 'kokoro-82m-v1.0',
          sampleRate: 24_000,
          durationSec: 0.1,
          chunks: 1,
        },
      },
    });
    const result = await handle.done;
    expect(result.ok).to.equal(true);
    expect(events.map((e) => e.kind)).to.deep.equal(['chunk', 'done']);
    expect(ipc.listeners.get('speech:synthesize:event')?.size).to.equal(0);
  });

  it('cancels and fails a stream that sends something unreadable', async () => {
    const ipc = new FakeIpc({
      'speech:synthesize:start': undefined,
      'speech:synthesize:cancel': undefined,
    });
    const api = createSpeechApi(ipc, { stt: false, tts: true }, mintId);
    const handle = api.synthesize!({ text: 'Hi.' }, () => undefined);
    const requestId = ipc.invoked[0]?.args[0];
    ipc.emit('speech:synthesize:event', {
      requestId,
      event: { kind: 'chunk', chunk: { index: -1 } },
    });
    const result = await handle.done;
    expect(result.ok).to.equal(false);
    expect(ipc.invoked.some((call) => call.channel === 'speech:synthesize:cancel')).to.equal(true);
  });

  it('reports install progress and completion', async () => {
    const ipc = new FakeIpc({ 'speech:install:start': undefined });
    const api = createSpeechApi(ipc, { stt: true, tts: false }, mintId);
    const progress: number[] = [];
    const handle = api.installModel('whisper-base.en', (p) => progress.push(p.receivedBytes));
    const requestId = ipc.invoked[0]?.args[0];
    ipc.emit('speech:install:event', {
      requestId,
      event: {
        kind: 'progress',
        progress: { phase: 'downloading', receivedBytes: 10, totalBytes: 100 },
      },
    });
    ipc.emit('speech:install:event', {
      requestId,
      event: {
        kind: 'done',
        model: {
          id: 'whisper-base.en',
          kind: 'stt',
          label: 'Base',
          description: 'd',
          downloadBytes: 100,
          installed: true,
          source: 'app',
          recommended: true,
          license: 'MIT',
          licenseUrl: 'https://x.test/l',
        },
      },
    });
    const result = await handle.done;
    expect(result.ok && result.value.id).to.equal('whisper-base.en');
    expect(progress).to.deep.equal([10]);
  });
});
