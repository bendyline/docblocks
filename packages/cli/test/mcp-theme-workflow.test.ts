import { expect } from 'chai';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP inferred-theme workflow', function () {
  this.timeout(30_000);
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('embeds an inferred Office theme into a reusable DBK artifact', async () => {
    const reference = await callTool(harness.client, 'convert_document', {
      source: { kind: 'markdown', markdown: '# Brand reference\n\nBody', name: 'brand.md' },
      themeId: 'documentary',
      targets: [{ format: 'pptx' }],
    });
    expect(reference.isError).to.equal(false);
    const referenceArtifact = (
      reference.structuredContent as {
        results: Array<{ artifact: { uri: string } }>;
      }
    ).results[0]!.artifact;

    const applied = await callTool(harness.client, 'apply_inferred_theme', {
      source: {
        kind: 'markdown',
        markdown: '# Target\n\n## Section\n\nContent to theme.',
        name: 'target.md',
      },
      themeSource: { kind: 'artifact', uri: referenceArtifact.uri },
      inferLayouts: false,
    });
    expect(applied.isError, applied.text).to.equal(false);
    const payload = applied.structuredContent as {
      result: { targetFormat: string; artifact: { uri: string } };
      theme: { id: string; source?: string };
      layoutIds: string[];
      warnings: string[];
    };
    expect(payload.result.targetFormat).to.equal('dbk');
    expect(payload.theme.id).to.match(/^custom-/u);

    const markdownResult = await callTool(harness.client, 'convert_document', {
      source: { kind: 'artifact', uri: payload.result.artifact.uri },
      targets: [{ format: 'md' }],
    });
    expect(markdownResult.isError, markdownResult.text).to.equal(false);
    const markdownArtifact = (
      markdownResult.structuredContent as { results: Array<{ artifact: { uri: string } }> }
    ).results[0]!.artifact;
    const markdownResource = await harness.client.readResource({ uri: markdownArtifact.uri });
    const markdownContent = markdownResource.contents[0];
    if (!markdownContent || !('text' in markdownContent)) throw new Error('Expected Markdown text');
    expect(markdownContent.text).to.contain(`squisq-theme: ${payload.theme.id}`);

    const inspection = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'artifact', uri: payload.result.artifact.uri },
    });
    expect(inspection.isError, inspection.text).to.equal(false);
    const inspected = inspection.structuredContent as {
      theme: { id: string; source: string } | null;
    };
    expect(inspected.theme).to.include({ id: payload.theme.id, source: 'document' });
  });
});
