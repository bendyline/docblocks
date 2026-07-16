import { expect } from 'chai';
import { parseInspectionResult } from '@bendyline/docblocks/mcp';
import { callTool, startMcpHarness } from './mcp-helpers.js';

describe('MCP detailed inspection pagination', () => {
  it('counts and outlines parent and descendant blocks consistently', async () => {
    const harness = await startMcpHarness();
    try {
      const source = {
        kind: 'markdown',
        markdown: [
          '# Parent',
          '',
          'Parent body words are counted.',
          '',
          '## Child',
          '',
          '| Value |',
          '| --- |',
          '| nested |',
        ].join('\n'),
      };
      const result = await callTool(harness.client, 'inspect_document', {
        source,
        maxBlocks: 10,
      });
      expect(result.isError, result.text).to.equal(false);
      const inspection = parseInspectionResult(result.structuredContent);
      expect(inspection).to.not.equal(null);
      expect(inspection?.statistics.blockCount).to.equal(2);
      expect(inspection?.statistics.wordCount).to.be.greaterThan(1);
      expect(inspection?.blocks).to.have.length(2);
      expect(inspection?.outline.map((entry) => entry.level)).to.deep.equal([1, 2]);
      expect(inspection?.outline.map((entry) => entry.title)).to.deep.equal(['Parent', 'Child']);
    } finally {
      await harness.dispose();
    }
  });

  it('returns cursored block provenance plus bounded table, link, and item details', async () => {
    const harness = await startMcpHarness();
    try {
      const source = {
        kind: 'markdown',
        name: 'details.md',
        markdown: `# First

[Docs](https://example.com/docs)

## Second

| Name | Score |
| --- | ---: |
| Ada | 10 |

## Third

Done.`,
      };
      const first = await callTool(harness.client, 'inspect_document', {
        source,
        maxBlocks: 1,
      });
      expect(first.isError).to.equal(false);
      const firstPage = parseInspectionResult(first.structuredContent);
      expect(firstPage).to.not.equal(null);
      if (!firstPage) throw new Error('Expected first inspection page');
      expect(firstPage).to.include({
        blockOffset: 0,
        nextCursor: 'blocks:1',
        truncated: true,
        detailsTruncated: false,
      });
      expect(firstPage.blocks).to.have.length(1);
      expect(firstPage.blocks[0]?.sourceRange).to.not.equal(null);
      expect(firstPage.tables[0]).to.deep.include({ rowCount: 2, columnCount: 2 });
      expect(firstPage.tables[0]?.headers).to.deep.equal(['Name', 'Score']);
      expect(firstPage.links[0]).to.deep.include({
        text: 'Docs',
        target: 'https://example.com/docs',
      });

      const second = await callTool(harness.client, 'inspect_document', {
        source,
        maxBlocks: 1,
        cursor: firstPage.nextCursor,
      });
      const secondPage = parseInspectionResult(second.structuredContent);
      expect(secondPage).to.not.equal(null);
      expect(secondPage?.blockOffset).to.equal(1);
      expect(secondPage?.blocks[0]?.id).to.not.equal(firstPage.blocks[0]?.id);

      const invalid = await callTool(harness.client, 'inspect_document', {
        source,
        maxBlocks: 1,
        cursor: 'blocks:999',
      });
      expect(invalid.isError).to.equal(true);
      expect(invalid.text).to.include('outside the document');
    } finally {
      await harness.dispose();
    }
  });

  it('returns density preflight diagnostics for visual targets', async () => {
    const harness = await startMcpHarness();
    try {
      const dense = Array.from({ length: 130 }, (_unused, index) => `word${index}`).join(' ');
      const result = await callTool(harness.client, 'validate_document', {
        source: { kind: 'markdown', name: null, markdown: `# Dense\n\n${dense}` },
        targetFormat: 'pptx',
      });
      expect(result.isError).to.equal(false);
      const diagnostics = result.structuredContent?.diagnostics;
      expect(diagnostics).to.be.an('array');
      expect(
        (diagnostics as Array<{ code?: string }>).some(
          (diagnostic) => diagnostic.code === 'content-density-high',
        ),
      ).to.equal(true);
    } finally {
      await harness.dispose();
    }
  });
});
