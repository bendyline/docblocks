import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_ROOT,
  isSerializedFsError,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';
import type {
  HostFileSystemV2OpenRequest,
  HostFileSystemV2WatchMessage,
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
      rootPath,
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
    expect((await service.open('owner-a', request)).ok).to.equal(true);

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
    expect((await service.open('owner-a', request)).ok).to.equal(true);
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
});
