import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flattenBlocks, validateMarkdownSource } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { MarkdownRenderer } from '@bendyline/squisq-react';
import { WELCOME_DOCUMENT_CONTENT } from '../src/DocBlocksShell/welcome-document.js';

const MARKETING_URLS = [
  'https://docblocks.com/desktop/',
  'https://docblocks.com/vscode/',
  'https://docblocks.com/cli/',
  'https://docblocks.com/formats/',
  'https://docblocks.com/docs/',
] as const;

describe('welcome document', () => {
  it('uses valid, diverse presentation templates and a complete value-proposition diagram', () => {
    const result = validateMarkdownSource(WELCOME_DOCUMENT_CONTENT);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.doc.frontmatter?.['squisq-cover-slide']).to.equal(false);
    expect(result.doc.themeId).to.equal('warm-earth');

    const blocks = flattenBlocks(result.doc.blocks);
    const templates = new Set(blocks.map((block) => block.template));
    expect(templates).to.include.members([
      'title',
      'factCard',
      'diagram',
      'content',
      'list',
      'twoColumn',
      'quote',
    ]);

    const diagram = blocks.find((block) => block.template === 'diagram');
    const nodes = diagram?.templateData?.nodes as Array<{ label?: string }> | undefined;
    const edges = diagram?.templateData?.edges as
      | Array<{ source?: string; target?: string }>
      | undefined;
    expect(nodes?.map((node) => node.label)).to.deep.equal([
      'Markdown',
      'Pages',
      'Documents',
      'Slideshows',
      'Video',
    ]);
    expect(edges).to.have.length(4);
  });

  it('renders every marketing link in a safe new tab', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      const markdown = parseMarkdown(WELCOME_DOCUMENT_CONTENT);
      await act(async () => {
        root.render(createElement(MarkdownRenderer, { nodes: markdown.children }));
      });

      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).filter((link) =>
        MARKETING_URLS.includes(link.href as (typeof MARKETING_URLS)[number]),
      );
      expect(links.map((link) => link.href)).to.have.members([...MARKETING_URLS]);
      for (const link of links) {
        expect(link.target).to.equal('_blank');
        expect(link.rel.split(/\s+/)).to.include.members(['noopener', 'noreferrer']);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
