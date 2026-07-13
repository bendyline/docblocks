import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { callTool, startMcpHarness } from './mcp-helpers.js';

describe('MCP canonical boundary contracts', () => {
  it('rejects missing, malformed, and inexact canonical sources', async () => {
    const harness = await startMcpHarness();
    try {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: 'inspect_document', args: {} },
        {
          name: 'inspect_document',
          args: { source: { kind: 'markdown', markdown: '# Exact', name: null, extra: true } },
        },
        {
          name: 'convert_document',
          args: {
            source: { kind: 'unknown', markdown: '# Unknown', name: null },
            targets: [{ format: 'dbk', fidelity: 'semantic' }],
          },
        },
        {
          name: 'convert_document',
          args: {
            source: { kind: 'markdown', markdown: '# Exact', name: null },
            targets: [{ format: 'dbk', fidelity: 'semantic', unexpected: true }],
          },
        },
        {
          name: 'save_artifact',
          args: {
            artifactUri: '00000000-0000-4000-8000-000000000000',
            destination: {
              rootId: 'root-unknown',
              path: 'output.dbk',
              ifExists: 'error',
              expectedSha256: null,
            },
          },
        },
        {
          name: 'save_artifact',
          args: {
            artifactUri: 'docblocks://user@artifacts/00000000-0000-4000-8000-000000000000',
            destination: {
              rootId: 'root-unknown',
              path: 'output.dbk',
              ifExists: 'error',
              expectedSha256: null,
            },
          },
        },
      ];
      for (const call of calls) {
        const result = await callTool(harness.client, call.name, call.args);
        expect(result.isError, `${call.name}: ${JSON.stringify(call.args)}`).to.equal(true);
        expect(result.text).to.include('Invalid arguments');
      }
      const discovery = await callTool(harness.client, 'list_formats', { unexpected: true });
      expect(discovery.isError).to.equal(true);
      expect(discovery.text).to.include('Invalid arguments');
    } finally {
      await harness.dispose();
    }
  });

  it('enforces root aliases and input byte limits through canonical tools', async () => {
    const harness = await startMcpHarness({ maxInputFileBytes: 4 });
    try {
      await writeFile(join(harness.tmpDir, 'too-large.md'), '12345', 'utf8');
      const roots = await callTool(harness.client, 'list_roots', {});
      const rootId = readableRootId(roots.structuredContent?.roots);
      const oversized = await callTool(harness.client, 'inspect_document', {
        source: { kind: 'file', rootId, path: 'too-large.md', format: 'md' },
      });
      expect(oversized.isError).to.equal(true);
      expect(oversized.text).to.include('file-size limit');

      const denied = await callTool(harness.client, 'inspect_document', {
        source: { kind: 'file', rootId: 'root-not-granted', path: 'too-large.md', format: 'md' },
      });
      expect(denied.isError).to.equal(true);
      expect(denied.text).to.include('Unknown or unreadable MCP root');
    } finally {
      await harness.dispose();
    }
  });

  it('propagates malformed DBK import failures without publishing an artifact', async () => {
    const harness = await startMcpHarness();
    try {
      await writeFile(join(harness.tmpDir, 'malformed.dbk'), Buffer.from('PK\u0003\u0004invalid'));
      const roots = await callTool(harness.client, 'list_roots', {});
      const result = await callTool(harness.client, 'convert_document', {
        source: {
          kind: 'file',
          rootId: readableRootId(roots.structuredContent?.roots),
          path: 'malformed.dbk',
          format: 'dbk',
        },
        targets: [{ format: 'html', fidelity: 'semantic' }],
      });
      expect(result.isError).to.equal(true);
      expect(result.structuredContent?.kind).to.equal('error');
    } finally {
      await harness.dispose();
    }
  });

  it('produces DBK artifacts that satisfy the same strict import policy', async () => {
    const harness = await startMcpHarness();
    try {
      const converted = await callTool(harness.client, 'convert_document', {
        source: {
          kind: 'markdown',
          markdown: `# Compressible\n\n${'x'.repeat(16 * 1024)}`,
          name: 'compressible.md',
        },
        targets: [{ format: 'dbk', fidelity: 'semantic' }],
      });
      expect(converted.isError, converted.text).to.equal(false);
      const results = converted.structuredContent?.results;
      if (!Array.isArray(results)) throw new Error('Expected DBK conversion result');
      const artifact = (results[0] as { artifact?: { uri?: unknown } } | undefined)?.artifact;
      if (!artifact || typeof artifact.uri !== 'string') throw new Error('Expected DBK artifact');

      const resource = await harness.client.readResource({ uri: artifact.uri });
      const blob = resource.contents.find(
        (content): content is typeof content & { blob: string } =>
          'blob' in content && typeof content.blob === 'string',
      );
      if (!blob) throw new Error('Expected DBK binary resource');
      expect(zipCompressionMethods(Buffer.from(blob.blob, 'base64'))).to.deep.equal([0]);

      const inspected = await callTool(harness.client, 'inspect_document', {
        source: { kind: 'artifact', uri: artifact.uri },
        maxBlocks: 5,
      });
      expect(inspected.isError, inspected.text).to.equal(false);
      expect(inspected.structuredContent?.sourceFormat).to.equal('dbk');
    } finally {
      await harness.dispose();
    }
  });

  it('validates operation concurrency and runtime budgets at server startup', () => {
    expect(() => createMcpServer({ maxConcurrentOperations: 0 })).to.throw(
      'Invalid MCP operation concurrency limit',
    );
    expect(() => createMcpServer({ maxConcurrentOperations: 33 })).to.throw(
      'Invalid MCP operation concurrency limit',
    );
    expect(() => createMcpServer({ operationTimeoutMs: 9 })).to.throw(
      'Invalid MCP operation timeout',
    );
  });

  it('rejects invalid root grants before starting the MCP transport', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'docblocks-mcp-invalid-root-'));
    const server = createMcpServer({ readRoots: [join(parent, 'missing')] });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startTransport = serverTransport.start.bind(serverTransport);
    let transportStarted = false;
    serverTransport.start = async () => {
      transportStarted = true;
      await startTransport();
    };
    try {
      // Root resolution may reject before a consumer calls connect; the server
      // must retain that failure without publishing an unhandled rejection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      let caught: unknown;
      try {
        await server.connect(serverTransport);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(Error);
      expect(transportStarted).to.equal(false);
    } finally {
      await server.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects artifact-store startup failures before starting the MCP transport', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'docblocks-mcp-invalid-artifacts-'));
    const missing = join(parent, 'missing');
    const environmentKeys = ['TMPDIR', 'TMP', 'TEMP'] as const;
    const previous = environmentKeys.map((key) => [key, process.env[key]] as const);
    const server = (() => {
      try {
        for (const key of environmentKeys) process.env[key] = missing;
        return createMcpServer();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    })();

    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startTransport = serverTransport.start.bind(serverTransport);
    let transportStarted = false;
    serverTransport.start = async () => {
      transportStarted = true;
      await startTransport();
    };
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      let caught: unknown;
      try {
        await server.connect(serverTransport);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(Error);
      expect(transportStarted).to.equal(false);
    } finally {
      await server.close().catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function zipCompressionMethods(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const methods: number[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    methods.push(view.getUint16(offset + 8, true));
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  if (methods.length === 0) throw new Error('Expected at least one ZIP local-file record');
  return methods;
}

function readableRootId(value: unknown): string {
  if (!Array.isArray(value)) throw new Error('Expected root descriptors');
  const root = value.find(
    (entry): entry is { id: string; read: true } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      (entry as { read?: unknown }).read === true,
  );
  if (!root) throw new Error('Expected readable root');
  return root.id;
}
