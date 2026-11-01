import { expect } from 'chai';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { revealSourceRange, visibleLine, type RevealTarget } from '../src/Ai/review-reveal.js';

const SOURCE = [
  '---',
  'title: Field notes',
  '---',
  '',
  '# Field **notes**',
  '',
  'Same words here. The crew logged the [river level](https://example.com) twice.',
  '',
  '- Same words here.',
  '- Readings were *kept*.',
  '',
].join('\n');

/** The Write view's document for SOURCE, as Squisq would load it. */
const HTML =
  '<h1>Field <strong>notes</strong></h1>' +
  '<p>Same words here. The crew logged the <a href="https://example.com">river level</a> twice.</p>' +
  '<ul><li><p>Same words here.</p></li><li><p>Readings were <em>kept</em>.</p></li></ul>';

function range(excerpt: string, occurrence = 0): [number, number] {
  let start = -1;
  for (let seen = 0; seen <= occurrence; seen++) start = SOURCE.indexOf(excerpt, start + 1);
  return [start, start + excerpt.length];
}

describe('revealing a source range', () => {
  let editor: Editor;
  let target: RevealTarget;

  beforeEach(() => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit],
      content: HTML,
    });
    target = {
      activeView: 'wysiwyg',
      tiptapEditor: editor as unknown as RevealTarget['tiptapEditor'],
      monacoEditor: null,
    };
  });

  afterEach(() => editor.destroy());

  function selected(): string {
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, '\n');
  }

  it('reads Markdown lines as the Write view shows them', () => {
    expect(visibleLine('# Field **notes** {[factCard]}')).to.equal('Field notes');
    expect(visibleLine('- [x] Ship the [river level](https://x.test) `fix`')).to.equal(
      'Ship the river level fix',
    );
    expect(visibleLine('> Quoted _emphasis_ in snake_case ![chart](c.png)')).to.equal(
      'Quoted emphasis in snake_case',
    );
  });

  it('selects source text in the Write view by what it shows, and focuses it', async () => {
    document.body.append(editor.view.dom);
    expect(
      revealSourceRange(
        target,
        SOURCE,
        ...range('The crew logged the [river level](https://example.com) twice.'),
      ),
    ).to.equal(true);
    expect(selected()).to.equal('The crew logged the river level twice.');
    // Tiptap focuses on the next frame.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).to.equal(editor.view.dom);
    editor.view.dom.remove();
  });

  it('tells repeated text apart by how often it came earlier', () => {
    revealSourceRange(target, SOURCE, ...range('Same words here.', 0));
    const first = editor.state.selection.from;
    revealSourceRange(target, SOURCE, ...range('Same words here.', 1));
    expect(selected()).to.equal('Same words here.');
    expect(editor.state.selection.from).to.be.greaterThan(first);
    expect(editor.state.doc.resolve(editor.state.selection.from).parent.textContent).to.equal(
      'Same words here.',
    );
  });

  it('selects across blocks, and puts the caret where deleted text was', () => {
    const [start] = range('Same words here.', 1);
    const [, end] = range('Readings were *kept*.');
    revealSourceRange(target, SOURCE, start, end);
    expect(selected()).to.equal('Same words here.\nReadings were kept.');

    const [at] = range('- Readings');
    expect(revealSourceRange(target, SOURCE, at, at)).to.equal(true);
    expect(editor.state.selection.empty).to.equal(true);
    expect(editor.state.doc.resolve(editor.state.selection.from).parent.textContent).to.equal(
      'Same words here.',
    );
  });

  it('says so when the Write view does not show the text', () => {
    expect(revealSourceRange(target, SOURCE, ...range('title: Field notes'))).to.equal(false);
    expect(revealSourceRange({ ...target, activeView: 'preview' }, SOURCE, 0, 4)).to.equal(false);
  });

  it('selects source offsets in the Source view, and finds the text in a single block', () => {
    const calls: unknown[] = [];
    const lines = (value: string, offset: number) => {
      const before = value.slice(0, offset).split('\n');
      return { lineNumber: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
    };
    const monaco = (value: string) =>
      ({
        getModel: () => ({
          getValue: () => value,
          getPositionAt: (offset: number) => lines(value, offset),
        }),
        setSelection: (selection: unknown) => calls.push(['select', selection]),
        revealRangeInCenterIfOutsideViewport: () => calls.push('reveal'),
        focus: () => calls.push('focus'),
      }) as unknown as RevealTarget['monacoEditor'];

    const source = { activeView: 'raw', tiptapEditor: null } as const;
    expect(
      revealSourceRange(
        { ...source, monacoEditor: monaco(SOURCE) },
        SOURCE,
        ...range('Readings were *kept*.'),
      ),
    ).to.equal(true);
    expect(calls).to.deep.equal([
      ['select', { startLineNumber: 10, startColumn: 3, endLineNumber: 10, endColumn: 24 }],
      'reveal',
      'focus',
    ]);

    // The Block layout's editor holds one block of the source.
    calls.length = 0;
    const block = '- Same words here.\n- Readings were *kept*.\n';
    revealSourceRange(
      { ...source, monacoEditor: monaco(block) },
      SOURCE,
      ...range('Readings were *kept*.'),
    );
    expect(calls[0]).to.deep.equal([
      'select',
      { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 24 },
    ]);
    expect(
      revealSourceRange({ ...source, monacoEditor: monaco(block) }, SOURCE, ...range('# Field')),
    ).to.equal(false);
  });
});
