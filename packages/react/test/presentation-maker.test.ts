import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditorProvider,
  PreviewSettingsProvider,
  useEditorContext,
} from '@bendyline/squisq-editor-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { buildNarrationScript } from '@bendyline/squisq/narration';
import { THEMES } from '@bendyline/squisq/schemas';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

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

const REPORT = [
  '# Results',
  '',
  'Revenue grew 40% last year. Most of it came from new customers.',
  '',
  '## By region {[barChart]}',
  '',
  'North led every quarter.',
  '',
  '| Region | Sales |',
  '| --- | --- |',
  '| North | 40 |',
  '| South | 25 |',
].join('\n');

describe('PresentationMaker authored sections', () => {
  it('shows a section as authored, naming its block type, and saves only that choice', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: REPORT,
          children: [
            createElement(SourceProbe, { key: 'probe' }),
            createElement(PresentationMaker, { key: 'maker', onClose: () => undefined }),
          ],
        }),
      );
    });
    try {
      await settle();
      const region = () =>
        Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('.db-presentation-beats button'),
        ).find((slide) => slide.textContent?.includes('By region'))!;
      await act(async () => region().click());
      const layout = () =>
        document.body.querySelector<HTMLSelectElement>('.db-presentation-detail select')!;
      const authored = Array.from(layout().options).find((option) => option.value === 'authored');
      expect(authored?.textContent).to.equal('As authored (Bar Chart)');
      expect(Array.from(layout().options).map((option) => option.textContent)).to.include.members([
        // Squisq names its own layouts, including the ones that draw a shape.
        'Key number',
        'Quote',
        'Big statement',
        'Definition',
        'Section break',
        'Key numbers',
        'Pyramid',
        'Matrix',
      ]);

      await act(async () => {
        layout().value = 'authored';
        layout().dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
      expect(region().querySelector('small')?.textContent).to.equal('As authored (Bar Chart)');
      expect(layout().getAttribute('aria-describedby')).to.be.a('string');
      expect(document.body.querySelector('.db-presentation-layout-help')?.textContent).to.contain(
        'block picker',
      );
      // Nothing to word and no supporting slides: the section is shown as written.
      expect(document.body.querySelector('.db-presentation-wording')).to.equal(null);
      expect(document.body.querySelectorAll('.db-presentation-detail select')).to.have.length(1);
      expect(
        document.body.querySelector('.db-presentation-preview')?.childElementCount,
      ).to.be.greaterThan(0);

      const apply = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'Use dynamic slides',
      );
      await act(async () => apply?.click());
      await settle();
      expect(latestSource).to.contain('"layout":"authored"');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

const LONG = [
  '# Plan',
  '',
  'Each slide should carry one idea that the narration explains in more depth. '.repeat(8),
  '',
  '## Next',
  '',
  'Ship it soon.',
].join('\n');

describe('PresentationMaker one slide per section', () => {
  it('collapses each section to one slide and rests the supporting-slide controls', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: LONG,
          children: createElement(PresentationMaker, { onClose: () => undefined }),
        }),
      );
    });
    try {
      await settle();
      const slides = () => document.body.querySelectorAll('.db-presentation-beats button');
      const supporting = () =>
        document.body.querySelector<HTMLInputElement>('.db-presentation-toggle input')!;
      expect(slides().length).to.be.greaterThan(2);
      expect(supporting().checked).to.equal(true);

      const density = document.body.querySelector<HTMLSelectElement>(
        '.db-presentation-preferences select',
      )!;
      await act(async () => {
        density.value = 'section';
        density.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
      expect(slides()).to.have.length(2);
      expect(supporting().checked).to.equal(false);
      expect(supporting().disabled).to.equal(true);
      expect(document.body.querySelectorAll('.db-presentation-detail select')).to.have.length(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('PresentationMaker hidden slides', () => {
  it('hides a slide by its passage, keeps one slide shown, and saves only a key', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: LONG,
          children: [
            createElement(SourceProbe, { key: 'probe' }),
            createElement(PresentationMaker, { key: 'maker', onClose: () => undefined }),
          ],
        }),
      );
    });
    try {
      await settle();
      const slides = () =>
        Array.from(
          document.body.querySelectorAll<HTMLButtonElement>('.db-presentation-beats button'),
        );
      const hide = () =>
        document.body.querySelector<HTMLInputElement>(
          '.db-presentation-detail > .db-presentation-toggle input',
        )!;
      const status = () =>
        document.body.querySelector('.db-presentation p[role="status"]')?.textContent ?? '';
      const count = slides().length;
      await act(async () => slides()[1]!.click());
      await act(async () => hide().click());
      await settle();
      expect(status()).to.match(new RegExp(`^${count - 1} slides · 1 hidden`));
      expect(slides()).to.have.length(count);
      expect(slides()[1]!.classList.contains('db-presentation-beat-hidden')).to.equal(true);
      expect(slides()[1]!.textContent).to.contain('Hidden');
      expect(hide().checked).to.equal(true);
      expect(
        document.body.querySelector('.db-presentation-preview-hidden')?.childElementCount,
      ).to.be.greaterThan(0);

      // A new split has new passages, so nothing hidden carries over.
      const density = document.body.querySelector<HTMLSelectElement>(
        '.db-presentation-preferences select',
      )!;
      await act(async () => {
        density.value = 'section';
        density.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
      expect(status()).not.to.contain('hidden');
      await act(async () => slides()[0]!.click());
      await act(async () => hide().click());
      await settle();
      expect(status()).to.match(/^1 slide · 1 hidden/);
      await act(async () => slides()[1]!.click());
      expect(hide().disabled, 'the last shown slide').to.equal(true);

      const apply = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'Use dynamic slides',
      );
      await act(async () => apply?.click());
      await settle();
      // Both keys are kept, so returning to Balanced hides its slide again.
      expect(latestSource).to.match(/"hidden":\["[0-9a-z]+-[0-9a-z]+","[0-9a-z]+-[0-9a-z]+"\]/);
      expect(latestSource.match(/Each slide should carry/g)).to.have.length(8);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

const DIAGRAM = [
  '# Squiggly Square is a Swiss army knife for content',
  '',
  'Developed libraries and engine for both cases.',
  '',
  '```mermaid',
  'flowchart LR',
  '  A([SquigglySquare]) --> B[DocBlocks - Simple markdown editor]',
  '```',
].join('\n');

describe('PresentationMaker slide preview', () => {
  it('draws diagrams in the active theme, as the slideshow does', async () => {
    const theme = THEMES['warm-earth']!;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: DIAGRAM,
          children: createElement(PreviewSettingsProvider, {
            doc: markdownToDoc(parseMarkdown(DIAGRAM)),
            themeOverride: theme,
            children: createElement(PresentationMaker, { onClose: () => undefined }),
          }),
        }),
      );
    });
    try {
      await settle();
      const diagram = () =>
        document.body.querySelector<HTMLElement>(
          '.db-presentation-preview .squisq-mermaid-rendered',
        );
      for (const slide of Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('.db-presentation-beats button'),
      )) {
        if (diagram()) break;
        await act(async () => slide.click());
      }
      expect(diagram(), 'a slide previews the diagram').not.to.equal(null);
      const panel = document.createElement('div');
      panel.style.background = theme.colors.backgroundLight;
      panel.style.color = theme.colors.text;
      expect(diagram()?.style.background).to.equal(panel.style.background);
      expect(diagram()?.style.color).to.equal(panel.style.color);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

const DECK = [
  '# Launch plan',
  '',
  'We ship the editor in March. Two teams share the work.',
  '',
  '## What ships',
  '',
  'The editor, the exporter and the slide designer ship together.',
  '',
  '## Who does what',
  '',
  'Design owns the look. Engineering owns the exporter. Support owns the guide.',
  '',
  '## What happens next',
  '',
  'A beta opens in February. Feedback closes two weeks later.',
].join('\n');

/** A ready AI host whose requests stay open until the test answers them. */
function waitingAi() {
  const requests: AiChatRequest[] = [];
  const status: AiStatus = {
    kind: 'ready',
    provider: { name: 'Test provider', version: null, mode: 'hosted' },
    model: { id: 'm', label: 'Test model', local: true, contextWindow: 8192, isDefault: true },
    activeRequests: 0,
  };
  const unused = (): never => {
    throw new Error('Not used by the slide designer');
  };
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: async () => status,
    onStatus: () => () => undefined,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat(request) {
      requests.push(request);
      let cancel: () => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        cancel = () => resolve({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } });
      });
      return { done, cancel };
    },
  };
  return { api, requests };
}

describe('PresentationMaker Suggest with AI', () => {
  // The whole deck is planned in one request before any slide is asked for.
  // Until that answered, the dialog showed nothing and "Use dynamic slides"
  // still closed it with the design the AI had not touched.
  it('shows it is working, and holds its other buttons, from the click', async () => {
    const { api, requests } = waitingAi();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: DECK,
          children: createElement(PresentationMaker, { ai: api, onClose: () => undefined }),
        }),
      );
    });
    const button = (label: string) =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('.db-presentation button')).find(
        (candidate) => candidate.textContent === label,
      );
    try {
      await settle();
      expect(button('Suggest with AI')?.disabled, 'Suggest with AI is ready').to.equal(false);
      expect(button('Use dynamic slides')?.disabled).to.equal(false);

      await act(async () => button('Suggest with AI')?.click());

      // One request is out and nothing has come back.
      expect(requests).to.have.length(1);
      const status = document.body.querySelector('.db-presentation-progress');
      expect(status?.textContent).to.contain('Planning the slides');
      expect(status?.querySelector('progress')?.hasAttribute('value'), 'no amount yet').to.equal(
        false,
      );
      expect(button('Suggest with AI'), 'Suggest with AI').to.equal(undefined);
      expect(button('Use dynamic slides')?.disabled, 'Use dynamic slides').to.equal(true);
      expect(button('Reset design')?.disabled, 'Reset design').to.equal(true);

      await act(async () => button('Stop')?.click());
      await settle();

      expect(document.body.querySelector('.db-presentation-progress')).to.equal(null);
      expect(button('Use dynamic slides')?.disabled).to.equal(false);
      expect(
        Array.from(document.body.querySelectorAll('.db-presentation p[role="status"]'))
          .map((item) => item.textContent)
          .join(' '),
      ).to.contain('Stopped after 0 of');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
