/**
 * Review tasks: a document reviewed in one style the way the Review panel
 * does it (parts, follow-up passes, the panel's reading of each reply).
 *
 * Most styles review documents seeded with known problems, each tagged with
 * how much its fix takes (low: mechanical; medium: a sentence; high: the
 * paragraph or document). The judge matches findings against that answer
 * key, labels every finding valid, trivial or wrong, and says how deep each
 * one goes, so a report can count low, medium and high suggestions and
 * recall can weight a buried conclusion above a typo. The creative style has
 * no defects to find, so its ideas are judged by a rubric instead.
 *
 * The deterministic checks ask what the panel needs to be useful: that the
 * review came back readable, found something, and that each finding's quote
 * locates exactly one passage so Apply works.
 */

import {
  AI_REVIEW_STYLE_DEFINITIONS,
  findUniqueExcerpt,
  reviewDocument,
  startReviewRun,
  type AiReviewFinding,
  type AiReviewStyle,
} from '@bendyline/docblocks-react/ai';
import type { BenchAnswerKeyItem, BenchCaseInfo, BenchJudgeSpec } from '../contract.js';
import { caseId, readFixture, readFixtureJson } from '../fixtures.js';
import { check, shareCheck, type BenchTask, type TaskCaseResult } from './types.js';

interface AnswerKeyFile {
  readonly style: AiReviewStyle;
  readonly cases: Readonly<Record<string, readonly BenchAnswerKeyItem[]>>;
}

interface ReviewCase extends BenchCaseInfo {
  readonly file: string;
  readonly answerKey: readonly BenchAnswerKeyItem[];
}

const HELPFULNESS = {
  id: 'helpfulness',
  label: 'Helpfulness',
  description:
    'How much the findings as a whole would help the author improve this document, judged by the ' +
    "reviewer's brief: specific, actionable messages and usable replacements score high; vague, " +
    'generic or padded feedback scores low, and so does a review that fixes typos while missing the ' +
    'problems that matter most to a reader.',
};

export const REVIEW_MATCHER: BenchJudgeSpec = {
  rubricId: 'review-matcher@2',
  mode: 'matcher',
  matchWeight: 0.8,
  levels: true,
  instructions:
    'A document reviewer was asked to review the document below and return findings, each quoting a ' +
    'passage, naming a problem, and usually offering replacement text. Match its findings against the ' +
    'answer key of known problems. A key problem is found when some finding points at the same passage ' +
    '(or one overlapping it) and names the same problem; wording may differ. Then label every finding: ' +
    '"valid" when it identifies a real problem and its suggestion would improve the document (whether or ' +
    'not the key lists it), "trivial" when it identifies no real problem (it praises the text, restates ' +
    'it, says it is correct, or proposes a change that makes no difference), and "wrong" when its claim ' +
    'is false or its replacement would make the document worse, invent facts, or break it. A replacement ' +
    'that contains instructions to the author instead of text ("Remove this section") is wrong: Apply ' +
    'would paste it into the document.',
  axes: [HELPFULNESS],
};

export const REVIEW_CREATIVE: BenchJudgeSpec = {
  rubricId: 'review-creative@1',
  mode: 'rubric',
  instructions:
    'A reviewer was asked for creative ways to make the document below more vivid, original and ' +
    'engaging, each idea quoting the passage it improves and usually giving the reworked passage. It must ' +
    "keep the author's purpose, voice and facts, and add no name, date, number, place or quotation the " +
    'document does not show. Its findings are the output. An empty output for a document with clear room ' +
    'for livelier writing is a failure.',
  axes: [
    {
      id: 'originality',
      label: 'Original',
      description:
        'The ideas are fresh and specific to this document, not generic advice ("add a hook") or synonyms swapped in.',
    },
    {
      id: 'craft',
      label: 'Craft',
      description:
        "The reworked passages read well and are better than the originals; they keep the author's voice and purpose.",
    },
    {
      id: 'faithfulness',
      label: 'Faithful',
      description:
        'No reworked passage adds a fact, name, number, place or quotation the document does not show.',
    },
    HELPFULNESS,
  ],
};

interface ReviewTaskOptions {
  readonly id: string;
  readonly label: string;
  /** The folder under `fixtures/review/`, holding the documents and `answer-key.json`. */
  readonly fixtureDir: string;
  readonly description: string;
  readonly judge?: BenchJudgeSpec;
  readonly trials?: number;
  /** Weight within the review family. */
  readonly weight?: number;
}

function findingText(finding: AiReviewFinding): string {
  return (
    `Quote: "${finding.originalText}"\n` +
    `Category: ${finding.category} (${finding.severity})\n` +
    `Message: ${finding.message}\n` +
    (finding.rationale ? `Rationale: ${finding.rationale}\n` : '') +
    `Replacement: ${finding.replacement === null ? '(none)' : `"${finding.replacement}"`}`
  );
}

function reviewTask(options: ReviewTaskOptions): BenchTask<ReviewCase> {
  const judge = options.judge ?? REVIEW_MATCHER;
  let cached: { style: AiReviewStyle; cases: ReviewCase[] } | null = null;
  const load = () => {
    if (!cached) {
      const key = readFixtureJson<AnswerKeyFile>('review', options.fixtureDir, 'answer-key.json');
      cached = {
        style: key.style,
        cases: Object.entries(key.cases).map(([file, answerKey]) => ({
          id: caseId(file),
          label: caseId(file).replace(/-/gu, ' '),
          file,
          answerKey,
        })),
      };
    }
    return cached;
  };
  return {
    info: {
      id: options.id,
      family: 'review',
      label: options.label,
      description: options.description,
      trials: options.trials ?? 1,
      // The checks only say the panel could show the review; what it says is the judge's.
      scoring: { checks: 0.15, judge: 0.85 },
      ...(options.weight === undefined ? {} : { weight: options.weight }),
      judge,
    },
    cases: () => load().cases,
    async run(testCase, context): Promise<TaskCaseResult> {
      const { style } = load();
      const source = readFixture('review', options.fixtureDir, testCase.file);
      const start = startReviewRun(source, style, context.contextWindow, context.now);
      if (start.kind !== 'run') {
        throw new Error(`Fixture ${testCase.file} cannot be reviewed (${start.kind}).`);
      }
      const result = await reviewDocument(context.ai, start.run, context.signal);
      const findings: readonly AiReviewFinding[] = result.findings;
      const notes = [
        `${String(findings.length)} findings in ${String(result.requests)} requests over ${String(start.run.requests.length)} parts`,
        ...(result.cutOff ? ['The review may have more to say: a reply filled its room.'] : []),
        ...(result.dropped > 0
          ? [`${String(result.dropped)} findings were left out: DocBlocks could not read them.`]
          : []),
      ];
      const usable = result.error === null;
      const located = findings.filter(
        (finding) => findUniqueExcerpt(source, finding.originalText) !== null,
      ).length;
      const withReplacement = findings.filter((finding) => finding.replacement !== null);
      const changing = withReplacement.filter(
        (finding) => finding.replacement !== finding.originalText,
      ).length;
      const decoy = judge.mode === 'matcher' && testCase.answerKey.length === 0;
      const context_ =
        `The reviewer's brief: ${AI_REVIEW_STYLE_DEFINITIONS[style].brief}\n\n` +
        `<document>\n${source}\n</document>`;
      return {
        usable,
        ...(usable ? {} : { modelError: result.error ?? 'The review did not finish.' }),
        checks: [
          check(
            'readable',
            'The panel could read the review',
            usable,
            2,
            result.error ?? undefined,
          ),
          // A document written to have nothing to flag is passed by saying little.
          ...(decoy
            ? []
            : [check('found', 'The review found something to say', findings.length > 0)]),
          shareCheck(
            'quotes-locate',
            'Quotes match exactly one passage, so Apply works',
            located,
            findings.length,
            2,
          ),
          shareCheck(
            'replacements-change',
            'Replacements change the text they replace',
            changing,
            withReplacement.length,
          ),
        ],
        artifact: {
          kind: 'json',
          content: JSON.stringify(
            findings.map((finding) => ({
              quote: finding.originalText,
              replacement: finding.replacement,
              category: finding.category,
              severity: finding.severity,
              message: finding.message,
              rationale: finding.rationale,
            })),
            null,
            2,
          ),
        },
        judgeInput: !usable
          ? null
          : judge.mode === 'matcher'
            ? {
                rubricId: judge.rubricId,
                context: context_,
                answerKey: testCase.answerKey,
                items: findings.map((finding, index) => ({
                  id: `f${String(index + 1)}`,
                  text: findingText(finding),
                })),
              }
            : { rubricId: judge.rubricId, context: context_ },
        notes,
      };
    },
  };
}

export const reviewGeneralTask = reviewTask({
  id: 'review-general',
  label: 'General review',
  fixtureDir: 'general',
  description:
    'The Review panel in its General style, over moderate-quality documents with problems seeded at three depths: mechanical, sentence and document level.',
  // The style people use most: as much as the specialist styles together.
  weight: 3,
});

export const reviewResumeTask = reviewTask({
  id: 'review-resume',
  label: 'Resume feedback',
  fixtureDir: 'resume',
  description:
    'The Review panel in its Resume style, over resumes seeded with the problems that style names.',
});

/** The styles whose fixtures arrive with their own answer keys. */
export function styleReviewTask(
  style: Exclude<AiReviewStyle, 'general' | 'resume'>,
): BenchTask<ReviewCase> {
  const definition = AI_REVIEW_STYLE_DEFINITIONS[style];
  return reviewTask({
    id: `review-${style}`,
    label: `${definition.label} review`,
    fixtureDir: style,
    description: `The Review panel in its ${definition.label} style: ${definition.description}`,
    ...(style === 'creative' ? { judge: REVIEW_CREATIVE, trials: 3 } : {}),
  });
}
