import { expect } from 'chai';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsError, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  FILE_SYSTEM_TRANSFER_LIMITS as LIMITS,
  type HostFileSystemV2Result,
} from '@bendyline/docblocks/host';
import { FileSystemV2IpcService } from '../main/filesystem-v2-ipc-service.js';
import { FileSystemTransfers } from '../main/filesystem-transfers.js';
import { getWorkspaceRoots } from '../main/workspace-roots.js';

function value<T>(result: HostFileSystemV2Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function failure(result: HostFileSystemV2Result<unknown>, code: string) {
  expect(result.ok).to.equal(false);
  if (!result.ok) expect(result.error.code).to.equal(code);
}

describe('bounded filesystem transfers', () => {
  let root: string;
  let service: FileSystemV2IpcService;
  const owner = 'transfer-owner';
  const instance = 'transfer-instance';
  const workspace = 'transfer-workspace';
  const file = parseWorkspacePath('recording.webm');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-transfer-test-'));
    getWorkspaceRoots().register(workspace, root);
    service = new FileSystemV2IpcService();
    value(
      await service.open(
        owner,
        { instanceId: instance, providerId: workspace, label: 'Transfer test' },
        root,
      ),
    );
  });

  afterEach(async () => {
    await service.disposeOwner(owner);
    await service.disposeOwner('other-owner');
    getWorkspaceRoots().unregister(workspace);
    // Only this test's explicitly created temporary directory is removed.
    if (
      path.dirname(root) !== (await fs.realpath(os.tmpdir())) &&
      path.dirname(root) !== os.tmpdir()
    )
      throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves and reopens a complete 1 GiB file with 4 MiB messages', async function () {
    this.timeout(180_000);
    const size = LIMITS.fileBytes;
    const upload = value(await service.beginWrite(owner, instance, file, size, { mode: 'create' }));
    const bytes = new Uint8Array(LIMITS.chunkBytes);
    const expected = createHash('sha256');
    for (let offset = 0; offset < size; offset += bytes.byteLength) {
      bytes.fill((offset / bytes.byteLength) % 251);
      expected.update(bytes);
      value(await service.writeChunk(owner, instance, upload, offset, bytes));
    }
    expect(await fs.readdir(root)).to.deep.equal([]);
    const saved = value(await service.finishWrite(owner, instance, upload));
    expect(saved.size).to.equal(size);
    expect((await fs.stat(path.join(root, 'recording.webm'))).size).to.equal(size);
    const download = value(await service.beginRead(owner, instance, file));
    expect(download?.entry.version).to.equal(saved.version);
    if (!download) throw new Error('Missing recording');
    const actual = createHash('sha256');
    for (let offset = 0; offset < size; ) {
      const chunk = value(await service.readChunk(owner, instance, download.transferId, offset));
      expect(chunk.byteLength).to.be.at.most(LIMITS.chunkBytes).and.above(0);
      actual.update(new Uint8Array(chunk));
      offset += chunk.byteLength;
    }
    expect(actual.digest('hex')).to.equal(expected.digest('hex'));
    value(await service.closeTransfer(owner, instance, download.transferId));
    expect(await fs.readdir(root)).to.deep.equal(['recording.webm']);
  });

  it('keeps existing data when a transfer is incomplete, cancelled, or conflicts', async () => {
    const original = value(await service.writeFile(owner, instance, file, new Uint8Array([7, 8])));
    const upload = value(
      await service.beginWrite(owner, instance, file, 3, { expectedVersion: original.version }),
    );
    value(await service.writeChunk(owner, instance, upload, 0, new Uint8Array([1])));
    failure(await service.finishWrite(owner, instance, upload), 'corrupt');
    expect([...(await fs.readFile(path.join(root, 'recording.webm')))]).to.deep.equal([7, 8]);
    const cancelled = value(await service.beginWrite(owner, instance, file, 1));
    value(await service.writeChunk(owner, instance, cancelled, 0, new Uint8Array([1])));
    value(await service.closeTransfer(owner, instance, cancelled));
    failure(await service.finishWrite(owner, instance, cancelled), 'closed');
    const conflict = value(
      await service.beginWrite(owner, instance, file, 1, { expectedVersion: original.version }),
    );
    value(await service.writeChunk(owner, instance, conflict, 0, new Uint8Array([1])));
    await fs.writeFile(path.join(root, 'recording.webm'), new Uint8Array([9]));
    failure(await service.finishWrite(owner, instance, conflict), 'conflict');
    expect([...(await fs.readFile(path.join(root, 'recording.webm')))]).to.deep.equal([9]);
    expect(await fs.readdir(root)).to.deep.equal(['recording.webm']);
  });

  it('validates size, ownership, chunk ordering, and declared length', async () => {
    failure(
      await service.beginWrite(owner, instance, file, LIMITS.fileBytes + 1),
      'quota-exceeded',
    );
    failure(await service.beginWrite(owner, instance, parseWorkspacePath(''), 1), 'invalid-path');
    const upload = value(await service.beginWrite(owner, instance, file, 2));
    value(
      await service.open(
        'other-owner',
        { instanceId: instance, providerId: workspace, label: 'Other' },
        root,
      ),
    );
    failure(
      await service.writeChunk('other-owner', instance, upload, 0, new Uint8Array([1])),
      'closed',
    );
    value(await service.closeTransfer('other-owner', instance, upload));
    failure(
      await service.writeChunk(owner, instance, upload, 1, new Uint8Array([1])),
      'invalid-path',
    );
    failure(
      await service.writeChunk(owner, instance, upload, 0, new Uint8Array(3)),
      'quota-exceeded',
    );
    failure(
      await service.writeChunk(owner, instance, upload, 0, new Uint8Array(LIMITS.chunkBytes + 1)),
      'quota-exceeded',
    );
    failure(
      await service.writeChunk(owner, instance, upload, 0, { byteLength: 1 }),
      'quota-exceeded',
    );
    value(await service.writeChunk(owner, instance, upload, 0, new Uint8Array([1, 2])));
    value(await service.finishWrite(owner, instance, upload));
    expect([...(await fs.readFile(path.join(root, 'recording.webm')))]).to.deep.equal([1, 2]);
  });

  it('bounds reservations and revokes transfers when the renderer disappears', async () => {
    value(await service.beginWrite(owner, instance, file, LIMITS.fileBytes));
    value(await service.beginWrite(owner, instance, file, LIMITS.fileBytes));
    failure(await service.beginWrite(owner, instance, file, 1), 'busy');
    value(await service.dispose(owner, instance));
    failure(await service.beginWrite(owner, instance, file, 1), 'closed');
    expect(await fs.readdir(root)).to.deep.equal([]);
  });

  it('returns missing narrowly and keeps a read snapshot stable after the source changes', async () => {
    expect(value(await service.beginRead(owner, instance, file))).to.equal(null);
    failure(await service.beginRead(owner, instance, parseWorkspacePath('')), 'type-mismatch');
    value(await service.writeFile(owner, instance, file, new Uint8Array([1, 2])));
    const download = value(await service.beginRead(owner, instance, file));
    if (!download) throw new Error('Missing recording');
    await fs.writeFile(path.join(root, 'recording.webm'), new Uint8Array([3]));
    expect([
      ...new Uint8Array(value(await service.readChunk(owner, instance, download.transferId, 0))),
    ]).to.deep.equal([1, 2]);
    value(await service.closeTransfer(owner, instance, download.transferId));
  });

  it('expires abandoned uploads and joins creation during disposal', async () => {
    const transfers = new FileSystemTransfers(20);
    const id = await transfers.beginWrite(owner, instance, file, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(() => transfers.writeChunk(owner, instance, id, 0, new Uint8Array([1]))).to.throw(
      FsError,
    );
    await transfers.dispose(owner, instance);
    const next = new FileSystemTransfers();
    const creating = next.beginWrite(owner, instance, file, 1);
    const rejected = creating.then(
      () => false,
      () => true,
    );
    await next.dispose(owner, instance);
    expect(await rejected).to.equal(true);
  });
});
