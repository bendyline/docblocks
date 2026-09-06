import { expect } from 'chai';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { createCliRegistry } from '@bendyline/squisq-cli/api';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { DocumentService } from '../src/mcp/document-service.js';

describe('MCP document preparation cancellation', () => {
  it('cancels an authority-scoped source between bounded input read chunks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-mcp-source-cancel-'));
    const sourcePath = path.join(root, 'large-source.md');
    const movedPath = path.join(root, 'moved-source.md');
    const content = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    await writeFile(sourcePath, content);
    const artifacts = new ArtifactStore();
    const controller = new AbortController();
    const reason = new Error('cancel authority source read');
    const observations: Array<{ read: number; total: number }> = [];
    try {
      const authority = await McpFileAuthority.create(
        { readRoots: [root] },
        {
          afterInputReadChunk(read, total) {
            observations.push({ read, total });
            controller.abort(reason);
          },
        },
      );
      const service = new DocumentService(authority, artifacts);

      await expectRejectionReason(
        service.readBinarySource(
          {
            kind: 'file',
            rootId: authority.listRoots()[0]!.id,
            path: parseWorkspacePath('large-source.md'),
            format: 'md',
          },
          controller.signal,
        ),
        reason,
      );

      expect(observations).to.have.length(1);
      expect(observations[0]?.read).to.be.greaterThan(0).and.lessThan(content.byteLength);
      expect(observations[0]?.total).to.equal(content.byteLength);
      await rename(sourcePath, movedPath);
      await rename(movedPath, sourcePath);
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates cancellation through authority-backed bundle asset reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-mcp-bundle-cancel-'));
    const assetPath = path.join(root, 'large-asset.bin');
    const content = Buffer.alloc(2 * 1024 * 1024 + 1, 0x62);
    await writeFile(assetPath, content);
    const artifacts = new ArtifactStore();
    const controller = new AbortController();
    const reason = new Error('cancel bundle asset read');
    const observations: Array<{ read: number; total: number }> = [];
    try {
      const authority = await McpFileAuthority.create(
        { readRoots: [root] },
        {
          afterInputReadChunk(read, total) {
            observations.push({ read, total });
            controller.abort(reason);
          },
        },
      );
      const service = new DocumentService(authority, artifacts);

      await expectRejectionReason(
        service.prepare(
          {
            kind: 'bundle',
            markdown: '# Document',
            name: 'document.md',
            assets: [
              {
                path: parseWorkspacePath('media/large-asset.bin'),
                source: {
                  kind: 'file',
                  rootId: authority.listRoots()[0]!.id,
                  path: parseWorkspacePath('large-asset.bin'),
                },
                mimeType: 'application/octet-stream',
                altText: null,
                credit: null,
                license: null,
              },
            ],
          },
          controller.signal,
        ),
        reason,
      );

      expect(observations).to.have.length(1);
      expect(observations[0]?.read).to.be.greaterThan(0).and.lessThan(content.byteLength);
      expect(observations[0]?.total).to.equal(content.byteLength);
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes the caller signal into linked import normalization and preserves its reason', async () => {
    const artifacts = new ArtifactStore();
    try {
      const source = await artifacts.put({
        bytes: Buffer.from('name,value\nalpha,1\n', 'utf8'),
        format: 'csv',
        mimeType: 'text/csv',
        suggestedFilename: 'source.csv',
      });
      const registry = createCliRegistry();
      const csv = registry.get('csv');
      if (!csv?.importContainer && !csv?.importDoc) {
        throw new Error('Expected the linked CSV importer');
      }
      const controller = new AbortController();
      const reason = new Error('cancelled inside linked importer');
      let receivedSignal: AbortSignal | undefined;
      if (csv.importContainer) {
        const originalImport = csv.importContainer;
        registry.register({
          ...csv,
          importContainer: async (data, options) => {
            receivedSignal = options.signal;
            const imported = await originalImport(data, options);
            controller.abort(reason);
            return imported;
          },
        });
      } else if (csv.importDoc) {
        const originalImport = csv.importDoc;
        registry.register({
          ...csv,
          importDoc: async (data, options) => {
            receivedSignal = options.signal;
            const imported = await originalImport(data, options);
            controller.abort(reason);
            return imported;
          },
        });
      }
      const service = new DocumentService(await McpFileAuthority.create(), artifacts, registry);

      let caught: unknown;
      try {
        await service.prepare({ kind: 'artifact', uri: source.uri }, controller.signal);
      } catch (error: unknown) {
        caught = error;
      }

      expect(receivedSignal).to.equal(controller.signal);
      expect(caught).to.equal(reason);
    } finally {
      await artifacts.dispose();
    }
  });
});

async function expectRejectionReason(promise: Promise<unknown>, reason: unknown): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).to.equal(reason);
}
