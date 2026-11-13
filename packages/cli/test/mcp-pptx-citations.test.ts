import { expect } from 'chai';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import { citationsToFootnotes, preparePptxSource } from '../src/mcp/pptx-source.js';

// A Gezel PowerPoint deck cited "(source: tasks/4/sources/notes.md)" after
// every bullet, and the converter copied each one onto the slide. Citations
// become footnotes, which the deck exporter writes as speaker notes.

function nodesOfType(markdown: MarkdownDocument, type: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.type === type) found.push(record);
    if (Array.isArray(record.children)) record.children.forEach(visit);
  };
  markdown.children.forEach(visit);
  return found;
}

function textOf(markdown: MarkdownDocument): string {
  return nodesOfType(markdown, 'text')
    .map((node) => String(node.value))
    .join('');
}

describe('PowerPoint citations become speaker-note footnotes', () => {
  it('moves each citation out of the text into one shared footnote', () => {
    const markdown = parseMarkdown(
      [
        '# Origins',
        '',
        '- A legend credits an emperor (source: tasks/4/sources/notes.md).',
        '- Tea spread to Japan (source: tasks/4/sources/japan.md).',
        '',
        '# Today',
        '',
        '| Fact | Note |',
        '| --- | --- |',
        '| Most drunk after water | Widely reported (source: tasks/4/sources/notes.md) |',
        '',
      ].join('\n'),
    );
    const out = citationsToFootnotes(markdown);

    expect(textOf(out)).to.not.include('(source:');
    expect(textOf(out)).to.include('A legend credits an emperor.');
    const references = nodesOfType(out, 'footnoteReference').map((node) => node.identifier);
    expect(references).to.deep.equal(['source-1', 'source-2', 'source-1']);
    const definitions = out.children.filter((node) => node.type === 'footnoteDefinition');
    expect(definitions.map((node) => (node as { identifier: string }).identifier)).to.deep.equal([
      'source-1',
      'source-2',
    ]);
    expect(textOf({ type: 'document', children: definitions })).to.equal(
      'Source: tasks/4/sources/notes.mdSource: tasks/4/sources/japan.md',
    );
  });

  it('leaves code, links and existing footnotes alone', () => {
    const markdown = parseMarkdown(
      [
        '# Notes',
        '',
        'Write `(source: path)` after a claim.[^source-1] See [a (source: x) link](https://example.com).',
        '',
        '[^source-1]: An authored footnote.',
        '',
      ].join('\n'),
    );
    expect(citationsToFootnotes(markdown)).to.equal(markdown);
  });

  it('keeps one slide per heading after the citations move', () => {
    const markdown = parseMarkdown(
      '# One\n\n- Claim (source: a.md).\n\n# Two\n\n- Another (sources: a.md; b.md).\n',
    );
    const { doc, markdownDoc } = preparePptxSource(markdown, 'h1', true);
    expect(doc.blocks).to.have.length(2);
    expect(textOf(markdownDoc)).to.include('Sources: a.md; b.md');
  });
});
