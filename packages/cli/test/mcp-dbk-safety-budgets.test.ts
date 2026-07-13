import { expect } from 'chai';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import JSZip from 'jszip';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const MCP_DBK_MAX_ENTRIES = 2_048;
const MCP_DBK_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

describe('MCP canonical DBK safety budgets', function () {
  this.timeout(60_000);

  let harness: McpHarness;
  let readRootId: string;

  beforeEach(async () => {
    harness = await startMcpHarness();
    readRootId = await requireReadableRootId(harness.client);
  });

  afterEach(async () => harness.dispose());

  it('rejects an unsafe DBK member path through convert_document', async () => {
    const archive = validDbkArchive();
    archive.file('../outside.txt', 'must not escape');
    await saveArchive(harness, 'unsafe-path.dbk', archive);

    await expectDbkFailure(harness.client, readRootId, 'unsafe-path.dbk', 'unsafe path');
  });

  it('rejects a DBK whose entry count exceeds the MCP budget', async () => {
    const archive = validDbkArchive();
    for (let index = 0; index < MCP_DBK_MAX_ENTRIES; index += 1) {
      archive.file(`assets/entry-${index}.txt`, '');
    }
    await saveArchive(harness, 'too-many-entries.dbk', archive);

    await expectDbkFailure(harness.client, readRootId, 'too-many-entries.dbk', 'limit is 2048');
  });

  it('rejects declared uncompressed content beyond the MCP byte budget before inflating it', async () => {
    const archive = validDbkArchive();
    archive.file('assets/payload.bin', new Uint8Array(1024 * 1024));
    const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    setCentralDirectoryUncompressedSize(
      bytes,
      'assets/payload.bin',
      MCP_DBK_MAX_UNCOMPRESSED_BYTES + 1,
    );
    await writeFile(join(harness.tmpDir, 'too-many-uncompressed-bytes.dbk'), bytes);

    await expectDbkFailure(
      harness.client,
      readRootId,
      'too-many-uncompressed-bytes.dbk',
      'uncompressed content exceeds 104857600 byte limit',
    );
  });

  it('rejects a DBK member that exceeds the compression-ratio budget', async () => {
    const archive = validDbkArchive();
    archive.file('assets/compression-bomb.txt', 'A'.repeat(8 * 1024 * 1024));
    await saveArchive(harness, 'compression-ratio.dbk', archive, 'DEFLATE');

    await expectDbkFailure(
      harness.client,
      readRootId,
      'compression-ratio.dbk',
      'compression-ratio limit',
    );
  });
});

function validDbkArchive(): JSZip {
  const archive = new JSZip();
  archive.file('index.md', '# Safety fixture\n');
  return archive;
}

async function saveArchive(
  harness: McpHarness,
  filename: string,
  archive: JSZip,
  compression: 'STORE' | 'DEFLATE' = 'STORE',
): Promise<void> {
  await writeFile(
    join(harness.tmpDir, filename),
    await archive.generateAsync({
      type: 'nodebuffer',
      compression,
      ...(compression === 'DEFLATE' ? { compressionOptions: { level: 9 } } : {}),
    }),
  );
}

async function expectDbkFailure(
  client: Client,
  rootId: string,
  path: string,
  expectedMessage: string,
): Promise<void> {
  const result = await callTool(client, 'convert_document', {
    source: { kind: 'file', rootId, path, format: 'dbk' },
    targets: [{ format: 'md', fidelity: 'semantic' }],
  });
  expect(result.isError, result.text).to.equal(true);
  const envelope = result.structuredContent as
    | { kind?: unknown; error?: { code?: unknown; message?: unknown } }
    | undefined;
  expect(envelope?.kind).to.equal('error');
  expect(envelope?.error?.code).to.equal('invalid-input');
  expect(String(envelope?.error?.message).toLowerCase()).to.include(expectedMessage.toLowerCase());
}

async function requireReadableRootId(client: Client): Promise<string> {
  const roots = await callTool(client, 'list_roots', {});
  const values = roots.structuredContent?.roots;
  if (!Array.isArray(values)) throw new Error('Expected MCP root descriptors');
  const root = values.find(
    (candidate): candidate is { id: string; read: true } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as { id?: unknown }).id === 'string' &&
      (candidate as { read?: unknown }).read === true,
  );
  if (!root) throw new Error('Expected a readable MCP root');
  return root.id;
}

function setCentralDirectoryUncompressedSize(
  bytes: Buffer,
  filename: string,
  uncompressedSize: number,
): void {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = bytes.indexOf(signature, offset)) !== -1) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryName = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (entryName === filename) {
      bytes.writeUInt32LE(uncompressedSize, offset + 24);
      return;
    }
    offset += 46 + nameLength;
  }
  throw new Error(`Central-directory entry not found: ${filename}`);
}
