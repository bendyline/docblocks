import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_ROOT,
  isSerializedFsError,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  HOST_WIRE_LIMITS,
  type HostFileSystemV2OpenRequest,
  type HostFileSystemV2WatchMessage,
} from '@bendyline/docblocks/host';
import { FileSystemV2IpcService } from '../main/filesystem-v2-ipc-service.js';
import { getWorkspaceRoots } from '../main/workspace-roots.js';

describe('FileSystemV2IpcService transport', () => {
  const roots = getWorkspaceRoots();
  let rootPath = '';
  let request: HostFileSystemV2OpenRequest;
  let service: FileSystemV2IpcService;

  beforeEach(async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-v2-ipc-'));
    request = {
      instanceId: `instance-${Date.now()}`,
      providerId: `workspace-${Date.now()}`,
      label: 'IPC test',
    };
    roots.register(request.providerId, rootPath);
    service = new FileSystemV2IpcService();
  });

  afterEach(async () => {
    await service.disposeOwner('owner-a');
    await service.disposeOwner('owner-b');
    roots.unregister(request.providerId);
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  it('tells its observer which folders are open and which files were read or changed', async () => {
    const seen: string[] = [];
    await fs.writeFile(path.join(rootPath, 'note.md'), 'one');
    const observed = new FileSystemV2IpcService(undefined, {
      opened: (root) => seen.push(`opened ${path.basename(root)}`),
      closed: (root) => seen.push(`closed ${path.basename(root)}`),
      touched: (root, item) => seen.push(`touched ${item}`),
    });
    const name = path.basename(rootPath);
    try {
      expect((await observed.open('owner-a', request, rootPath)).ok).to.equal(true);
      // Opening again reuses the provider: the folder is still open once.
      expect((await observed.open('owner-a', request, rootPath)).ok).to.equal(true);
      await observed.readFile('owner-a', request.instanceId, parseWorkspacePath('note.md'));
      await observed.readFile('owner-a', request.instanceId, parseWorkspacePath('missing.md'));
      await observed.stat('owner-a', request.instanceId, parseWorkspacePath('note.md'));
      expect(seen).to.deep.equal([`opened ${name}`, 'touched note.md']);

      const messages: HostFileSystemV2WatchMessage[] = [];
      const watching = await observed.watchSubscribe(
        'owner-a',
        request.instanceId,
        'watch-1',
        (m) => messages.push(m),
      );
      expect(watching.ok).to.equal(true);
      await fs.writeFile(path.join(rootPath, 'outside.md'), 'written by another program');
      for (let attempt = 0; attempt < 100 && !seen.includes('touched outside.md'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen).to.include('touched outside.md');
      // The renderer still receives the same event the observer saw.
      expect(messages.some((message) => message.kind === 'event')).to.equal(true);
    } finally {
      await observed.dispose('owner-a', request.instanceId);
    }
    expect(seen.at(-1)).to.equal(`closed ${name}`);
    expect(seen.filter((entry) => entry.startsWith('closed'))).to.have.length(1);
  });

  it('serializes typed failures and isolates provider instances by owner', async () => {
    expect((await service.open('owner-a', request, rootPath)).ok).to.equal(true);

    const invalidRemove = await service.remove('owner-a', request.instanceId, WORKSPACE_ROOT);
    expect(invalidRemove.ok).to.equal(false);
    if (invalidRemove.ok) throw new Error('Expected serialized failure');
    expect(isSerializedFsError(invalidRemove.error)).to.equal(true);
    expect(invalidRemove.error.code).to.equal('invalid-path');

    const otherOwner = await service.stat(
      'owner-b',
      request.instanceId,
      parseWorkspacePath('/note.md'),
    );
    expect(otherOwner.ok).to.equal(false);
    if (otherOwner.ok) throw new Error('Expected owner isolation failure');
    expect(otherOwner.error.code).to.equal('closed');
  });

  it('delivers ordered watch messages and joins unsubscribe', async () => {
    const messages: HostFileSystemV2WatchMessage[] = [];
    expect((await service.open('owner-a', request, rootPath)).ok).to.equal(true);
    const subscribed = await service.watchSubscribe(
      'owner-a',
      request.instanceId,
      'watch-1',
      (message) => messages.push(message),
    );
    expect(subscribed.ok).to.equal(true);

    const note = parseWorkspacePath('/note.md');
    expect(
      (await service.writeFile('owner-a', request.instanceId, note, new Uint8Array([1]))).ok,
    ).to.equal(true);
    expect(messages.map((message) => message.kind)).to.deep.equal(['event']);
    if (messages[0]?.kind === 'event') {
      expect(messages[0].event.type).to.equal('created');
      expect(messages[0].event.sequence).to.equal(1);
    }

    expect((await service.watchUnsubscribe('owner-a', request.instanceId, 'watch-1')).ok).to.equal(
      true,
    );
    expect(
      (await service.writeFile('owner-a', request.instanceId, note, new Uint8Array([2]))).ok,
    ).to.equal(true);
    expect(messages).to.have.length(1);
  });

  for (const disposal of ['provider', 'owner'] as const) {
    it(`allows watcher cleanup after ${disposal} disposal`, async () => {
      expect((await service.open('owner-a', request, rootPath)).ok).to.equal(true);
      expect(
        (await service.watchSubscribe('owner-a', request.instanceId, 'watch-1', () => {})).ok,
      ).to.equal(true);
      if (disposal === 'provider') await service.dispose('owner-a', request.instanceId);
      else await service.disposeOwner('owner-a');
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await service.watchUnsubscribe('owner-a', request.instanceId, 'watch-1'),
        ).to.deep.equal({ ok: true, value: null });
      }
      const read = await service.stat('owner-a', request.instanceId, WORKSPACE_ROOT);
      expect(read.ok).to.equal(false);
      if (!read.ok) expect(read.error.code).to.equal('closed');
    });
  }

  it('serializes oversized writes without changing existing content or granting another owner access', async () => {
    expect((await service.open('owner-a', request, rootPath)).ok).to.equal(true);
    const recordingPath = parseWorkspacePath('/recording.webm');
    const original = new Uint8Array([1, 2, 3]);
    expect(
      (await service.writeFile('owner-a', request.instanceId, recordingPath, original)).ok,
    ).to.equal(true);
    const recording = new Uint8Array(HOST_WIRE_LIMITS.binaryBytes + 1);

    for (const payload of [recording, recording.buffer]) {
      const result = await service.writeFile(
        'owner-a',
        request.instanceId,
        recordingPath,
        payload,
        { mode: 'replace' },
      );
      if (result.ok) throw new Error('Expected oversized write to fail');
      expect(isSerializedFsError(result.error)).to.equal(true);
      expect(result.error).to.include({
        code: 'quota-exceeded',
        operation: 'write',
        path: 'recording.webm',
        retryable: false,
      });
      expect(result.error.message).to.include('100 MiB');
    }
    const otherOwner = await service.writeFile(
      'owner-b',
      request.instanceId,
      recordingPath,
      recording,
    );
    if (otherOwner.ok) throw new Error('Expected owner isolation failure');
    expect(otherOwner.error.code).to.equal('closed');
    expect(await fs.readFile(path.join(rootPath, 'recording.webm'))).to.deep.equal(
      Buffer.from(original),
    );
  });

  it('rejects malformed bytes and still rejects root writes', async () => {
    expect((await service.open('owner-a', request, rootPath)).ok).to.equal(true);
    for (const payload of [null, { byteLength: 1 }, new Uint16Array([1])]) {
      const result = await service.writeFile(
        'owner-a',
        request.instanceId,
        parseWorkspacePath('/bad.bin'),
        payload,
      );
      if (result.ok) throw new Error('Expected malformed write to fail');
      expect(result.error).to.include({
        code: 'invalid-path',
        operation: 'write',
        retryable: false,
      });
    }
    const rootWrite = await service.writeFile(
      'owner-a',
      request.instanceId,
      WORKSPACE_ROOT,
      new Uint8Array([1]),
    );
    if (rootWrite.ok) throw new Error('Expected root write to fail');
    expect(rootWrite.error.code).to.equal('invalid-path');
    expect(await fs.readdir(rootPath)).to.deep.equal([]);
  });

  describe('folder listings', () => {
    async function fill(count: number): Promise<void> {
      for (let start = 0; start < count; start += 500) {
        await Promise.all(
          Array.from({ length: Math.min(500, count - start) }, (_, n) =>
            fs.writeFile(path.join(rootPath, `n${start + n}.md`), ''),
          ),
        );
      }
    }

    function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
      if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
      return result.value;
    }

    function code(result: { ok: boolean; error?: { code: string } }): string | null {
      return result.ok ? null : (result.error?.code ?? null);
    }

    it('pages a listing to its end and keeps it to its owner', async () => {
      await fill(4_500);
      value(await service.open('owner-a', request, rootPath));
      const root = parseWorkspacePath('');
      let step = value(await service.beginEnumerate('owner-a', request.instanceId, root));
      const cursor = step.cursor;
      expect(cursor).to.be.a('string');
      expect(
        code(await service.continueEnumerate('owner-b', request.instanceId, cursor!)),
      ).to.equal('closed');

      let total = step.page.entries.length;
      while (step.cursor !== null) {
        step = value(await service.continueEnumerate('owner-a', request.instanceId, step.cursor));
        total += step.page.entries.length;
      }
      expect(total).to.equal(4_500);
      expect(
        code(await service.continueEnumerate('owner-a', request.instanceId, cursor!)),
      ).to.equal('closed');
    });

    it('releases a listing closed early, caps open listings, and ends them with the provider', async () => {
      await fill(2_100);
      value(await service.open('owner-a', request, rootPath));
      const root = parseWorkspacePath('');
      const cursors: string[] = [];
      for (let n = 0; n < 4; n++) {
        const step = value(await service.beginEnumerate('owner-a', request.instanceId, root));
        cursors.push(step.cursor!);
      }
      expect(code(await service.beginEnumerate('owner-a', request.instanceId, root))).to.equal(
        'busy',
      );
      value(await service.closeEnumerate('owner-a', request.instanceId, cursors[0]!));
      value(await service.closeEnumerate('owner-a', request.instanceId, cursors[0]!));
      expect(
        code(await service.continueEnumerate('owner-a', request.instanceId, cursors[0]!)),
      ).to.equal('closed');
      expect(
        value(await service.beginEnumerate('owner-a', request.instanceId, root)).cursor,
      ).to.be.a('string');

      value(await service.dispose('owner-a', request.instanceId));
      value(await service.open('owner-a', request, rootPath));
      expect(
        code(await service.continueEnumerate('owner-a', request.instanceId, cursors[1]!)),
      ).to.equal('closed');
    });
  });
});
