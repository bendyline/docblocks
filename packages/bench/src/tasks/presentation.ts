/**
 * Presentations: "Suggest with AI" in the presentation designer. Squisq plans
 * a deck from the document's prose, the model storyboards its layouts and
 * words each slide (with structured output), and every reply passes Squisq's
 * gates; a refused reply keeps the automatic slide.
 *
 * The checks are the presentation eval's rule-based metrics, per document:
 * reply shape, suggestions taken, the gold passages drawn with a fitting
 * layout, faithfulness (no shape on prose that has none, no range cut to one
 * end, no injected instruction followed) and a deck that compiles and draws.
 * The judge reads the worded slides beside their passages.
 */

import { refinePresentationPlan } from '@bendyline/docblocks-react/ai';
import { expandDocBlocks, markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import * as transform from '@bendyline/squisq/transform';
import type { BenchCaseInfo, BenchJudgeSpec } from '../contract.js';
import { caseId, readFixture, readFixtureJson } from '../fixtures.js';
import {
  check,
  observeChat,
  shareCheck,
  type BenchTask,
  type ObservedCall,
  type TaskCaseResult,
} from './types.js';

interface GoldEntry {
  readonly expect: readonly {
    readonly marker: string;
    readonly ideal: string;
    readonly layouts: readonly string[];
  }[];
  readonly forbid?: readonly string[];
  readonly injection?: string;
  readonly rangeOnly?: readonly string[];
}

interface PresentationCase extends BenchCaseInfo {
  readonly file: string;
  readonly gold: GoldEntry;
}

export const PRESENTATION_RUBRIC: BenchJudgeSpec = {
  rubricId: 'presentation-slides@1',
  mode: 'rubric',
  instructions:
    'A model turned the document below into presentation slides: for each passage it chose a slide ' +
    'layout and wrote a headline and short points. Slides marked "automatic" kept a fallback the ' +
    'product made without the model; judge the slides marked "model", using the automatic ones only ' +
    'as context. A layout such as cycle, funnel, pyramid, stats or matrix draws a shape and claims ' +
    'that relationship is in the passage.',
  axes: [
    {
      id: 'wording',
      label: 'Wording',
      description:
        'Headlines say the point of the slide; points are short, parallel and readable at a glance, ' +
        'not copied sentences or fragments that lose the meaning.',
    },
    {
      id: 'faithfulness',
      label: 'Faithful',
      description:
        'Every headline and point is supported by its passage: no invented numbers, names or claims, ' +
        'and no relationship (a cycle, a funnel) the passage does not describe.',
    },
    {
      id: 'layout-fit',
      label: 'Layout fit',
      description:
        'Each layout suits its passage: a sequence as steps or a process, key figures as stats, a ' +
        'hierarchy as a pyramid, and plain prose as cards or a list.',
    },
  ],
};

function unfenced(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/u, '').replace(/\s*```\s*$/u, '');
}

/** Whether a slide reply is exactly the fields asked for, with a known layout. */
function slideShape(text: string, layouts: ReadonlySet<string>): boolean {
  let value: unknown;
  try {
    value = JSON.parse(unfenced(text));
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['layout', 'headline', 'points', 'center', 'xAxis', 'yAxis']);
  const keys = Object.keys(record);
  return (
    ['layout', 'headline', 'points'].every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key)) &&
    typeof record.layout === 'string' &&
    layouts.has(record.layout) &&
    typeof record.headline === 'string' &&
    Array.isArray(record.points) &&
    record.points.every((point) => typeof point === 'string')
  );
}

function storyboardLayouts(call: ObservedCall | undefined): string[] | null {
  if (!call || call.truncated || call.error) return null;
  try {
    const value = JSON.parse(unfenced(call.text)) as { layouts?: unknown };
    return Array.isArray(value.layouts) && value.layouts.every((item) => typeof item === 'string')
      ? (value.layouts as string[])
      : null;
  } catch {
    return null;
  }
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

export const presentationTask: BenchTask<PresentationCase> = {
  info: {
    id: 'presentation-slides',
    family: 'presentations',
    label: 'Slide suggestions',
    description:
      '"Suggest with AI" in the presentation designer: storyboard a deck\'s layouts, then word each slide.',
    trials: 1,
    // The automatic deck always compiles, so the checks barely separate models (0.1 slice: 75–93).
    scoring: { checks: 0.3, judge: 0.7 },
    judge: PRESENTATION_RUBRIC,
  },
  cases: () => {
    const gold = readFixtureJson<Record<string, GoldEntry>>('ai-presentations', 'gold.json');
    return Object.entries(gold).map(([file, entry]) => ({
      id: caseId(file),
      label: caseId(file).replace(/-/gu, ' '),
      file,
      gold: entry,
    }));
  },
  async run(testCase, context): Promise<TaskCaseResult> {
    const source = readFixture('ai-presentations', testCase.file);
    const layouts = new Set<string>(transform.PRESENTATION_LAYOUTS);
    const doc = markdownToDoc(parseMarkdown(source), { generateCoverBlock: false });
    const plan = transform.createPresentationPlan(doc);
    const asked = transform.presentationSlidesToWord(plan);
    const observed = observeChat(context.ai);
    const problems: string[] = [];
    const result = await refinePresentationPlan(observed.ai, plan, {
      ...(context.signal ? { signal: context.signal } : {}),
      onAttempt: (_index, _attempt, outcome) => {
        if (outcome.problem) problems.push(outcome.problem);
      },
    });

    const isStoryboard = (call: ObservedCall) =>
      call.request.responseFormat?.name === 'presentation_storyboard';
    const storyboardCall = observed.calls.find(isStoryboard);
    const slideCalls = observed.calls.filter((call) => !isStoryboard(call));
    const planned = storyboardLayouts(storyboardCall);
    const storyboardValid =
      planned !== null &&
      planned.length === asked.length &&
      planned.every((layout) => layouts.has(layout));

    const beats = result.plan.beats;
    const passageOf = (index: number) => {
      const beat = plan.beats[index];
      return beat ? plan.sourceText.slice(beat.sourceStart, beat.sourceEnd) : '';
    };
    const gold = testCase.gold.expect.flatMap((expected) => {
      const index = beats.findIndex((_beat, i) => passageOf(i).includes(expected.marker));
      const beat = beats[index];
      if (!beat) return [];
      return [
        {
          accepted: expected.layouts.includes(beat.layout),
          hit:
            beat.layout === expected.ideal ||
            (expected.ideal === 'process' && beat.layout === 'steps'),
        },
      ];
    });
    const refined = new Set(result.refined);
    const shown = (index: number) => {
      const beat = beats[index];
      return beat ? [beat.headline, ...beat.points].join('\n') : '';
    };
    const forbidden = beats.filter((beat) => testCase.gold.forbid?.includes(beat.layout)).length;
    const injected =
      !!testCase.gold.injection &&
      result.refined.some((index) => shown(index).includes(testCase.gold.injection ?? ''));
    const rangeCut =
      !!testCase.gold.rangeOnly &&
      beats.some((beat) => {
        if (beat.layout !== 'stat' && beat.layout !== 'stats') return false;
        const figures =
          beat.layout === 'stat'
            ? [transform.presentationStat(beat.headline, beat.points)?.match.value ?? '']
            : beat.points.map((point) => point.split(':')[0] ?? '');
        return figures.some((figure) => {
          const numbers = transform.numbersIn(figure);
          return numbers.length === 1 && (testCase.gold.rangeOnly ?? []).includes(numbers[0] ?? '');
        });
      });

    let compiled = true;
    let drewNothing = 0;
    try {
      const deck = transform.compilePresentationPlan(doc, result.plan);
      expandDocBlocks(deck.blocks, {
        splitLongBlocks: false,
        mergeShortBlocks: false,
        onDiagnostic: (diagnostic) => {
          if (diagnostic.code === 'template-drew-nothing') drewNothing += 1;
        },
      });
    } catch (error: unknown) {
      compiled = false;
      problems.push(
        `The deck did not compile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The model's work reached the deck: at least one slide took its wording.
    const usable = asked.length === 0 || result.refined.length > 0;
    const deckText = beats
      .map((beat, index) => {
        const extras = (['center', 'xAxis', 'yAxis'] as const).flatMap((key) => {
          const value = (beat as unknown as Record<string, unknown>)[key];
          return typeof value === 'string' ? [`${key}: ${value}`] : [];
        });
        return [
          `Slide ${String(index + 1)} (${refined.has(index) ? 'model' : 'automatic'}, layout ${beat.layout})`,
          `Passage: ${clip(passageOf(index), 600)}`,
          `Headline: ${beat.headline}`,
          ...beat.points.map((point) => `- ${point}`),
          ...extras,
        ].join('\n');
      })
      .join('\n\n');
    return {
      usable,
      ...(usable ? {} : { modelError: "No slide took the model's suggestion." }),
      checks: [
        shareCheck(
          'slide-shape',
          'Slide replies are exactly the fields asked for',
          slideCalls.filter((call) => slideShape(call.text, layouts)).length,
          slideCalls.length,
        ),
        shareCheck(
          'suggestions-taken',
          "Slides that took the model's suggestion",
          result.refined.length,
          asked.length,
          2,
        ),
        ...(storyboardCall
          ? [check('storyboard', 'The storyboard planned one layout per slide', storyboardValid)]
          : []),
        ...(gold.length > 0
          ? [
              shareCheck(
                'gold-fits',
                'Passages with a shape drawn with a fitting layout',
                gold.filter((item) => item.accepted).length,
                gold.length,
                2,
              ),
              shareCheck(
                'gold-ideal',
                'Passages with a shape drawn with the ideal layout',
                gold.filter((item) => item.hit).length,
                gold.length,
              ),
            ]
          : []),
        check(
          'faithful',
          'No shape on prose without one, no range cut to one end, no injected instruction followed',
          forbidden === 0 && !injected && !rangeCut,
          2,
          [
            forbidden ? `${String(forbidden)} forbidden layouts` : '',
            injected ? 'followed an injected instruction' : '',
            rangeCut ? 'cut a range to one end' : '',
          ]
            .filter(Boolean)
            .join('; ') || undefined,
        ),
        check(
          'deck-draws',
          'The deck compiles and every slide draws',
          compiled && drewNothing === 0,
          1,
          drewNothing ? `${String(drewNothing)} slides drew nothing` : undefined,
        ),
      ],
      artifact: { kind: 'text', content: deckText },
      judgeInput: usable
        ? {
            rubricId: PRESENTATION_RUBRIC.rubricId,
            // The slides themselves are the artifact.
            context: `<document>\n${source}\n</document>`,
          }
        : null,
      notes: [
        `${String(result.refined.length)}/${String(asked.length)} slides took the suggestion; ${String(observed.calls.length)} requests`,
        ...[...new Set(problems)].slice(0, 12),
      ],
    };
  },
};
