/**
 * Study cards kept with a document's sections ({[flashcard]} / {[quiz]}
 * Squisq accessory blocks) through MCP: inspection reads the document
 * without them and says what cards it holds, and the authoring guide
 * teaches an agent to write them.
 */
import { expect } from 'chai';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const DOC = [
  '# Plants',
  '',
  'Leaves catch the light.',
  '',
  '## Where does it happen? {[quiz origin=ai passage=abc-1]}',
  '',
  '- [ ] In the roots',
  '- [x] In the leaves',
  '',
  '## What do roots do? {[flashcard]}',
  '',
  'They drink water.',
  '',
  '## Broken? {[quiz]}',
  '',
  '- [ ] No tick',
  '- [ ] Anywhere',
  '',
  '## Watering',
  '',
  'Water in the morning.',
].join('\n');

interface Inspection {
  statistics: { blockCount: number; wordCount: number };
  outline: Array<{ title: string }>;
  blocks: Array<{ text: string }>;
  diagnostics: Array<{
    code: string;
    severity: string;
    message: string;
    remediation: string | null;
  }>;
}

describe('MCP study cards', () => {
  let harness: McpHarness;
  beforeEach(async () => {
    harness = await startMcpHarness();
  });
  afterEach(async () => harness.dispose());

  it('inspects the document without its cards, and says what cards it holds', async () => {
    const result = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'markdown', name: 'plants.md', markdown: DOC },
    });
    expect(result.isError).to.not.equal(true);
    const inspection = result.structuredContent as Inspection;
    expect(inspection.outline.map((entry) => entry.title)).to.deep.equal(['Plants', 'Watering']);
    expect(inspection.blocks.map((block) => block.text).join(' ')).to.not.contain('roots');
    const summary = inspection.diagnostics.find((item) => item.code === 'study-cards');
    expect(summary).to.include({ severity: 'info' });
    expect(summary!.message).to.contain(
      '3 study cards in 1 section: 1 flashcard, 2 quiz questions.',
    );
    expect(summary!.message).to.contain('1 card was written by AI before its section changed.');
    expect(summary!.message).to.contain('1 card cannot be studied as written.');
    const problem = inspection.diagnostics.find((item) => item.code === 'study-quiz-no-correct');
    expect(problem).to.include({ severity: 'warning' });
  });

  it('says nothing about cards in a document without any', async () => {
    const result = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'markdown', name: 'plain.md', markdown: '# Plain\n\nText.' },
    });
    const inspection = result.structuredContent as Inspection;
    expect(inspection.diagnostics.some((item) => item.code.startsWith('study-'))).to.equal(false);
  });

  it('teaches study cards in the authoring guide', async () => {
    const response = await harness.client.readResource({ uri: 'docblocks://authoring-guide' });
    const guide = JSON.parse((response.contents[0] as { text: string }).text) as {
      workflow: string[];
      studyCards: { rules: string[]; example: string; keptIn: string[] };
    };
    expect(guide.workflow.some((step) => step.includes('studyCards.rules'))).to.equal(true);
    expect(guide.studyCards.rules.join(' ')).to.contain('{[quiz]}');
    expect(guide.studyCards.example).to.contain('- [x]');
    expect(guide.studyCards.keptIn).to.deep.equal(['md', 'dbk']);
  });
});
