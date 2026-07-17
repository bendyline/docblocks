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

  it('returns a self-contained content-first authoring context in one call', async () => {
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
    expect(payload.workflow.some((step) => step.includes('revise_document'))).to.equal(true);
    expect(payload.syntax.headingAnnotation).to.equal('# Heading {[content]}');
    expect(payload.syntax.standaloneWarning).to.include('heading-less block');
    expect(payload.templates.find((entry) => entry.id === 'content')).to.include({
      bodyPolicy: 'complete',
      safeForContentFirst: true,
    });
    expect(payload.templates.find((entry) => entry.id === 'sectionHeader')?.bodyPolicy).to.equal(
      'ignored',
    );
    expect(payload.templates.every((entry) => entry.annotationExample.startsWith('# '))).to.equal(
      true,
    );
    expect(payload.recommendations[0]?.recommendedTemplateIds[0]).to.equal('content');
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
