import { expect } from 'chai';

import { hasHtmlBlocks, htmlBlocksToMarkdown } from '../src/Ai/draft-html.js';
import { sanitizeGeneratedMarkdown } from '../src/Ai/ai-assistant.js';
import { settleDraft } from '../src/Ai/draft-run.js';

/** Apple's on-device model on an iPad wrote an Add content draft this way. */
const IPAD_REPLY = [
  '<document>',
  '',
  '<section>',
  '',
  '<h2>Naval Warships</h2>',
  '',
  '<p>Naval warships are large, powerful vessels designed for combat and defense at sea.</p>',
  '',
  '<ul>',
  '<li><strong>Destroyers</strong> escort fleets.</li>',
  '<li>Submarines &amp; carriers</li>',
  '</ul>',
  '',
  '</section>',
  '',
  '</document>',
].join('\n');

const IPAD_MARKDOWN = [
  '## Naval Warships',
  '',
  'Naval warships are large, powerful vessels designed for combat and defense at sea.',
  '',
  '- **Destroyers** escort fleets.',
  '',
  '- Submarines & carriers',
].join('\n');

describe('HTML in generated drafts', () => {
  it('rewrites a draft written as HTML elements as Markdown', () => {
    expect(sanitizeGeneratedMarkdown(IPAD_REPLY)).to.equal(IPAD_MARKDOWN);
  });

  it('rewrites a reply cut off before its wrappers closed', () => {
    // The iPad reply above was stopped mid-paragraph, so nothing closed.
    const cut = '<document>\n\n<section>\n\n<h2>Naval Warships</h2>\n\n<p>Naval warships are large';
    expect(sanitizeGeneratedMarkdown(cut)).to.equal(
      '## Naval Warships\n\nNaval warships are large',
    );
  });

  it('settles a finished HTML reply into the Markdown the dialog shows', () => {
    const settled = settleDraft(
      '',
      { text: IPAD_REPLY, finishReason: 'stop' },
      '# Hi\n\n## Ships\n',
      'compose',
    );
    expect(settled.draft).to.equal(IPAD_MARKDOWN);
  });

  it('keeps Markdown blocks between HTML blocks as written', () => {
    const mixed =
      '<h2>Ships</h2>\n\nSome **bold** text with a [link](https://example.com).\n\n<p>More.</p>';
    expect(htmlBlocksToMarkdown(mixed)).to.equal(
      '## Ships\n\nSome **bold** text with a [link](https://example.com).\n\nMore.',
    );
  });

  it('keeps Markdown syntax and citation markers the model wrote inside elements', () => {
    // A model asked for Markdown meant these; escaped, `[1]` is no citation.
    expect(htmlBlocksToMarkdown('<p>Carriers carry **aircraft** [1].</p>')).to.equal(
      'Carriers carry **aircraft** [1].',
    );
  });

  it('keeps escapes that protect text from Squisq math, HTML and tables', () => {
    expect(htmlBlocksToMarkdown('<p>Tickets cost $5 and &lt;b&gt; is a tag.</p>')).to.equal(
      'Tickets cost \\$5 and \\<b> is a tag.',
    );
    expect(
      htmlBlocksToMarkdown('<table><tr><th>A</th></tr><tr><td>x | y</td></tr></table>'),
    ).to.equal('| A      |\n| ------ |\n| x \\| y |');
  });

  it('undoes no escapes when the model wrote a backslash of its own', () => {
    // `\t` is no Markdown escape, so the path is kept; `\*` stays escaped.
    expect(htmlBlocksToMarkdown('<p>C:\\temp holds *.log files</p>')).to.equal(
      'C:\\temp holds \\*.log files',
    );
  });

  it('leaves Markdown, fenced HTML, inline HTML and SVG pictures alone', () => {
    const markdown = '## Ships\n\n- Destroyers\n- Carriers';
    expect(htmlBlocksToMarkdown(markdown)).to.equal(markdown);
    const fenced = 'Use this:\n\n```html\n<p>Hello</p>\n```';
    expect(htmlBlocksToMarkdown(fenced)).to.equal(fenced);
    const inline = 'Water is H<sub>2</sub>O.';
    expect(htmlBlocksToMarkdown(inline)).to.equal(inline);
    const picture = '<div>\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n</div>';
    expect(htmlBlocksToMarkdown(picture)).to.equal(picture);
  });

  it('keeps fenced code exactly as written around a rewritten block', () => {
    const reply = '<h2>Code</h2>\n\n```js\nconst a = 1;\n\n\n\nconst b = 2;\n```';
    expect(htmlBlocksToMarkdown(reply)).to.equal(
      '## Code\n\n```js\nconst a = 1;\n\n\n\nconst b = 2;\n```',
    );
  });

  it('keeps HTML when the document has HTML blocks of its own', () => {
    const existing = '# Page\n\n<div align="center">\n\n**Centered**\n\n</div>\n';
    expect(hasHtmlBlocks(existing)).to.equal(true);
    const reply = '<p>A new paragraph.</p>';
    expect(htmlBlocksToMarkdown(reply, existing)).to.equal(reply);
    expect(hasHtmlBlocks('# Page\n\nWater is H<sub>2</sub>O.\n\n```html\n<p>x</p>\n```')).to.equal(
      false,
    );
  });
});
