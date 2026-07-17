import { expect } from 'chai';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP content-first authoring', () => {
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('uses the complete-body content template for ordinary headings', async () => {
    const result = await callTool(harness.client, 'inspect_document', {
      source: {
        kind: 'markdown',
        name: 'draft.md',
        markdown: '# Operational detail\n\nEvery word in this first-pass body must remain visible.',
      },
    });

    expect(result.isError, result.text).to.equal(false);
    const blocks = result.structuredContent?.blocks as
      | Array<{ templateId?: string | null }>
      | undefined;
    expect(blocks?.[0]?.templateId).to.equal('content');
    const diagnostics = result.structuredContent?.diagnostics as
      | Array<{ code?: string }>
      | undefined;
    expect(
      diagnostics?.some((diagnostic) => diagnostic.code === 'rendered-content-omitted'),
    ).to.equal(false);
  });

  it('warns when visual authoring would ignore body prose or create a heading-less block', async () => {
    const result = await callTool(harness.client, 'validate_document', {
      source: {
        kind: 'markdown',
        name: 'surprises.md',
        markdown:
          '# Divider {[sectionHeader]}\n\nThis prose is not rendered by a divider.\n\n' +
          '{[factCard fact="A fact" explanation="Context"]}',
      },
      targetFormat: 'pptx',
    });

    expect(result.isError, result.text).to.equal(false);
    const diagnostics = result.structuredContent?.diagnostics as
      | Array<{ code?: string }>
      | undefined;
    expect(
      diagnostics?.some((diagnostic) => diagnostic.code === 'template-body-not-rendered'),
    ).to.equal(true);
    expect(
      diagnostics?.some((diagnostic) => diagnostic.code === 'standalone-template-block'),
    ).to.equal(true);
  });

  it('flags malformed template annotations that the parser silently survives', async () => {
    const result = await callTool(harness.client, 'validate_document', {
      source: {
        kind: 'markdown',
        name: 'typo.md',
        markdown:
          '# Retention {[comparisonBar leftLabel="Q1" leftValue="66" rightLabel="Q2" rightValue="71" unit="%"}]}\n\nBody.\n\n' +
          '# Unclosed {[content\n\nBody.\n\n' +
          '# Clean {[factCard fact="Braces in {quotes} are fine"]}\n\nBody.',
      },
      targetFormat: 'pptx',
    });

    expect(result.isError, result.text).to.equal(false);
    const diagnostics = result.structuredContent?.diagnostics as
      | Array<{ code?: string; location?: { line?: number } }>
      | undefined;
    const malformed = diagnostics?.filter(
      (diagnostic) => diagnostic.code === 'malformed-template-annotation',
    );
    expect(malformed?.length).to.equal(2);
    expect(malformed?.map((diagnostic) => diagnostic.location?.line)).to.deep.equal([1, 5]);
  });

  it('preserves the MCP content default across the native DBK conversion boundary', async () => {
    const converted = await callTool(harness.client, 'convert_document', {
      source: {
        kind: 'markdown',
        name: 'native-boundary.md',
        markdown: '# Detail\n\nComplete body retained across conversion.',
      },
      targets: [{ format: 'dbk', fidelity: 'semantic' }],
    });
    expect(converted.isError, converted.text).to.equal(false);
    const results = converted.structuredContent?.results as
      | Array<{ artifact?: { uri?: string } }>
      | undefined;
    const uri = results?.[0]?.artifact?.uri;
    expect(uri).to.be.a('string');

    const inspected = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'artifact', uri },
    });
    expect(inspected.isError, inspected.text).to.equal(false);
    const blocks = inspected.structuredContent?.blocks as
      | Array<{ templateId?: string | null; text?: string }>
      | undefined;
    expect(blocks?.[0]?.templateId).to.equal('content');
    expect(blocks?.[0]?.text).to.include('Complete body retained across conversion.');
  });
});
