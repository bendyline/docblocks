import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP artifact-native document revision', function () {
  this.timeout(20_000);

  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('replaces selected blocks immutably while preserving ids, child blocks, and assets', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
      'utf8',
    );
    await writeFile(join(harness.tmpDir, 'figure.svg'), svg);
    const roots = requireRecord(
      (await callTool(harness.client, 'list_roots', {})).structuredContent,
    ).roots as Array<{ id: string }>;
    const rootId = roots[0]?.id;
    if (!rootId) throw new Error('Expected a readable harness root');

    const parent = await createBundle(harness, {
      markdown: `# Section {[content]}

Old parent body with ![Figure](media/figure.svg).

## Child Slide {[content]}

Child body must survive a parent replacement.

# Tail {[content]}

Old tail body.
`,
      assets: [
        {
          path: 'media/figure.svg',
          source: { kind: 'file', rootId, path: 'figure.svg' },
          mimeType: 'image/svg+xml',
          altText: 'A red square',
          credit: null,
          license: null,
        },
      ],
    });

    const revised = await callTool(harness.client, 'revise_document', {
      artifactUri: parent.uri,
      expectedSha256: parent.sha256,
      edits: [
        {
          kind: 'replace_block',
          blockId: 'section',
          markdown: '# Renamed Section {[content]}\n\nNew parent body.',
        },
        {
          kind: 'replace_block',
          blockId: 'tail',
          markdown: '# Tail\n\nNew tail body with more detail.',
        },
      ],
    });
    expect(revised.isError).to.equal(false, revised.text);
    const result = requireRecord(revised.structuredContent);
    expect(result).to.include({ version: 1, kind: 'revision' });
    const parentArtifact = requireRecord(result.parentArtifact);
    const artifact = requireRecord(result.artifact);
    expect(parentArtifact).to.include({ uri: parent.uri, sha256: parent.sha256 });
    expect(artifact.format).to.equal('dbk');
    expect(artifact.uri).to.not.equal(parent.uri);
    const edits = result.edits as Array<{
      kind: string;
      blockId: string;
      beforeSha256: string;
      afterSha256: string;
    }>;
    expect(edits.map(({ kind, blockId }) => ({ kind, blockId }))).to.deep.equal([
      { kind: 'replace_block', blockId: 'section' },
      { kind: 'replace_block', blockId: 'tail' },
    ]);
    expect(edits[0]?.beforeSha256).to.equal(
      sha256('# Section {[content]}\n\nOld parent body with ![Figure](media/figure.svg).\n\n'),
    );
    expect(edits[1]?.beforeSha256).to.equal(sha256('# Tail {[content]}\n\nOld tail body.\n'));
    for (const edit of edits) {
      expect(edit.afterSha256).to.match(/^[a-f0-9]{64}$/u);
      expect(edit.afterSha256).to.not.equal(edit.beforeSha256);
    }

    const [parentInspection, revisedInspection] = await Promise.all([
      inspectArtifact(harness, parent.uri),
      inspectArtifact(harness, String(artifact.uri)),
    ]);
    expect(blockText(parentInspection, 'section')).to.include('Old parent body');
    expect(blockText(revisedInspection, 'section')).to.include('New parent body');
    expect(blockText(revisedInspection, 'section')).to.not.include('Old parent body');
    expect(blockText(revisedInspection, 'child-slide')).to.include('Child body must survive');
    expect(blockText(revisedInspection, 'tail')).to.include('New tail body');
    expect(revisedInspection.assets).to.deep.equal(parentInspection.assets);
    expect(
      (revisedInspection.outline as Array<{ id: string; title: string }>).find(
        (entry) => entry.id === 'section',
      ),
    ).to.include({ id: 'section', title: 'Renamed Section' });
  });

  it('rejects a stale or incorrect parent hash as a conflict', async () => {
    const parent = await createBundle(harness, {
      markdown: '# Slide {[content]}\n\nOriginal body.\n',
      assets: [],
    });
    const response = await callTool(harness.client, 'revise_document', {
      artifactUri: parent.uri,
      expectedSha256: '0'.repeat(64),
      edits: [
        {
          kind: 'replace_block',
          blockId: 'slide',
          markdown: '# Slide {[content]}\n\nReplacement body.',
        },
      ],
    });
    expect(response.isError).to.equal(true);
    const error = requireRecord(requireRecord(response.structuredContent).error);
    expect(error.code).to.equal('conflict');
    expect(error.message).to.include(parent.sha256);
    expect(error.hint).to.include(parent.sha256);
  });

  it('rejects replacement fragments that contain nested headings or change block ids', async () => {
    const parent = await createBundle(harness, {
      markdown: '# Slide {[content]}\n\nOriginal body.\n',
      assets: [],
    });
    const nested = await callTool(harness.client, 'revise_document', {
      artifactUri: parent.uri,
      expectedSha256: parent.sha256,
      edits: [
        {
          kind: 'replace_block',
          blockId: 'slide',
          markdown: '# Slide\n\nReplacement body.\n\n## Unexpected child',
        },
      ],
    });
    expect(nested.isError).to.equal(true);
    expect(requireRecord(requireRecord(nested.structuredContent).error).code).to.equal(
      'invalid-block-replacement',
    );

    const changedId = await callTool(harness.client, 'revise_document', {
      artifactUri: parent.uri,
      expectedSha256: parent.sha256,
      edits: [
        {
          kind: 'replace_block',
          blockId: 'slide',
          markdown: '# Slide {#different-id}\n\nReplacement body.',
        },
      ],
    });
    expect(changedId.isError).to.equal(true);
    expect(requireRecord(requireRecord(changedId.structuredContent).error).code).to.equal(
      'block-id-change-not-allowed',
    );
  });

  it('requires block ids from the exact parent inspection', async () => {
    const parent = await createBundle(harness, {
      markdown: '# Slide {[content]}\n\nOriginal body.\n',
      assets: [],
    });
    const response = await callTool(harness.client, 'revise_document', {
      artifactUri: parent.uri,
      expectedSha256: parent.sha256,
      edits: [
        {
          kind: 'replace_block',
          blockId: 'invented-slide',
          markdown: '# Slide {[content]}\n\nReplacement body.',
        },
      ],
    });
    expect(response.isError).to.equal(true);
    const error = requireRecord(requireRecord(response.structuredContent).error);
    expect(error.code).to.equal('block-not-found');
    expect(error.hint).to.include('inspect_document');
  });

  it('rejects duplicate edits to the same block in one atomic request', async () => {
    const parent = await createBundle(harness, {
      markdown: '# Slide {[content]}\n\nOriginal body.\n',
      assets: [],
    });
    const edit = {
      kind: 'replace_block',
      blockId: 'slide',
      markdown: '# Slide {[content]}\n\nReplacement body.',
    };
    const response = await callTool(harness.client, 'revise_document', {
      artifactUri: parent.uri,
      expectedSha256: parent.sha256,
      edits: [edit, edit],
    });
    expect(response.isError).to.equal(true);
    expect(requireRecord(requireRecord(response.structuredContent).error).code).to.equal(
      'duplicate-block-edit',
    );
  });
});

async function createBundle(
  harness: McpHarness,
  source: { markdown: string; assets: readonly Record<string, unknown>[] },
): Promise<{ uri: string; sha256: string }> {
  const response = await callTool(harness.client, 'create_document_bundle', {
    source: { kind: 'bundle', name: 'revision-test.md', ...source },
  });
  expect(response.isError).to.equal(false, response.text);
  const artifact = requireRecord(requireRecord(response.structuredContent).artifact);
  return { uri: String(artifact.uri), sha256: String(artifact.sha256) };
}

async function inspectArtifact(harness: McpHarness, uri: string): Promise<Record<string, unknown>> {
  const response = await callTool(harness.client, 'inspect_document', {
    source: { kind: 'artifact', uri },
    maxBlocks: 100,
  });
  expect(response.isError).to.equal(false, response.text);
  return requireRecord(response.structuredContent);
}

function blockText(inspection: Record<string, unknown>, id: string): string {
  const block = (inspection.blocks as Array<{ id: string; text: string }>).find(
    (candidate) => candidate.id === id,
  );
  if (!block) throw new Error(`Missing inspected block ${id}`);
  return block.text;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a record');
  }
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
