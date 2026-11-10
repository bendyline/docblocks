import { expect } from 'chai';
import { MARKDOWN_SHAPE_EXAMPLES, markdownShapeSummary } from '@bendyline/squisq/doc';
import { SHAPE_INSTRUCTION_GUIDANCE } from '../src/mcp/shape-guidance.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP drawn-list guidance', () => {
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('keeps the fixed instruction sentence true to the linked Squisq guide', () => {
    // The sentence is written without loading Squisq; every claim in it must
    // be one the linked guide makes.
    const summary = markdownShapeSummary();
    expect(summary).to.include('one list of 2–6 short items');
    expect(SHAPE_INSTRUCTION_GUIDANCE).to.include('one list of 2–6 short items');
    for (const [cue, drawn] of [
      ['a numbered list', 'steps'],
      ['`Label: detail` items', 'cards'],
      ['`Figure: what it measures` items', 'key numbers'],
    ]) {
      expect(SHAPE_INSTRUCTION_GUIDANCE).to.include(`${cue} as ${drawn}`);
      expect(MARKDOWN_SHAPE_EXAMPLES.some((example) => example.brief[0] === cue)).to.equal(true);
      expect(summary).to.include(`${cue} → ${drawn}`);
    }
    expect(harness.client.getInstructions()).to.include(SHAPE_INSTRUCTION_GUIDANCE);
  });

  it('describes a template that draws a list with the slide it draws', async () => {
    const matrix = await callTool(harness.client, 'describe_template', { templateId: 'matrix' });
    expect(matrix.isError, matrix.text).to.equal(false);
    const example = String(matrix.structuredContent?.annotationExample);
    expect(example).to.match(
      /^# The effort and impact matrix \{\[matrix xAxis="Effort" yAxis="Impact"\]\}/u,
    );
    expect(example.split('\n').filter((line) => line.startsWith('- '))).to.have.length(4);
    // A template with ordinary inputs keeps its one-line annotation example.
    const quote = await callTool(harness.client, 'describe_template', { templateId: 'quote' });
    expect(String(quote.structuredContent?.annotationExample)).to.match(/^# Heading \{\[quote/u);
  });

  it('leaves the rule out for a target that keeps lists as lists', async () => {
    const pptx = await callTool(harness.client, 'get_authoring_context', { targetFormat: 'pptx' });
    expect(pptx.text).to.include('is drawn as a picture of how they relate');
    const docx = await callTool(harness.client, 'get_authoring_context', { targetFormat: 'docx' });
    expect(docx.isError, docx.text).to.equal(false);
    expect(docx.text).to.not.include('is drawn as a picture of how they relate');
  });

  it('reports a shape an author asked for and will not get', async () => {
    const result = await callTool(harness.client, 'inspect_document', {
      source: {
        kind: 'markdown',
        name: 'unmet.md',
        markdown:
          '# Effort against impact {[matrix]}\n\n- Quick wins: guided setup\n- Big bets: permissions redesign\n- Fill-ins: copy fixes\n\n# The water cycle {[cycle]}\n\n- Evaporation: the sun lifts water\n- Condensation: vapour cools\n- Precipitation: rain falls',
      },
    });
    expect(result.isError, result.text).to.equal(false);
    const diagnostics = (result.structuredContent?.diagnostics ?? []) as Array<{
      code: string;
      severity: string;
      message: string;
      remediation: string | null;
      location: { blockId?: string } | null;
    }>;
    const unmet = diagnostics.filter((diagnostic) => diagnostic.code === 'template-shape-unmet');
    expect(unmet).to.have.length(1);
    expect(unmet[0]).to.include({ severity: 'warning' });
    expect(unmet[0]!.message).to.include('asks for matrix but is drawn as cards');
    expect(unmet[0]!.message).to.include('exactly four items and this has 3');
    expect(unmet[0]!.remediation).to.include('describe_template');
    expect(unmet[0]!.location?.blockId).to.equal('effort-against-impact');
  });

  it('puts the rule in the presentation prompt', async () => {
    const prompt = await harness.client.getPrompt({
      name: 'create-presentation',
      arguments: { topic: 'How rain is made' },
    });
    const text = prompt.messages
      .map((message) => (message.content as { text?: string }).text)
      .join('\n');
    expect(text).to.include('a numbered list → steps');
    expect(text).to.include('Only a list that is the whole body is drawn');
  });
});
