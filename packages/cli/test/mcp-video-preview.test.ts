import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parsePreviewResult, type PreviewResult } from '@bendyline/docblocks/mcp';
import { registerAgenticTools } from '../src/mcp/agentic-tools.js';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import type { VideoThumbnailExtractor } from '../src/mcp/preview-service.js';

describe('canonical MCP video previews', () => {
  let directory: string;
  let artifacts: ArtifactStore;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'docblocks-mcp-video-preview-test-'));
    artifacts = new ArtifactStore({
      maxArtifactBytes: 4_096,
      maxArtifactTotalBytes: 32_768,
      maxArtifactCount: 16,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 4_096,
    });
    const authority = await McpFileAuthority.create({ readRoots: [directory] });
    const extract: VideoThumbnailExtractor = async (options) => {
      expect(options.signal?.aborted).to.equal(false);
      const source = await readFile(options.videoPath);
      const size = options.sizes[0]!;
      await writeFile(
        join(options.outputDir, `${options.slug}-${size.width}x${size.height}.jpg`),
        Buffer.concat([Buffer.from([0xff, 0xd8]), source, Buffer.from([0xff, 0xd9])]),
      );
    };
    server = new McpServer({ name: 'video-preview-test', version: '0.0.0' });
    registerAgenticTools(server, {
      authority: Promise.resolve(authority),
      artifacts,
      extractVideoThumbnail: extract,
      runOperation: (signal, work) => work(signal),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'video-preview-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await artifacts.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('routes an opaque-root MP4 file through first-frame extraction', async () => {
    const bytes = Buffer.from('file-video');
    await writeFile(join(directory, 'recording.mp4'), bytes);
    const authority = await McpFileAuthority.create({ readRoots: [directory] });
    const root = authority.listRoots()[0];
    if (!root) throw new Error('Expected a readable root');

    const result = await callPreview({
      kind: 'file',
      rootId: root.id,
      path: 'recording.mp4',
      format: null,
    });

    expect(result.preview.items[0]!.artifact).to.include({
      format: 'jpg',
      mimeType: 'image/jpeg',
      suggestedFilename: 'recording-preview-001.jpg',
    });
    expect(await artifacts.read(result.preview.items[0]!.artifact.uri)).to.deep.equal(
      Buffer.concat([Buffer.from([0xff, 0xd8]), bytes, Buffer.from([0xff, 0xd9])]),
    );
    expect(result.resourceLink).to.deep.include({
      type: 'resource_link',
      uri: result.preview.items[0]!.artifact.uri,
      mimeType: 'image/jpeg',
    });
  });

  it('routes an MP4 artifact without exposing or materializing a physical path', async () => {
    const bytes = Buffer.from('artifact-video');
    const input = await artifacts.put({
      bytes,
      format: 'mp4',
      mimeType: 'video/mp4',
      suggestedFilename: 'rendered-show.mp4',
    });

    const result = await callPreview({ kind: 'artifact', uri: input.uri });

    expect(result.preview).to.include({
      sourceFormat: 'mp4',
      previewBasis: 'native-extracted',
      totalItems: 1,
      truncated: false,
    });
    expect(result.preview.items[0]).to.include({
      kind: 'frame',
      index: 0,
      width: 1_280,
      height: 720,
    });
    expect(result.preview.items[0]!.artifact).to.include({
      sourceSha256: input.sha256,
      suggestedFilename: 'rendered-show-preview-001.jpg',
    });
    expect(result.resourceLink.uri).to.equal(result.preview.items[0]!.artifact.uri);
  });

  it('routes an opaque-root GIF file through first-frame extraction', async () => {
    const bytes = Buffer.from('file-animation');
    await writeFile(join(directory, 'animation.gif'), bytes);
    const authority = await McpFileAuthority.create({ readRoots: [directory] });
    const root = authority.listRoots()[0];
    if (!root) throw new Error('Expected a readable root');

    const result = await callPreview({
      kind: 'file',
      rootId: root.id,
      path: 'animation.gif',
      format: null,
    });

    expect(result.preview).to.include({
      sourceFormat: 'gif',
      previewBasis: 'native-extracted',
      totalItems: 1,
    });
    expect(result.preview.items[0]!.artifact).to.include({
      sourceFormat: 'gif',
      suggestedFilename: 'animation-preview-001.jpg',
    });
    expect(await artifacts.read(result.preview.items[0]!.artifact.uri)).to.deep.equal(
      Buffer.concat([Buffer.from([0xff, 0xd8]), bytes, Buffer.from([0xff, 0xd9])]),
    );
  });

  it('previews a generated GIF artifact without requiring filesystem authority', async () => {
    const bytes = Buffer.from('artifact-animation');
    const input = await artifacts.put({
      bytes,
      format: 'gif',
      mimeType: 'image/gif',
      suggestedFilename: 'animated-story.gif',
    });

    const result = await callPreview({ kind: 'artifact', uri: input.uri });

    expect(result.preview).to.include({
      sourceFormat: 'gif',
      previewBasis: 'native-extracted',
      totalItems: 1,
      truncated: false,
    });
    expect(result.preview.items[0]!.artifact).to.include({
      sourceFormat: 'gif',
      sourceSha256: input.sha256,
      suggestedFilename: 'animated-story-preview-001.jpg',
    });
  });

  async function callPreview(
    source: Record<string, unknown>,
  ): Promise<{ preview: PreviewResult; resourceLink: Record<string, unknown> }> {
    const response = await client.callTool({
      name: 'preview_document',
      arguments: { source },
    });
    expect((response as { isError?: boolean }).isError).to.not.equal(true);
    const envelope = response.structuredContent as
      | { kind?: unknown; result?: unknown; error?: unknown }
      | undefined;
    expect(envelope).to.include({ kind: 'success', error: null });
    const preview = parsePreviewResult(envelope?.result);
    if (!preview) throw new Error('Expected an exact canonical preview result');
    const resourceLink = (response.content as Array<Record<string, unknown>>).find(
      (entry) => entry.type === 'resource_link',
    );
    if (!resourceLink) throw new Error('Expected a preview artifact resource link');
    return { preview, resourceLink };
  }
});
