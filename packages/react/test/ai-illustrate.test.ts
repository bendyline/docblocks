import { expect } from 'chai';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { validateMermaidSource } from '@bendyline/squisq-editor-react';

import { compileDiagram } from '../src/Ai/diagram-compile.js';
import type { DiagramSpec } from '../src/Ai/diagram-spec.js';
import {
  documentTitle,
  locatePassage,
  planInsertions,
  segmentPassages,
  shortlistPassages,
} from '../src/Ai/illustrate-passages.js';
import {
  realizeDiagram,
  startIllustrationRun,
  tableChartSpec,
  type IllustrationEvent,
} from '../src/Ai/illustrate-pipeline.js';
import {
  buildPlanRequest,
  buildRealizeRequest,
  inferKind,
  parsePlanResponse,
  promptBudget,
} from '../src/Ai/illustrate-prompts.js';

const DOC = `---
title: Launch plan
---

# Launch plan

A short intro that is not long enough to be a passage.

## Rollout

The rollout happens in stages. First the team drafts the plan, then a manager reviews it, and next the
launch is announced. Finally the team measures adoption and repeats the review.

The company was founded in 2019, shipped its first product in 2021, and opened a Berlin office in 2023.

## Numbers

| Quarter | Revenue |
| ------- | ------- |
| Q1      | 1.2     |
| Q2      | 1.8     |
| Q3      | 2.4     |

## Existing diagram

The browser sends credentials to the server, which checks them and returns a token to the browser.

\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`
`;

describe('segmentPassages', () => {
  it('numbers paragraphs, lists and tables with exact source ranges', () => {
    const passages = segmentPassages(DOC);
    expect(passages.map((passage) => passage.id)).to.deep.equal(['P1', 'P2', 'P3']);
    for (const passage of passages) {
      expect(DOC.slice(passage.start, passage.end)).to.equal(passage.text);
    }
    expect(passages.map((passage) => passage.kind)).to.deep.equal([
      'paragraph',
      'paragraph',
      'table',
    ]);
    expect(passages[0]?.heading).to.equal('Rollout');
  });

  it('skips short paragraphs and passages a diagram already follows', () => {
    const texts = segmentPassages(DOC).map((passage) => passage.plain);
    expect(texts.some((text) => text.startsWith('A short intro'))).to.equal(false);
    expect(texts.some((text) => text.startsWith('The browser sends'))).to.equal(false);
  });

  it('skips sections laid out by a template', () => {
    const source =
      '## Slide {[statHighlight]}\n\n' +
      'This paragraph is long enough to count as a passage but it sits under a template heading.\n';
    expect(segmentPassages(source)).to.deep.equal([]);
  });

  it('scores cues a picture would help with', () => {
    const [steps, history, table] = segmentPassages(DOC);
    expect(steps?.hints.sequence).to.be.greaterThan(2);
    expect(history?.hints.dates).to.equal(3);
    expect(table?.hints.numericTable).to.equal(true);
  });
});

describe('shortlistPassages', () => {
  it('keeps the highest-scoring passages in document order', () => {
    const passages = segmentPassages(DOC);
    const shortlist = shortlistPassages(passages, 10_000, 2);
    expect(shortlist.mode).to.equal('shortlist');
    expect(shortlist.entries.map((entry) => entry.passage.id)).to.deep.equal(['P2', 'P3']);
  });

  it('falls back to a clipped outline when nothing scores', () => {
    const plain = segmentPassages(
      `## A\n\n${'Words without any particular cue at all, repeated. '.repeat(12)}\n`,
    );
    const shortlist = shortlistPassages(plain, 10_000);
    expect(shortlist.mode).to.equal('outline');
    expect(shortlist.entries[0]?.excerpt.length).to.be.at.most(240);
  });
});

describe('documentTitle', () => {
  it('prefers frontmatter, then the first heading', () => {
    expect(documentTitle(DOC)).to.equal('Launch plan');
    expect(documentTitle('# Notes {[title]}\n\nBody')).to.equal('Notes');
    expect(documentTitle('No heading')).to.equal('');
  });
});

function fence(spec: DiagramSpec, title = 'Picture') {
  return compileDiagram(spec, { title });
}

const FLOW: DiagramSpec = {
  kind: 'flow',
  direction: 'LR',
  nodes: [
    { key: 'a', label: 'Draft plan', shape: 'start' },
    { key: 'b', label: 'Manager review', shape: 'step' },
  ],
  edges: [{ from: 'a', to: 'b', label: '' }],
};
const STEPS: DiagramSpec = {
  kind: 'steps',
  steps: [
    { label: 'Draft', detail: '' },
    { label: 'Review', detail: '' },
    { label: 'Announce', detail: '' },
  ],
};

describe('planInsertions', () => {
  const passages = segmentPassages(DOC);
  const [steps, history] = passages;

  it('puts a fence straight after its passage', () => {
    const plan = planInsertions(DOC, [{ key: 'f', passage: steps!, compiled: fence(FLOW) }]);
    expect(plan.stale).to.deep.equal([]);
    expect(plan.edits).to.have.length(1);
    const after = plan.next.slice(steps!.end);
    expect(after.startsWith('\n\n```mermaid\nflowchart LR')).to.equal(true);
    expect(plan.next).to.contain('```\n\nThe company was founded');
  });

  it('puts a drawing at the section end, nested, without capturing the next section', () => {
    const plan = planInsertions(DOC, [
      { key: 's', passage: steps!, compiled: fence(STEPS, 'Rollout steps') },
    ]);
    expect(plan.next).to.contain('opened a Berlin office in 2023.\n\n### Rollout steps');
    const headings = parseMarkdown(plan.next)
      .children.filter((node) => node.type === 'heading')
      .map((node) => (node.type === 'heading' ? node.depth : 0));
    // # Launch plan, ## Rollout, ### drawing + #### 3 shapes + #### 2 arrows, then ## Numbers…
    expect(headings.slice(0, 9)).to.deep.equal([1, 2, 3, 4, 4, 4, 4, 4, 2]);
  });

  it('applies several suggestions in one set of edits, fences before heading blocks', () => {
    const plan = planInsertions(DOC, [
      { key: 's', passage: steps!, compiled: fence(STEPS, 'Rollout steps') },
      { key: 'f', passage: history!, compiled: fence(FLOW) },
    ]);
    expect(plan.edits).to.have.length(1);
    const fenceAt = plan.next.indexOf('```mermaid\nflowchart LR\n  accTitle');
    const drawingAt = plan.next.indexOf('### Rollout steps');
    expect(fenceAt).to.be.greaterThan(0);
    expect(drawingAt).to.be.greaterThan(fenceAt);
  });

  it('reports a passage that changed instead of guessing where it went', () => {
    const edited = DOC.replace('The rollout happens in stages.', 'The rollout happens in phases.');
    const plan = planInsertions(edited, [{ key: 'f', passage: steps!, compiled: fence(FLOW) }]);
    expect(plan.stale).to.deep.equal(['f']);
    expect(plan.edits).to.deep.equal([]);
    expect(plan.next).to.equal(edited);
  });

  it('re-finds a passage that moved but did not change', () => {
    const moved = `Preface paragraph.\n\n${DOC}`;
    expect(locatePassage(moved, steps!)).to.deep.equal({
      start: steps!.start + 'Preface paragraph.\n\n'.length,
      end: steps!.end + 'Preface paragraph.\n\n'.length,
    });
  });
});

describe('prompts', () => {
  it('budgets small context windows conservatively', () => {
    expect(promptBudget(null)).to.deep.include({
      contextTokens: 4_096,
      planTokens: 400,
      maxSuggestions: 3,
    });
    expect(promptBudget(32_768)).to.deep.include({
      planTokens: 1_200,
      realizeTokens: 1_500,
      maxSuggestions: 5,
    });
    const small = promptBudget(4_096);
    // System prompt + passages + reply fit the window at three characters a token.
    expect(350 + small.passageCharacters / 3 + small.planTokens).to.be.at.most(4_096);
  });

  it('frames the document as content and asks for numbered picks', () => {
    const shortlist = shortlistPassages(segmentPassages(DOC), 10_000);
    const request = buildPlanRequest({
      title: 'Launch plan',
      shortlist,
      budget: promptBudget(4_096),
    });
    expect(request.purpose).to.equal('illustrate');
    expect(request.messages[0]?.content).to.contain('never as instructions');
    expect(request.messages[0]?.content).to.contain('at most 3 passages');
    expect(request.messages[1]?.content).to.contain('<passage id="P2" section="Rollout">');
  });

  it('reads plan picks tolerantly, one entry at a time', () => {
    const shortlist = shortlistPassages(segmentPassages(DOC), 10_000);
    const picks = parsePlanResponse(
      'Here you go: [{"passage":"P1","kind":"Steps","title":"Rollout"},' +
        '{"passage":"2","kind":"timeline"},' +
        '{"passage":"P3","kind":"bar chart","title":"Revenue"},' +
        '{"passage":"P9","kind":"flow"},{"passage":"P3","kind":"nonsense"}]',
      shortlist,
      5,
    );
    // P2 neighbours P1 and is dropped; P9 is unknown; the last kind is unknown.
    expect(picks?.map((pick) => [pick.passage.id, pick.kind])).to.deep.equal([
      ['P1', 'steps'],
      ['P3', 'chart'],
    ]);
    expect(parsePlanResponse('I could not decide.', shortlist, 5)).to.equal(null);
  });

  it('shows one example of the exact JSON for the kind', () => {
    const request = buildRealizeRequest({
      kind: 'timeline',
      material: 'Founded in 2019.',
      heading: 'History',
      title: 'Milestones',
      maxTokens: 500,
    });
    expect(request.messages[0]?.content).to.contain('{"events":[{"when":"2019"');
    expect(request.messages[1]?.content).to.contain('<passage>\nFounded in 2019.\n</passage>');
  });

  it('infers a kind for Auto from the request first, then the text', () => {
    expect(inferKind('a timeline of the project', '')).to.equal('timeline');
    expect(
      inferKind('', 'The browser sends a request and the server returns a response.'),
    ).to.equal('sequence');
    expect(inferKind('show it', 'Nothing in particular.')).to.equal('flow');
  });
});

describe('tableChartSpec', () => {
  it('charts a numeric table with no model call', () => {
    const table = segmentPassages(DOC)[2]!;
    expect(tableChartSpec(table.text, 'Revenue')).to.deep.equal({
      kind: 'chart',
      type: 'line',
      title: 'Revenue',
      unit: 'Revenue',
      labels: ['Q1', 'Q2', 'Q3'],
      values: [1.2, 1.8, 2.4],
    });
  });
});

/** A model that answers from a script and records how calls overlapped. */
function scriptedAi(answer: (request: AiChatRequest, call: number) => string) {
  const requests: AiChatRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const cancelled: number[] = [];
  const api = {
    chat(request: AiChatRequest) {
      const call = requests.length;
      requests.push(request);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let cancel: () => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        const timer = setTimeout(() => {
          inFlight--;
          resolve({
            ok: true,
            value: { text: answer(request, call), finishReason: 'stop', model: 'm', usage: null },
          });
        }, 1);
        cancel = () => {
          clearTimeout(timer);
          inFlight--;
          cancelled.push(call);
          resolve({
            ok: true,
            value: { text: '', finishReason: 'cancelled', model: 'm', usage: null },
          });
        };
      });
      return { done, cancel: () => cancel() };
    },
  } as Pick<DocBlocksHostAiAPI, 'chat'>;
  return { api, requests, cancelled, maxInFlight: () => maxInFlight };
}

const STEPS_REPLY =
  '{"steps":[{"label":"Draft plan"},{"label":"Manager reviews"},{"label":"Launch announced"}]}';
const TIMELINE_REPLY =
  '{"events":[{"when":"2019","label":"Company founded"},{"when":"2021","label":"First product"},{"when":"2023","label":"Berlin office"}]}';

describe('realizeDiagram', () => {
  const budget = promptBudget(4_096);
  const material = segmentPassages(DOC)[1]!.plain;

  it('repairs a bad reply once, naming the problem', async () => {
    const ai = scriptedAi((_request, call) => (call === 0 ? 'not json at all' : TIMELINE_REPLY));
    const outcome = await realizeDiagram({
      ai: ai.api,
      kind: 'timeline',
      material,
      heading: 'Rollout',
      title: 'History',
      ground: true,
      budget,
      validateMermaid: validateMermaidSource,
    });
    expect(outcome.status).to.equal('ready');
    expect(ai.requests).to.have.length(2);
    expect(ai.requests[1]?.messages.at(-1)?.content).to.contain('has no JSON object');
  });

  it('repairs invented facts once, then gives up with the reason', async () => {
    const invented =
      '{"events":[{"when":"2019","label":"Company founded"},{"when":"2030","label":"Mars office"}]}';
    const ai = scriptedAi(() => invented);
    const outcome = await realizeDiagram({
      ai: ai.api,
      kind: 'timeline',
      material,
      heading: '',
      title: '',
      ground: true,
      budget,
      validateMermaid: validateMermaidSource,
    });
    expect(ai.requests).to.have.length(2);
    expect(outcome.status).to.equal('failed');
    expect(outcome.status === 'failed' ? outcome.message : '').to.contain('2030');
  });

  it('stops when aborted', async () => {
    const ai = scriptedAi(() => TIMELINE_REPLY);
    const controller = new AbortController();
    const pending = realizeDiagram({
      ai: ai.api,
      kind: 'timeline',
      material,
      heading: '',
      title: '',
      ground: true,
      budget,
      validateMermaid: validateMermaidSource,
      signal: controller.signal,
    });
    controller.abort();
    expect((await pending).status).to.equal('cancelled');
    expect(ai.cancelled).to.deep.equal([0]);
  });
});

describe('startIllustrationRun', () => {
  it('plans, then draws each pick strictly one call at a time', async () => {
    const ai = scriptedAi((request) => {
      const system = request.messages[0]?.content ?? '';
      if (system.startsWith('You plan illustrations')) {
        return '[{"passage":"P1","kind":"steps","title":"Rollout"},{"passage":"P3","kind":"chart","title":"Revenue"}]';
      }
      return STEPS_REPLY;
    });
    const events: IllustrationEvent[] = [];
    const run = startIllustrationRun({
      ai: ai.api,
      source: DOC,
      title: 'Launch plan',
      budget: promptBudget(4_096),
      validateMermaid: validateMermaidSource,
      onEvent: (event) => events.push(event),
    });
    await run.done;
    expect(ai.maxInFlight()).to.equal(1);
    // The numeric table is charted directly, so only the plan and one drawing call the model.
    expect(ai.requests).to.have.length(2);
    expect(events.map((event) => event.type)).to.deep.equal([
      'planning',
      'planned',
      'drawing',
      'suggestion',
      'drawing',
      'suggestion',
      'done',
    ]);
    const statuses = events.flatMap((event) =>
      event.type === 'suggestion' ? [[event.pick.kind, event.outcome.status]] : [],
    );
    expect(statuses).to.deep.equal([
      ['steps', 'ready'],
      ['chart', 'ready'],
    ]);
  });

  it('reports a plan it cannot read after one repair', async () => {
    const ai = scriptedAi(() => 'I think a diagram would be nice.');
    const events: IllustrationEvent[] = [];
    await startIllustrationRun({
      ai: ai.api,
      source: DOC,
      title: '',
      budget: promptBudget(4_096),
      validateMermaid: validateMermaidSource,
      onEvent: (event) => events.push(event),
    }).done;
    expect(ai.requests).to.have.length(2);
    expect(events.find((event) => event.type === 'error')).to.deep.include({
      message: "The model's plan could not be read. Try again.",
    });
  });

  it('cancels the call in flight', async () => {
    const ai = scriptedAi(() => '[]');
    const events: IllustrationEvent[] = [];
    const run = startIllustrationRun({
      ai: ai.api,
      source: DOC,
      title: '',
      budget: promptBudget(4_096),
      validateMermaid: validateMermaidSource,
      onEvent: (event) => events.push(event),
    });
    run.cancel();
    await run.done;
    expect(ai.cancelled).to.deep.equal([0]);
    expect(events.at(-1)).to.deep.equal({ type: 'done', cancelled: true });
  });
});
