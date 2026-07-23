import { expect } from 'chai';
import { MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP linked template recommendations', () => {
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('uses linked Squisq content profiles for each bounded block', async () => {
    const result = await callTool(harness.client, 'recommend_templates', {
      source: {
        kind: 'markdown',
        name: 'recommend.md',
        markdown:
          '# Recommendations\n\n## Metrics\n\n| Metric | Value |\n| --- | --- |\n| Growth | 42% |\n\n## Quote\n\n> Make it visible.',
      },
      candidateTemplateIds: ['dataTable', 'comparisonBar', 'quote', 'title'],
      maxBlocks: 10,
    });

    expect(result.isError).to.not.equal(true);
    const payload = result.structuredContent as {
      recommendations: Array<{
        profile: { hasTable: boolean; hasBlockquote: boolean };
        recommendedTemplateIds: string[];
      }>;
      totalBlocks: number;
      truncated: boolean;
    };
    expect(payload.totalBlocks).to.be.greaterThan(0);
    expect(payload.truncated).to.equal(false);
    expect(
      payload.recommendations.some(
        (entry) => entry.profile.hasTable && entry.recommendedTemplateIds.includes('dataTable'),
      ),
    ).to.equal(true);
    expect(
      payload.recommendations.some(
        (entry) => entry.profile.hasBlockquote && entry.recommendedTemplateIds.includes('quote'),
      ),
    ).to.equal(true);
  });

  it('returns optional focused authoring details without imposing a writing workflow', async () => {
    const result = await callTool(harness.client, 'get_authoring_context', {
      targetFormat: 'pptx',
      goal: 'content-first',
      source: {
        kind: 'markdown',
        name: 'context.md',
        markdown: '# Overview\n\nComplete operational detail that must remain visible.',
      },
    });

    expect(result.isError, result.text).to.equal(false);
    const payload = result.structuredContent as {
      defaultTemplateId: string;
      defaultFidelity: string;
      workflow: string[];
      syntax: { headingAnnotation: string; standaloneWarning: string };
      formats: Array<{ id: string }>;
      templates: Array<{
        id: string;
        bodyPolicy: string;
        safeForContentFirst: boolean;
        annotationExample: string;
      }>;
      recommendations: Array<{ recommendedTemplateIds: string[] }>;
    };
    expect(payload.defaultTemplateId).to.equal('content');
    expect(payload.defaultFidelity).to.equal('editable-native');
    expect(payload.formats.map(({ id }) => id)).to.deep.equal(['pptx']);
    expect(payload.workflow[0]).to.include('list_roots before drafting');
    expect(payload.workflow[0]).to.include('--allow-write');
    expect(payload.workflow[0]).to.include('do not fall back');
    expect(
      payload.workflow.some((step) => step.includes('unstructured text is still accepted')),
    ).to.equal(true);
    expect(
      payload.workflow.some((step) => step.includes('Pass Markdown directly to convert_document')),
    ).to.equal(true);
    expect(payload.workflow.join(' ')).not.to.include('closed evidence set');
    expect(payload.workflow.join(' ')).not.to.include('word');
    expect(payload.workflow.join(' ')).not.to.include('validate_document');
    expect(payload.syntax.headingAnnotation).to.equal('# Heading {[content]}');
    expect(payload.syntax.standaloneWarning).to.include('heading-less block');
    expect(payload.templates.find((entry) => entry.id === 'content')).to.include({
      bodyPolicy: 'complete',
      safeForContentFirst: true,
    });
    expect(payload.templates.map(({ id }) => id)).to.include.members([
      'title',
      'sectionHeader',
      'statHighlight',
      'quote',
    ]);
    expect(payload.templates.length).to.be.lessThan(27);
    expect(payload.templates.every((entry) => entry.annotationExample.startsWith('# '))).to.equal(
      true,
    );
    expect(payload.recommendations[0]?.recommendedTemplateIds[0]).to.equal('content');
    expect(result.text).to.include('DocBlocks authoring contract: pptx, content-first');
    expect(result.text).to.include('Optional example: # Heading {[statHighlight');
    expect(result.text).to.include('intentionally focused');
    expect(result.text).to.include('docblocks://authoring-guide');
    expect(result.text.length).to.be.lessThan(4_000);
    expect(JSON.stringify(payload).length).to.be.lessThan(12_000);
  });

  it('keeps editable PowerPoint as the default even for visual-polish discovery', async () => {
    const result = await callTool(harness.client, 'get_authoring_context', {
      targetFormat: 'pptx',
      goal: 'visual-polish',
    });

    expect(result.isError, result.text).to.equal(false);
    expect(result.structuredContent?.defaultFidelity).to.equal('editable-native');
  });

  it('explains how to restore durable output when no roots are configured', async () => {
    const restricted = await startMcpHarness({ readRoots: [], writeRoots: [] });
    try {
      const result = await callTool(restricted.client, 'list_roots', {});
      expect(result.isError, result.text).to.equal(false);
      expect(result.structuredContent).to.deep.equal({ roots: [] });
      expect(result.text).to.include('Durable file output is unavailable');
      expect(result.text).to.include('--allow-write');
      expect(result.text).to.include('Do not fall back to a shell or CLI converter');
    } finally {
      await restricted.dispose();
    }
  });

  it('warns when configured roots are read-only', async () => {
    const restricted = await startMcpHarness({ writeRoots: [] });
    try {
      const result = await callTool(restricted.client, 'list_roots', {});
      expect(result.isError, result.text).to.equal(false);
      const roots = result.structuredContent?.roots;
      expect(roots).to.be.an('array').with.length(1);
      if (!Array.isArray(roots)) throw new Error('Expected root descriptors');
      expect(roots[0]).to.deep.include({ read: true, write: false });
      expect(result.text).to.include('No returned root is write-enabled');
      expect(result.text).to.include('--allow-write');
    } finally {
      await restricted.dispose();
    }
  });

  it('bounds source-controlled block titles in recommendation output', async () => {
    const result = await callTool(harness.client, 'recommend_templates', {
      source: {
        kind: 'markdown',
        name: 'long-title.md',
        markdown: `# ${'T'.repeat(MCP_WIRE_LIMITS.labelCharacters + 200)}\n\nBody`,
      },
      maxBlocks: 10,
    });

    expect(result.isError, result.text).to.equal(false);
    const recommendations = result.structuredContent?.recommendations;
    if (!Array.isArray(recommendations)) throw new Error('Expected recommendations');
    const title = (recommendations[0] as { title?: unknown } | undefined)?.title;
    expect(title).to.be.a('string').with.length(MCP_WIRE_LIMITS.labelCharacters);
  });
});
