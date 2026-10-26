import { expect } from 'chai';
import type { AiImageEvent } from '@bendyline/docblocks/host';
import { type AiImagesIpc, createAiImagesApi } from '../preload/ai-images-bridge.js';

type Listener = (event: unknown, payload: unknown) => void;

/** A fake IPC whose invoke answers come from a table and whose events we push. */
class FakeIpc implements AiImagesIpc {
  readonly invoked: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, Set<Listener>>();
  constructor(private readonly answers: Record<string, unknown> = {}) {}
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    return this.answers[channel];
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

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4,
  0,
]);

describe('image preload bridge', () => {
  it('re-parses access and degrades an unreadable answer', async () => {
    expect(
      await createAiImagesApi(
        new FakeIpc({ 'ai:images:access': { kind: 'ready' } }),
        mintId,
      ).access(),
    ).to.deep.equal({ kind: 'ready' });
    expect(
      await createAiImagesApi(
        new FakeIpc({ 'ai:images:access': { kind: 'ready', token: 'x' } }),
        mintId,
      ).access(),
    ).to.include({ kind: 'unavailable' });
  });

  it('streams only its own render, validates the PNG, and listens before starting', async () => {
    const ipc = new FakeIpc();
    const api = createAiImagesApi(ipc, mintId);
    const events: AiImageEvent[] = [];
    const handle = api.generate({ prompt: 'A lighthouse', aspect: '16:9' }, (e) => events.push(e));
    const start = ipc.invoked.find((call) => call.channel === 'ai:images:generate:start');
    expect(start?.args[1]).to.deep.equal({ prompt: 'A lighthouse', aspect: '16:9' });
    const requestId = start?.args[0] as string;
    expect(ipc.listeners.get('ai:images:generate:event')?.size).to.equal(1);

    const progress = { phase: 'sampling', step: 1, totalSteps: 4, secondsPerStep: 2 };
    ipc.emit('ai:images:generate:event', {
      requestId: 'someone-else',
      event: { kind: 'progress', progress },
    });
    ipc.emit('ai:images:generate:event', { requestId, event: { kind: 'progress', progress } });
    ipc.emit('ai:images:generate:event', {
      requestId,
      event: {
        kind: 'done',
        image: {
          mimeType: 'image/png',
          data: PNG,
          width: 1024,
          height: 768,
          seed: 7,
          model: 'sd-cpp:flux-2-klein-4b-q4',
          durationMs: 12_100,
        },
      },
    });
    const result = await handle.done;
    expect(result.ok && new Uint8Array(result.value.data)).to.deep.equal(PNG);
    expect(events.map((event) => event.kind)).to.deep.equal(['progress', 'done']);
    expect(ipc.listeners.get('ai:images:generate:event')?.size).to.equal(0);
  });

  it('refuses bytes that are not a PNG and stops the render', async () => {
    const ipc = new FakeIpc();
    const handle = createAiImagesApi(ipc, mintId).generate({ prompt: 'x' }, () => undefined);
    const requestId = ipc.invoked[0]?.args[0];
    ipc.emit('ai:images:generate:event', {
      requestId,
      event: {
        kind: 'done',
        image: {
          mimeType: 'image/png',
          data: new Uint8Array(32),
          width: 1,
          height: 1,
          seed: 1,
          model: 'm',
          durationMs: 1,
        },
      },
    });
    const result = await handle.done;
    expect(result.ok).to.equal(false);
    expect(ipc.invoked.some((call) => call.channel === 'ai:images:generate:cancel')).to.equal(true);
  });

  it('never sends an invalid request to main', async () => {
    const ipc = new FakeIpc();
    const result = await createAiImagesApi(ipc, mintId).generate({ prompt: '' }, () => undefined)
      .done;
    expect(result.ok).to.equal(false);
    expect(ipc.invoked).to.deep.equal([]);
  });
});
