import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  parseConversionResult,
  parseInspectionResult,
  type ArtifactRef,
  type ConversionResult,
} from '@bendyline/docblocks/mcp';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const EXACT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
const EXACT_PNG_SHA256 = createHash('sha256').update(EXACT_PNG).digest('hex');
const ASSET_PATH = 'media/exact-pixel.png';
const ARCHIVE_LIMITS = {
  maxEntries: 2_048,
  maxEntryUncompressedBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
} as const;

describe('MCP artifact media round-trips through linked Office formats', function () {
  this.timeout(60_000);

  let harness: McpHarness;
  let bundleArtifact: ArtifactRef;

  before(async () => {
    harness = await startMcpHarness();
    await writeFile(join(harness.tmpDir, 'exact-pixel.png'), EXACT_PNG);

    const roots = await callTool(harness.client, 'list_roots', {});
    expect(roots.isError, roots.text).to.equal(false);
    const entries = roots.structuredContent?.roots;
    expect(entries).to.be.an('array');
    if (!Array.isArray(entries)) throw new Error('Expected MCP root descriptors');
    const readable = entries.find(
      (entry): entry is { id: string; read: true } =>
        isRecord(entry) && typeof entry.id === 'string' && entry.read === true,
    );
    if (!readable) throw new Error('Expected a readable opaque MCP root');

    const bundled = await callTool(harness.client, 'create_document_bundle', {
      source: {
        kind: 'bundle',
        markdown: `# Exact media\n\n![Exact pixel](${ASSET_PATH})\n`,
        name: 'exact-media.md',
        assets: [
          {
            path: ASSET_PATH,
            source: { kind: 'file', rootId: readable.id, path: 'exact-pixel.png' },
            mimeType: 'image/png',
            altText: 'Exact pixel',
            credit: 'DocBlocks fixture',
            license: 'CC0-1.0',
          },
        ],
      },
    });
    expect(bundled.isError, bundled.text).to.equal(false);
    const result = parseConversionResult(bundled.structuredContent);
    if (!result) throw new Error('Expected a canonical DBK conversion result');
    expect(result).to.include({ sourceFormat: 'md', targetFormat: 'dbk' });
    expect(result.sourceAssets).to.deep.equal([
      {
        path: ASSET_PATH,
        mimeType: 'image/png',
        size: EXACT_PNG.byteLength,
        sha256: EXACT_PNG_SHA256,
        altText: 'Exact pixel',
        credit: 'DocBlocks fixture',
        license: 'CC0-1.0',
      },
    ]);
    bundleArtifact = result.artifact;

    const { zipToContainer } = await import('@bendyline/squisq-formats/container');
    const bundle = await zipToContainer(
      ownedArrayBuffer(await readArtifactBytes(harness.client, bundleArtifact.uri)),
      ARCHIVE_LIMITS,
    );
    await expectExactPng(bundle, ASSET_PATH);
  });

  after(async () => {
    await harness.dispose();
  });

  it('preserves exact PNG bytes through DBK artifact -> DOCX -> linked and canonical imports', async () => {
    const docx = await convertArtifact(harness.client, bundleArtifact.uri, 'docx');
    expect(docx).to.include({
      sourceFormat: 'dbk',
      targetFormat: 'docx',
      fidelity: 'editable-native',
    });
    expect(docx.sourceAssets[0]).to.include({
      path: ASSET_PATH,
      sha256: EXACT_PNG_SHA256,
    });

    const docxBytes = await readArtifactBytes(harness.client, docx.artifact.uri);
    const { docxToContainer } = await import('@bendyline/squisq-formats/docx');
    const linkedImport = await docxToContainer(ownedArrayBuffer(docxBytes), ARCHIVE_LIMITS);
    await expectExactImportedPng(linkedImport);
    await expectCanonicalImport(harness.client, docx.artifact, 'docx');
  });

  it('preserves an exact manifest and PNG bytes through DBK artifact -> PPTX -> canonical reverse import', async () => {
    const pptx = await convertArtifact(harness.client, bundleArtifact.uri, 'pptx');
    expect(pptx).to.include({
      sourceFormat: 'dbk',
      targetFormat: 'pptx',
      fidelity: 'editable-native',
    });
    expect(pptx.sourceAssets).to.deep.equal([
      {
        path: ASSET_PATH,
        mimeType: 'image/png',
        size: EXACT_PNG.byteLength,
        sha256: EXACT_PNG_SHA256,
        altText: 'Exact pixel',
        credit: 'DocBlocks fixture',
        license: 'CC0-1.0',
      },
    ]);

    const pptxBytes = await readArtifactBytes(harness.client, pptx.artifact.uri);
    const { pptxToContainer } = await import('@bendyline/squisq-formats/pptx');
    const linkedImport = await pptxToContainer(ownedArrayBuffer(pptxBytes), ARCHIVE_LIMITS);
    await expectExactImportedPng(linkedImport);
    await expectCanonicalImport(harness.client, pptx.artifact, 'pptx');
  });
});

async function convertArtifact(
  client: Client,
  artifactUri: string,
  format: 'docx' | 'pptx',
): Promise<ConversionResult> {
  const converted = await callTool(client, 'convert_document', {
    source: { kind: 'artifact', uri: artifactUri },
    targets: [{ format, fidelity: 'editable-native' }],
  });
  expect(converted.isError, converted.text).to.equal(false);
  const results = converted.structuredContent?.results;
  expect(results).to.be.an('array').with.length(1);
  if (!Array.isArray(results)) throw new Error(`Expected one ${format} conversion result`);
  const result = parseConversionResult(results[0]);
  if (!result) throw new Error(`Expected a canonical ${format} conversion result`);
  return result;
}

async function expectCanonicalImport(
  client: Client,
  artifact: ArtifactRef,
  sourceFormat: 'docx' | 'pptx',
): Promise<void> {
  const inspected = await callTool(client, 'inspect_document', {
    source: { kind: 'artifact', uri: artifact.uri },
  });
  expect(inspected.isError, inspected.text).to.equal(false);
  const inspection = parseInspectionResult(inspected.structuredContent);
  if (!inspection) throw new Error(`Expected canonical ${sourceFormat} inspection`);
  expect(inspection.sourceFormat).to.equal(sourceFormat);
  expect(inspection.assets).to.have.length(1);
  expect(inspection.assets[0]).to.include({
    mimeType: 'image/png',
    size: EXACT_PNG.byteLength,
    sha256: EXACT_PNG_SHA256,
  });

  const imported = await callTool(client, 'convert_document', {
    source: { kind: 'artifact', uri: artifact.uri },
    targets: [{ format: 'dbk', fidelity: 'semantic' }],
  });
  expect(imported.isError, imported.text).to.equal(false);
  const results = imported.structuredContent?.results;
  expect(results).to.be.an('array').with.length(1);
  if (!Array.isArray(results)) throw new Error(`Expected one canonical ${sourceFormat} import`);
  const result = parseConversionResult(results[0]);
  if (!result) throw new Error(`Expected canonical ${sourceFormat}-to-DBK result`);
  expect(result).to.include({
    sourceFormat,
    targetFormat: 'dbk',
    fidelity: 'semantic',
  });
  expect(result.sourceAssets).to.have.length(1);
  expect(result.sourceAssets[0]).to.include({
    mimeType: 'image/png',
    size: EXACT_PNG.byteLength,
    sha256: EXACT_PNG_SHA256,
  });

  const { zipToContainer } = await import('@bendyline/squisq-formats/container');
  const canonicalBundle = await zipToContainer(
    ownedArrayBuffer(await readArtifactBytes(client, result.artifact.uri)),
    ARCHIVE_LIMITS,
  );
  await expectExactImportedPng(canonicalBundle);
}

async function expectExactImportedPng(container: ContentContainer): Promise<void> {
  const imageEntries = (await container.listFiles()).filter((entry) =>
    entry.mimeType.startsWith('image/'),
  );
  expect(imageEntries).to.have.length(1);
  await expectExactPng(container, imageEntries[0]!.path);
}

async function expectExactPng(container: ContentContainer, path: string): Promise<void> {
  const bytes = await container.readFile(path);
  expect(bytes, `missing ${path}`).to.not.equal(null);
  expect(Buffer.from(bytes ?? new ArrayBuffer(0))).to.deep.equal(EXACT_PNG);
}

async function readArtifactBytes(client: Client, uri: string): Promise<Uint8Array> {
  const resource = await client.readResource({ uri });
  expect(resource.contents).to.have.length(1);
  const content = resource.contents[0];
  if (!content || !('blob' in content))
    throw new Error(`Expected binary artifact resource: ${uri}`);
  return Buffer.from(content.blob, 'base64');
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
