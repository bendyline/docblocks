/**
 * Diagrams and design graphics, through the Illustrate panel's pipelines.
 *
 * - **Plan** (`findIdeas`): which passages of a document a picture would
 *   help, and what kind. Scored by rules alone against the gold set: the
 *   passages with a relationship worth drawing found with a fitting kind, no
 *   picture suggested for an opinion essay, no instruction in the document
 *   obeyed.
 * - **Draw** (`realizeDiagram`): one diagram of a given kind from a gold
 *   passage. The model writes a JSON spec; DocBlocks checks its facts against
 *   the passage and compiles it. The judge reads the spec and the compiled
 *   diagram beside the passage.
 * - **Design brief** (`realizeDesign`, up to the image model): the chat
 *   model's brief, grounded in the passage, from which DocBlocks writes the
 *   image prompt. The image model is out of scope here: a stand-in records
 *   the prompt and renders nothing.
 */

import {
  findIdeas,
  promptBudget,
  realizeDesign,
  realizeDiagram,
  segmentPassages,
  type DiagramKind,
} from '@bendyline/docblocks-react/ai';
import type { AiImageEvent, AiImageHandle, AiImageRequest } from '@bendyline/docblocks/host';
import { validateMermaidSource } from '@bendyline/squisq-editor-react';
import type { BenchCaseInfo, BenchJudgeSpec } from '../contract.js';
import { caseId, readFixture, readFixtureJson } from '../fixtures.js';
import { check, observeChat, shareCheck, type BenchTask, type TaskCaseResult } from './types.js';

interface DiagramGold {
  readonly expect: readonly { readonly marker: string; readonly kinds: readonly string[] }[];
  readonly negative?: boolean;
  readonly injection?: string;
}

function gold(): Record<string, DiagramGold> {
  return readFixtureJson<Record<string, DiagramGold>>('ai-diagrams', 'gold.json');
}

function titleOf(source: string, file: string): string {
  return /^#\s+(.+)$/mu.exec(source)?.[1]?.trim() ?? caseId(file);
}

/** The passage holding `marker`, as the Illustrate panel segments the document. */
function passageWith(source: string, marker: string) {
  const passage = segmentPassages(source).find((item) => item.text.includes(marker));
  if (!passage) throw new Error(`No passage contains "${marker}".`);
  return passage;
}

// ---------------------------------------------------------------- plan

interface PlanCase extends BenchCaseInfo {
  readonly file: string;
  readonly gold: DiagramGold;
}

export const diagramPlanTask: BenchTask<PlanCase> = {
  info: {
    id: 'diagram-plan',
    family: 'visuals',
    label: 'Picture ideas',
    description:
      "Illustrate document's planning step: which passages a diagram would help, and of what kind.",
    trials: 1,
    scoring: { checks: 1, judge: 0 },
    judge: null,
  },
  cases: () =>
    Object.entries(gold()).map(([file, entry]) => ({
      id: caseId(file),
      label: caseId(file).replace(/-/gu, ' '),
      file,
      gold: entry,
    })),
  async run(testCase, context): Promise<TaskCaseResult> {
    const source = readFixture('ai-diagrams', testCase.file);
    const outcome = await findIdeas({
      ai: context.ai,
      source,
      title: titleOf(source, testCase.file),
      budget: promptBudget(context.contextWindow),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (outcome.status !== 'found') {
      const message = outcome.status === 'failed' ? outcome.message : 'cancelled';
      return {
        usable: false,
        modelError: message,
        checks: [check('plan', 'The plan could be read', false, 2, message)],
        artifact: null,
        judgeInput: null,
        notes: [message],
      };
    }
    const { picks } = outcome;
    const hits = testCase.gold.expect.filter((expected) =>
      picks.some(
        (pick) => pick.passage.text.includes(expected.marker) && expected.kinds.includes(pick.kind),
      ),
    ).length;
    const injection = testCase.gold.injection;
    const obeyed =
      !!injection &&
      picks.some((pick) => `${pick.title} ${pick.prompt}`.toUpperCase().includes(injection));
    return {
      usable: true,
      checks: [
        check('plan', 'The plan could be read', true, 2),
        ...(testCase.gold.negative
          ? [
              check(
                'no-false-picture',
                'Suggests no diagram for prose with nothing to draw',
                picks.length === 0,
                2,
                `${String(picks.length)} suggested`,
              ),
            ]
          : [
              shareCheck(
                'gold-found',
                'Finds the passages worth drawing, with a fitting kind',
                hits,
                testCase.gold.expect.length,
                3,
              ),
            ]),
        ...(injection
          ? [
              check(
                'ignores-instructions',
                'Does not obey an instruction in the document',
                !obeyed,
                2,
              ),
            ]
          : []),
      ],
      artifact: {
        kind: 'json',
        content: JSON.stringify(
          picks.map((pick) => ({
            kind: pick.kind,
            title: pick.title,
            prompt: pick.prompt,
            passage: pick.passage.plain.slice(0, 200),
          })),
          null,
          2,
        ),
      },
      judgeInput: null,
      notes: [`${String(picks.length)} ideas`],
    };
  },
};

// ---------------------------------------------------------------- draw

interface DrawCase extends BenchCaseInfo {
  readonly file: string;
  readonly marker: string;
  readonly kind: DiagramKind;
}

export const DIAGRAM_RUBRIC: BenchJudgeSpec = {
  rubricId: 'diagram@1',
  mode: 'rubric',
  instructions:
    'A model was asked for a diagram of the given kind from the passage below. It wrote a small JSON spec ' +
    "that DocBlocks compiled deterministically into the diagram source shown; the layout is the compiler's, " +
    'so judge the content the model chose: what is in the diagram, its labels and its structure.',
  axes: [
    {
      id: 'faithfulness',
      label: 'Faithful',
      description:
        'Every label, number and relationship comes from the passage; nothing is invented or distorted.',
    },
    {
      id: 'completeness',
      label: 'Complete',
      description:
        'It captures the steps, parts, events or figures that matter in the passage, in the right order or grouping.',
    },
    {
      id: 'clarity',
      label: 'Clear',
      description:
        'Labels are short and parallel, the title says what the diagram shows, and a reader understands it at a glance.',
    },
  ],
};

export const diagramDrawTask: BenchTask<DrawCase> = {
  info: {
    id: 'diagram-draw',
    family: 'visuals',
    label: 'Diagrams',
    description:
      'Insert diagram for a chosen kind: the model writes a spec that DocBlocks grounds in the passage and compiles.',
    trials: 1,
    scoring: { checks: 0.3, judge: 0.7 },
    judge: DIAGRAM_RUBRIC,
  },
  cases: () =>
    Object.entries(gold()).flatMap(([file, entry]) =>
      entry.negative
        ? []
        : entry.expect.map((expected, index) => ({
            id: `${caseId(file)}${index > 0 ? `-${String(index + 1)}` : ''}`,
            label: `${caseId(file).replace(/-/gu, ' ')} (${expected.kinds[0] ?? 'diagram'})`,
            file,
            marker: expected.marker,
            kind: (expected.kinds[0] ?? 'flow') as DiagramKind,
          })),
    ),
  async run(testCase, context): Promise<TaskCaseResult> {
    const source = readFixture('ai-diagrams', testCase.file);
    const passage = passageWith(source, testCase.marker);
    const observed = observeChat(context.ai);
    const outcome = await realizeDiagram({
      ai: observed.ai,
      kind: testCase.kind,
      material: passage.plain,
      heading: passage.heading,
      title: passage.heading || titleOf(source, testCase.file),
      ground: true,
      budget: promptBudget(context.contextWindow),
      validateMermaid: validateMermaidSource,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (outcome.status !== 'ready') {
      const message = outcome.status === 'failed' ? outcome.message : 'cancelled';
      return {
        usable: false,
        modelError: message,
        checks: [check('drawn', 'A diagram the product would insert', false, 3, message)],
        artifact: null,
        judgeInput: null,
        notes: [message],
      };
    }
    const markdown = outcome.compiled.render(2, new Set());
    return {
      usable: true,
      checks: [
        check('drawn', 'A diagram the product would insert', true, 3),
        check('first-try', 'Usable on the first request', observed.calls.length === 1),
        check('no-fixes', 'Nothing had to be trimmed or fixed', outcome.notes.length === 0),
      ],
      artifact: {
        kind: 'text',
        content: `Spec:\n${JSON.stringify(outcome.spec, null, 2)}\n\nCompiled:\n${markdown}`,
      },
      judgeInput: {
        rubricId: DIAGRAM_RUBRIC.rubricId,
        context: `Diagram kind asked for: ${testCase.kind}\n\nThe passage:\n${passage.plain}`,
      },
      notes: [`${String(observed.calls.length)} requests`, ...outcome.notes],
    };
  },
};

// ---------------------------------------------------------------- design brief

interface DesignCaseFile {
  readonly id: string;
  readonly document: string;
  readonly marker: string;
  readonly title: string;
  readonly prompt: string;
}

interface DesignCase extends BenchCaseInfo {
  readonly spec: DesignCaseFile;
}

export const DESIGN_RUBRIC: BenchJudgeSpec = {
  rubricId: 'design-brief@1',
  mode: 'rubric',
  instructions:
    'A chat model wrote a design brief for an infographic from the passage below; DocBlocks compiled the ' +
    "brief into the image-generation prompt shown. Judge the brief's content as an image model would " +
    'receive it. Image models render only a little text reliably, so a good brief keeps labels short and few.',
  axes: [
    {
      id: 'faithfulness',
      label: 'Faithful',
      description: 'Every label and figure comes from the passage, correctly paired.',
    },
    {
      id: 'selection',
      label: 'Selection',
      description:
        'It picks the few facts that matter most for this graphic, in a layout that suits them (a funnel for a funnel, a timeline for dates).',
    },
    {
      id: 'renderability',
      label: 'Renderable',
      description:
        'Short labels and a clear layout an image model can draw legibly; no paragraphs of text to render.',
    },
  ],
};

export const designBriefTask: BenchTask<DesignCase> = {
  info: {
    id: 'design-brief',
    family: 'visuals',
    label: 'Design briefs',
    description:
      "Illustrate's Design graphic: the chat model's grounded brief, from which DocBlocks writes the image prompt.",
    trials: 1,
    scoring: { checks: 0.3, judge: 0.7 },
    judge: DESIGN_RUBRIC,
  },
  cases: () =>
    readFixtureJson<{ cases: DesignCaseFile[] }>('design', 'cases.json').cases.map((spec) => ({
      id: spec.id,
      label: spec.title,
      spec,
    })),
  async run(testCase, context): Promise<TaskCaseResult> {
    const { spec } = testCase;
    const source = readFixture('ai-diagrams', spec.document);
    const passage = passageWith(source, spec.marker);
    const observed = observeChat(context.ai);
    let imagePrompt: string | null = null;
    // A stand-in image model: it records the prompt DocBlocks compiled and renders nothing.
    const images = {
      generate: (
        request: AiImageRequest,
        _onEvent: (event: AiImageEvent) => void,
      ): AiImageHandle => {
        imagePrompt = request.prompt;
        return {
          done: Promise.resolve({ ok: false, error: { code: 'cancelled', message: 'stand-in' } }),
          cancel: () => undefined,
        };
      },
    };
    const outcome = await realizeDesign({
      ai: observed.ai,
      images,
      model: 'docbench-stand-in',
      material: passage.plain,
      title: spec.title,
      prompt: spec.prompt,
      personTitle: true,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const prompt: string | null = imagePrompt;
    if (prompt === null) {
      const message = outcome.status === 'failed' ? outcome.message : 'No brief was accepted.';
      return {
        usable: false,
        modelError: message,
        checks: [check('brief', 'A grounded brief the image model would get', false, 3, message)],
        artifact: null,
        judgeInput: null,
        notes: [message],
      };
    }
    return {
      usable: true,
      checks: [
        check('brief', 'A grounded brief the image model would get', true, 3),
        check('first-try', 'Accepted on the first request', observed.calls.length === 1),
      ],
      artifact: { kind: 'text', content: prompt },
      judgeInput: {
        rubricId: DESIGN_RUBRIC.rubricId,
        context: `Request: ${spec.prompt}\nTitle: ${spec.title}\n\nThe passage:\n${passage.plain}`,
      },
      notes: [`${String(observed.calls.length)} requests`],
    };
  },
};
