import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorProvider, useEditorContext } from '@bendyline/squisq-editor-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { buildNarrationScript } from '@bendyline/squisq/narration';
import { MemoryContentContainer } from '@bendyline/squisq/storage';

import { PresentationMaker } from '../src/Presentation/PresentationMaker.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const PINNED = [
  '{[audio src=audio/take.webm anchor=document]}',
  '',
  '# Start with an idea',
  '',
  'Write a few bullet points. Build a document with a clear story.',
  '',
  '## Make it visual {[duration=3]}',
  '',
  'First organize your points. Then add diagrams. Finally share your presentation.',
  '',
  '## Keep your voice',
  '',
  'Narration runs locally. Turn the same document into a narrated video.',
].join('\n');

/** A workspace holding a narration take whose timing sidecar matches `markdown`. */
async function narratedWorkspace(markdown: string) {
  const script = buildNarrationScript(markdownToDoc(parseMarkdown(markdown)));
  const times = [0, 20, 40, 60];
  const container = new MemoryContentContainer();
  await container.writeFile('audio/take.webm', new Uint8Array([1]), 'audio/webm');
  await container.writeFile(
    'audio/take.webm.timing.json',
    new TextEncoder().encode(
      JSON.stringify({
        version: 3,
        sourceText: script.sourceText,
        duration: times[times.length - 1],
        blocks: script.blocks.map((block, index) => ({
          ...block,
          blockIndex: index,
          startSec: times[index],
          endSec: times[index + 1],
        })),
        bookmarks: script.tokens.map((token, index) => ({
          id: `word-${index}`,
          charOffset: token.charOffset,
          time:
            times[token.blockIndex]! + (index - script.blocks[token.blockIndex]!.tokenStart) * 0.2,
        })),
      }),
    ),
    'application/json',
  );
  return container;
}

let latestSource = '';
function SourceProbe() {
  latestSource = useEditorContext().markdownSource;
  return null;
}

/** Let audio discovery and the re-render that follows it finish. */
async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('PresentationMaker with a pinned section', () => {
  it('previews the slides, explains the pin, and removes it in one step', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: PINNED,
          workspaceContainer: await narratedWorkspace(PINNED),
          children: [
            createElement(SourceProbe, { key: 'probe' }),
            createElement(PresentationMaker, { key: 'maker', onClose: () => undefined }),
          ],
        }),
      );
    });
    try {
      await settle();
      const alert = () => document.body.querySelector('.db-presentation [role="alert"]');
      const status = () =>
        Array.from(document.body.querySelectorAll('.db-presentation p[role="status"]'))
          .map((item) => item.textContent)
          .join(' ');
      expect(alert()?.textContent).to.contain('manually pinned');
      expect(status()).to.contain('Not synchronized with the narration');
      expect(status()).not.to.contain('Preparing');
      const preview = document.body.querySelector('.db-presentation-preview');
      expect(preview?.childElementCount, 'slide preview').to.be.greaterThan(0);

      const remove = Array.from(alert()?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Remove pinned times',
      );
      expect(remove, 'Remove pinned times').not.to.equal(undefined);
      await act(async () => remove?.click());
      await settle();

      expect(latestSource).to.contain('## Make it visual\n');
      expect(latestSource).not.to.contain('duration=');
      expect(alert()).to.equal(null);
      expect(status()).to.contain('Follows narration');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
