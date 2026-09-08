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
});
