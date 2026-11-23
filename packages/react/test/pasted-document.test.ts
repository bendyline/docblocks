/**
 * Pasted text becomes a named document. The source decides what the text is:
 * an AI chat's Copy button puts Markdown in text/plain, a web page or Word
 * puts its formatting only in text/html, and a code editor offers coloured
 * HTML that must not win over the Markdown beside it.
 */
import { expect } from 'chai';
import {
  contentFromDataTransfer,
  fileNameForPastedTitle,
  pastedContentToMarkdown,
  readClipboardContent,
  titleForPastedMarkdown,
} from '../src/DocBlocksShell/pasted-document.js';

describe('pastedContentToMarkdown', () => {
  it('keeps Markdown from an AI chat as it is', async () => {
    const text = '# Q3 Plan\r\n\r\nGrow signups by **30%**.\r\n\r\n- Swaps\r\n- Workshops';
    expect(await pastedContentToMarkdown({ text })).to.equal(
      '# Q3 Plan\n\nGrow signups by **30%**.\n\n- Swaps\n- Workshops\n',
    );
  });

  it('prefers Markdown text over a code editor’s coloured HTML', async () => {
    const markdown = await pastedContentToMarkdown({
      text: '## Notes\n\n[Docs](https://example.com)',
      html: '<div style="color:#ccc"><span>## Notes</span></div>',
    });
    expect(markdown).to.equal('## Notes\n\n[Docs](https://example.com)\n');
  });

  it('takes the structure from HTML when the text has lost it', async () => {
    const markdown = await pastedContentToMarkdown({
      text: 'Launch plan\nShip the beta\nCollect feedback',
      html: '<h2>Launch plan</h2><ul><li>Ship the beta</li><li>Collect <strong>feedback</strong></li></ul>',
    });
    expect(markdown).to.match(/^## Launch plan/m);
    expect(markdown).to.match(/^[-*] Ship the beta/m);
    expect(markdown).to.contain('**feedback**');
  });

  it('keeps plain-text lists and quotes', async () => {
    const text = 'Shopping\n- eggs\n- milk';
    expect(await pastedContentToMarkdown({ text, html: '<span>Shopping</span>' })).to.equal(
      `${text}\n`,
    );
  });

  it('keeps plain text reading as written', async () => {
    const markdown = await pastedContentToMarkdown({ text: 'Total is 2*3*4 units' });
    expect(markdown).to.contain('2\\*3\\*4');
  });

  it('is empty when there was nothing to paste', async () => {
    expect(await pastedContentToMarkdown({ text: '  \n ', html: '' })).to.equal('');
  });
});

describe('titleForPastedMarkdown', () => {
  it('uses the shallowest heading', () => {
    expect(titleForPastedMarkdown('Intro line\n\n## Details\n\n# Q3 Marketing Plan\n')).to.equal(
      'Q3 Marketing Plan',
    );
  });

  it('uses a front matter title first', () => {
    expect(titleForPastedMarkdown('---\ntitle: Board update\n---\n\n# Other\n')).to.equal(
      'Board update',
    );
  });

  it('drops a chat assistant’s opener', () => {
    expect(
      titleForPastedMarkdown("Sure! Here's a draft email to your landlord:\n\nDear Sam,\n"),
    ).to.equal('Draft email to your landlord');
    expect(titleForPastedMarkdown('Certainly.\n\nHere is the summary you asked for.\n')).to.equal(
      'Summary you asked for',
    );
  });

  it('reads the words of a line, not its Markdown', () => {
    expect(
      titleForPastedMarkdown('**[OpenAI](https://openai.com)** shipped `v2` today. More soon.'),
    ).to.equal('OpenAI shipped v2 today');
  });

  it('keeps a long first sentence to eight words', () => {
    expect(
      titleForPastedMarkdown(
        'the committee met on Tuesday to review every single budget line in detail',
      ),
    ).to.equal('The committee met on Tuesday to review every');
  });

  it('keeps an article that does not follow an opener', () => {
    expect(titleForPastedMarkdown('A quick note about Friday.')).to.equal(
      'A quick note about Friday',
    );
  });

  it('skips code, tables and rules', () => {
    expect(
      titleForPastedMarkdown(
        '```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n\n---\n\nAfter the code',
      ),
    ).to.equal('After the code');
  });

  it('is null when nothing readable is left', () => {
    expect(titleForPastedMarkdown('```\nonly code\n```\n')).to.equal(null);
    expect(titleForPastedMarkdown('Sure!\n')).to.equal(null);
  });
});

describe('fileNameForPastedTitle', () => {
  it('removes characters a folder would refuse', () => {
    expect(fileNameForPastedTitle('Q3: Plan / Draft? <v2>')).to.equal('Q3 Plan Draft v2.md');
  });

  it('never makes a hidden file or a trailing dot', () => {
    expect(fileNameForPastedTitle('...notes...')).to.equal('notes.md');
  });

  it('falls back to a plain name', () => {
    expect(fileNameForPastedTitle(null)).to.equal('Pasted text.md');
    expect(fileNameForPastedTitle(' :/ ')).to.equal('Pasted text.md');
  });

  it('steers clear of names Windows reserves', () => {
    expect(fileNameForPastedTitle('con')).to.equal('con document.md');
  });
});

/** A clipboard item as the async Clipboard API hands one back. */
function clipboardItem(flavours: Record<string, string>): ClipboardItem {
  return {
    types: Object.keys(flavours),
    getType: async (type: string) => new Blob([flavours[type] ?? '']),
  } as unknown as ClipboardItem;
}

describe('readClipboardContent', () => {
  it('reads text and HTML together', async () => {
    const result = await readClipboardContent({
      read: async () => [clipboardItem({ 'text/plain': 'Hi', 'text/html': '<b>Hi</b>' })],
    });
    expect(result).to.deep.equal({
      kind: 'content',
      content: { text: 'Hi', html: '<b>Hi</b>' },
    });
  });

  it('does not ask twice after a refusal', async () => {
    let plainReads = 0;
    const result = await readClipboardContent({
      read: async () => {
        throw new DOMException('Denied', 'NotAllowedError');
      },
      readText: async () => {
        plainReads += 1;
        return 'text';
      },
    });
    expect(result).to.deep.equal({ kind: 'unavailable' });
    expect(plainReads).to.equal(0);
  });

  it('falls back to a plain read when a rich one is unsupported', async () => {
    const result = await readClipboardContent({
      read: async () => {
        throw new TypeError('not implemented');
      },
      readText: async () => 'Plain words',
    });
    expect(result).to.deep.equal({ kind: 'content', content: { text: 'Plain words' } });
  });

  it('tells an empty clipboard from an unreadable one', async () => {
    expect(await readClipboardContent({ readText: async () => '   ' })).to.deep.equal({
      kind: 'empty',
    });
    expect(
      await readClipboardContent({ read: async () => [clipboardItem({ 'image/png': 'x' })] }),
    ).to.deep.equal({ kind: 'empty' });
    expect(await readClipboardContent(null)).to.deep.equal({ kind: 'unavailable' });
  });
});

describe('contentFromDataTransfer', () => {
  function transfer(flavours: Record<string, string>): DataTransfer {
    return { getData: (type: string) => flavours[type] ?? '' } as unknown as DataTransfer;
  }

  it('carries both flavours, or nothing when both are blank', () => {
    expect(
      contentFromDataTransfer(transfer({ 'text/plain': 'a', 'text/html': '<p>a</p>' })),
    ).to.deep.equal({ text: 'a', html: '<p>a</p>' });
    expect(contentFromDataTransfer(transfer({ 'text/plain': ' ' }))).to.equal(null);
    expect(contentFromDataTransfer(null)).to.equal(null);
  });
});
