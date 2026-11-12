/**
 * Illustrations: Insert diagram's Illustration kind, where the model writes
 * the SVG itself. The product offers it only to a model with a 16K window,
 * gets one retry with more room for a cut-off picture and one repair for a
 * problem, and inserts only an SVG island Squisq accepts. The judge looks at
 * the rendered picture.
 */

import { canDrawIllustrations, realizeIllustration } from '@bendyline/docblocks-react/ai';
import type { BenchCaseInfo, BenchJudgeSpec } from '../contract.js';
import { readFixtureJson } from '../fixtures.js';
import { check, observeChat, type BenchTask, type TaskCaseResult } from './types.js';

interface IllustrationPrompt {
  readonly description: string;
  readonly material?: string;
}

interface IllustrationCase extends BenchCaseInfo {
  readonly prompt: IllustrationPrompt;
}

export const ILLUSTRATION_RUBRIC: BenchJudgeSpec = {
  rubricId: 'illustration-vision@1',
  mode: 'rubric',
  vision: true,
  instructions:
    'A model was asked to draw a simple illustration as SVG for a document, from the request below. The ' +
    'picture is drawn in one theme color (currentColor) so it suits light and dark pages; that is ' +
    'intended, not a flaw. You are shown the rendered picture and its SVG source. Judge the picture a ' +
    'reader would see.',
  axes: [
    {
      id: 'subject',
      label: 'Shows what was asked',
      description:
        'Every element the request names is present and recognizable, arranged so the relationship it ' +
        'describes (a cycle, a stack, a flow) reads at a glance.',
    },
    {
      id: 'legibility',
      label: 'Legible',
      description:
        'Labels are readable, attached to what they name, and not overlapping, clipped or running off ' +
        'the picture; shapes do not collide by accident.',
    },
    {
      id: 'composition',
      label: 'Composition',
      description:
        'Balanced use of the canvas, consistent sizes and spacing, and a clean, intentional look a ' +
        'reader would accept in a finished document.',
    },
    {
      id: 'faithfulness',
      label: 'Faithful',
      description:
        'Nothing is drawn or labelled that the request and passage do not support: no invented names, ' +
        'numbers or steps.',
    },
  ],
};

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .split('-')
    .slice(0, 5)
    .join('-');
}

/** The SVG inside a compiled illustration's Markdown fence, as a standalone file. */
function svgDocument(markdown: string): string {
  const svg = markdown.slice(markdown.indexOf('\n') + 1, markdown.lastIndexOf('\n')).trim();
  return /\sxmlns=/u.test(svg)
    ? svg
    : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

export const illustrationTask: BenchTask<IllustrationCase> = {
  info: {
    id: 'illustration-svg',
    family: 'visuals',
    label: 'SVG illustrations',
    description:
      "Insert diagram's Illustration kind: the model writes an SVG picture from a request and, sometimes, a passage.",
    // Drawn at 0.4: warm enough that one sample is not the whole story.
    trials: 3,
    scoring: { checks: 0.3, judge: 0.7 },
    judge: ILLUSTRATION_RUBRIC,
  },
  cases: () =>
    readFixtureJson<IllustrationPrompt[]>('ai-diagrams', 'illustrations.json').map((prompt) => ({
      id: slug(prompt.description),
      label: prompt.description,
      prompt,
    })),
  async run(testCase, context): Promise<TaskCaseResult> {
    const { prompt } = testCase;
    if (!canDrawIllustrations(context.contextWindow)) {
      return {
        usable: false,
        modelError: `Not offered: the product draws illustrations only with a context window of 16K or more (this model reports ${String(context.contextWindow)}).`,
        checks: [check('drawn', 'A picture the product would insert', false, 3)],
        artifact: null,
        judgeInput: null,
        notes: ['Illustration is not offered at this context window.'],
      };
    }
    const observed = observeChat(context.ai);
    const outcome = await realizeIllustration({
      ai: observed.ai,
      material: prompt.material ?? '',
      description: prompt.description,
      title: prompt.description.slice(0, 60),
      ground: Boolean(prompt.material),
      contextWindow: context.contextWindow ?? 0,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (outcome.status !== 'ready') {
      const message = outcome.status === 'failed' ? outcome.message : 'cancelled';
      return {
        usable: false,
        modelError: message,
        checks: [check('drawn', 'A picture the product would insert', false, 3, message)],
        artifact: null,
        judgeInput: null,
        notes: [message],
      };
    }
    const calls = observed.calls.length;
    const svg = svgDocument(outcome.compiled.render(2, new Set()));
    const stripped = outcome.notes.some((note) => note.startsWith('Removed markup'));
    const fixedColors = outcome.notes.some((note) => note.includes('fixed colors'));
    return {
      usable: true,
      checks: [
        check('drawn', 'A picture the product would insert', true, 3),
        check('first-try', 'Usable on the first request', calls === 1),
        check('clean-markup', 'Nothing the sanitizer had to remove', !stripped),
        check('theme-color', 'Drawn in the theme color', !fixedColors),
      ],
      artifact: { kind: 'svg', content: svg },
      judgeInput: {
        rubricId: ILLUSTRATION_RUBRIC.rubricId,
        context:
          `Request: ${prompt.description}` +
          (prompt.material ? `\n\nPassage the picture illustrates:\n${prompt.material}` : ''),
      },
      notes: [`${String(calls)} requests`, ...outcome.notes],
    };
  },
};
