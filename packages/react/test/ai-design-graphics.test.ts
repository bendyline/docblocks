import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditorProvider,
  useEditorContext,
  type EditorContextValue,
} from '@bendyline/squisq-editor-react';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiImageModel,
  AiImageRequest,
  AiImageResult,
  AiImagesAPI,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiIllustratePanel } from '../src/Ai/AiDiagrams.js';
import {
  checkBriefGrounding,
  designAspect,
  designPrompt,
  parseBrief,
  realizeDesign,
} from '../src/Ai/design-brief.js';
import { parsePlanResponse } from '../src/Ai/illustrate-prompts.js';
import { segmentPassages, shortlistPassages } from '../src/Ai/illustrate-passages.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const PASSAGE =
  'Revenue grew every quarter this year: 12% in Q1, 18% in Q2 and 25% in Q3, ' +
  'driven by the new Atlas product line.';
const SOURCE = `# Results\n\n${PASSAGE}\n`;
const GOOD_BRIEF =
  '{"title":"Quarterly growth","layout":"infographic","labels":["Q1","Q2","Q3"],' +
  '"numbers":["12%","18%","25%"],"style":"clean flat design in teal and navy"}';
const INVENTED_BRIEF =
  '{"title":"Quarterly growth","layout":"infographic","labels":["Q1","Q4"],' +
  '"numbers":["40%"],"style":"bold"}';
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4,
  0,
]);
const MING: AiImageModel = {
  id: 'sd-cpp:ming-image-0.1-design-bf16',
  label: 'Ming Image 0.1 Design (BF16)',
  description: null,
  state: 'installed',
  downloadBytes: 49_243_658_314,
  shared: false,
  license: 'MIT',
  commercialUse: true,
  rendersText: true,
  promptStyle: 'sentences',
  hardwareTier: 'workstation',
  minRamGb: 96,
  fit: { verdict: 'fits', reason: '' },
};

function unused(): never {
  throw new Error('Not used by this test');
}

function reply(text: string) {
  return {
    done: new Promise<AiResult<AiChatCompletion>>((resolve) =>
      setTimeout(
        () => resolve({ ok: true, value: { text, finishReason: 'stop', model: 'm', usage: null } }),
        1,
      ),
    ),
    cancel: () => undefined,
  };
}

function scriptedImages() {
  const requests: AiImageRequest[] = [];
  const images: AiImagesAPI = {
    access: async () => ({ kind: 'ready' }),
    onAccess: () => () => undefined,
    requestAccess: unused,
    models: async () => ({ ok: true, value: [MING] }),
    installModel: unused,
    removeModel: unused,
    getPreferences: async () => ({ model: null, designModel: MING.id, aspect: '1:1' }),
    setPreferences: unused,
    generate(request, onEvent) {
      requests.push(request);
      onEvent({
        kind: 'progress',
        progress: { phase: 'sampling', step: 6, totalSteps: 12, secondsPerStep: 2 },
      });
      const image: AiImageResult = {
        mimeType: 'image/png',
        data: PNG.buffer.slice(0),
        width: 1024,
        height: 1360,
        seed: 42,
        model: MING.id,
        durationMs: 24_000,
      };
      return {
        done: new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: image }), 1)),
        cancel: () => undefined,
      };
    },
  };
  return { images, requests };
}

describe('design briefs', () => {
  it('reads a brief and keeps text the passage states', () => {
    const brief = parseBrief(`Here it is: ${GOOD_BRIEF}`);
    expect(brief).to.deep.equal({
      title: 'Quarterly growth',
      layout: 'infographic',
      labels: ['Q1', 'Q2', 'Q3'],
      numbers: ['12%', '18%', '25%'],
      style: 'clean flat design in teal and navy',
    });
    expect(checkBriefGrounding(brief!, PASSAGE)).to.deep.equal({ ok: true, problems: [] });
    expect(parseBrief('no json here')).to.equal(null);
  });

  it('rejects labels and figures the passage does not state', () => {
    const invented = parseBrief(INVENTED_BRIEF)!;
    const result = checkBriefGrounding(invented, PASSAGE);
    expect(result.ok).to.equal(false);
    expect(result.problems.join(' ')).to.match(/"Q4"/u).and.to.match(/"40%"/u);
  });

  it('compiles a sentence-style prompt that quotes every piece of text', () => {
    const prompt = designPrompt(parseBrief(GOOD_BRIEF)!);
    expect(prompt).to.contain('infographic on a light neutral background');
    expect(prompt).to.contain('Large bold title text reads "Quarterly growth".');
    expect(prompt).to.contain('"12%", "18%" and "25%" as large printed numbers, not plotted');
    expect(prompt).to.contain('3 labels: "Q1", "Q2" and "Q3".');
    expect(prompt).to.contain('no other text');
    expect(designAspect('title-card')).to.equal('16:9');
  });

  it('drops a label too long to quote whole instead of clipping it', () => {
    const brief = parseBrief(
      '{"title":"Signups","labels":["started a free trial",' +
        '"finished setting up their first project","became paying customers"]}',
    )!;
    expect(brief.labels).to.deep.equal(['started a free trial', 'became paying customers']);
    expect(designPrompt(brief)).not.to.contain('…');
  });

  it('keeps chart words out of the style, so the figures are never plotted', () => {
    const brief = parseBrief(
      '{"title":"Quarterly growth","labels":["Q1"],"style":"minimalist line graph in blue and gray"}',
    )!;
    expect(brief.style).to.equal('minimalist in blue and gray');
    expect(parseBrief('{"title":"Growth","style":"bar chart"}')!.style).to.equal('');
    expect(designPrompt(brief)).not.to.match(/graph in/u);
  });

  it('offers the design kind to the planner only when asked', () => {
    const passages = segmentPassages(SOURCE);
    const shortlist = shortlistPassages(passages, 10_000);
    const plan = '[{"passage":"P1","kind":"infographic","title":"Growth","show":"The growth."}]';
    expect(parsePlanResponse(plan, shortlist, 3, true)?.[0]?.kind).to.equal('design');
    expect(parsePlanResponse(plan, shortlist, 3, false)).to.deep.equal([]);
  });

  it('repairs an ungrounded brief once, then renders with the design model', async () => {
    const chats: AiChatRequest[] = [];
    const replies = [INVENTED_BRIEF, GOOD_BRIEF];
    const { images, requests } = scriptedImages();
    const progress: string[] = [];
    const outcome = await realizeDesign({
      ai: {
        chat(request) {
          chats.push(request);
          return reply(replies.shift() ?? GOOD_BRIEF);
        },
      },
      images,
      model: MING.id,
      material: PASSAGE,
      title: '',
      prompt: 'Show the quarterly growth.',
      onProgress: (p) => progress.push(p.phase),
    });
    expect(chats).to.have.length(2);
    expect(chats[1]?.messages.at(-1)?.content).to.contain('"Q4" is not in the passage');
    expect(requests).to.have.length(1);
    expect(requests[0]).to.include({ model: MING.id, aspect: '3:4' });
    expect(requests[0]?.prompt).to.contain('"Q1", "Q2" and "Q3"');
    expect(progress).to.deep.equal(['sampling']);
    if (outcome.status !== 'ready') throw new Error(`expected ready, got ${outcome.status}`);
    expect(outcome.compiled.kind).to.equal('design');
    expect(outcome.compiled.image?.mediaPath).to.equal(null);
    expect(outcome.compiled.render(2, new Set())).to.equal('');
    expect(outcome.notes[0]).to.contain('"Quarterly growth"');
  });

  it('fails without rendering when the repaired brief still invents text', async () => {
    const { images, requests } = scriptedImages();
    const outcome = await realizeDesign({
      ai: { chat: () => reply(INVENTED_BRIEF) },
      images,
      model: MING.id,
      material: PASSAGE,
      title: '',
      prompt: '',
    });
    expect(outcome.status).to.equal('failed');
    expect(requests).to.have.length(0);
  });
});

const READY: AiStatus = {
  kind: 'ready',
  provider: { mode: 'hosted' } as Extract<AiStatus, { kind: 'ready' }>['provider'],
  model: { id: 'm', label: 'Model', local: true, contextWindow: 32_768, isDefault: true },
  activeRequests: 0,
};

function fakeMonaco(edits: unknown[][]) {
  const positionAt = (offset: number) => {
    const lines = SOURCE.slice(0, offset).split('\n');
    return { lineNumber: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
  };
  return {
    getModel: () => ({ getValue: () => SOURCE, getPositionAt: positionAt }),
    getSelection: () => null,
    pushUndoStop: () => undefined,
    executeEdits: (_source: string, ops: unknown[]) => {
      edits.push(ops);
      return true;
    },
  } as unknown as Parameters<EditorContextValue['setMonacoEditor']>[0];
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}: ${document.body.textContent ?? ''}`);
}

describe('AiIllustratePanel design graphics', () => {
  it('plans a design graphic, renders it with the design model, and inserts the saved image', async () => {
    const { images, requests } = scriptedImages();
    const chats: AiChatRequest[] = [];
    const ai: DocBlocksHostAiAPI = {
      images,
      providerInstalled: unused,
      status: () => Promise.resolve(READY),
      onStatus: () => () => undefined,
      getPreferences: unused,
      setPreferences: unused,
      connect: unused,
      disconnect: unused,
      models: unused,
      chat(request) {
        chats.push(request);
        const system = request.messages[0]?.content ?? '';
        return reply(
          system.startsWith('You plan illustrations')
            ? '[{"passage":"P1","kind":"design","title":"Quarterly growth","show":"The growth by quarter."}]'
            : GOOD_BRIEF,
        );
      },
    };
    const saved: string[] = [];
    const edits: unknown[][] = [];
    let editor: EditorContextValue | null = null;
    function Probe() {
      editor = useEditorContext();
      return null;
    }
    const mediaProvider = {
      resolveUrl: async (path: string) => path,
      listMedia: async () => [],
      async addMedia(name: string) {
        saved.push(name);
        return `results_files/${name}`;
      },
      removeMedia: async () => undefined,
      dispose: () => undefined,
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: SOURCE,
          mediaProvider: mediaProvider as never,
          children: [
            createElement(Probe, { key: 'probe' }),
            createElement(AiIllustratePanel, { key: 'panel', ai, onClose: () => undefined }),
          ],
        }),
      );
    });
    await act(async () => {
      editor?.setActiveView('raw');
      editor?.setMonacoEditor(fakeMonaco(edits));
    });
    const click = async (label: string) => {
      const target = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!target) throw new Error(`No "${label}" button in: ${container.textContent ?? ''}`);
      await act(async () => target.click());
    };

    await waitFor(() => container.querySelectorAll('.db-ai-idea-card').length === 1, 'the idea');
    // The planner was offered design graphics.
    expect(chats[0]?.messages[0]?.content).to.contain('design (a poster, infographic');
    const kind = container.querySelector<HTMLSelectElement>('.db-ai-idea-card select');
    expect(kind?.value).to.equal('design');

    await click('Draw 1 picture');
    await waitFor(() => container.querySelector('.db-ai-design-preview') !== null, 'the preview');
    expect(requests).to.have.length(1);
    expect(requests[0]?.model).to.equal(MING.id);
    expect(container.textContent).to.contain('Check that the picture spells this text exactly');

    await click('Insert');
    await waitFor(() => edits.length === 1, 'the insertion');
    expect(saved).to.have.length(1);
    expect(saved[0]).to.match(/^generated-quarterly-growth-42-[a-z0-9]+\.png$/u);
    const text = JSON.stringify(edits[0]);
    expect(text).to.contain(`results_files/${saved[0]!}`);
    expect(text).to.contain('![Quarterly growth: 12%, 18%, 25%, Q1, Q2, Q3]');

    await act(async () => root.unmount());
    container.remove();
  });
});
