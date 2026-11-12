/**
 * Study aids: Summarize document, Create quiz and Create flashcards, through
 * the product's `generateStudyAid` — its budgets, part-by-part notes for long
 * documents, item parsing, grounding filter and compiled study deck. The
 * judge reads the saved Markdown beside the source and a list of the facts a
 * good aid would cover.
 */

import {
  FLASHCARD_CARDS,
  QUIZ_QUESTIONS,
  generateStudyAid,
  studyBudget,
} from '@bendyline/docblocks-react/ai';
import type { BenchCaseInfo, BenchJudgeSpec } from '../contract.js';
import { caseId, readFixture, readFixtureJson } from '../fixtures.js';
import { check, type BenchTask, type TaskCaseResult } from './types.js';

type StudyKind = 'summary' | 'quiz' | 'flashcards';

interface StudyCase extends BenchCaseInfo {
  readonly file: string;
  readonly keyFacts: readonly string[];
}

const QUALITY: Record<StudyKind, string> = {
  summary:
    'A short opening paragraph and a few bullets a student could revise from: the main ideas, in proportion, without padding or repetition.',
  quiz: 'Each question has exactly one clearly correct answer that the document supports, and wrong answers that are plausible but clearly wrong; questions test understanding of what matters, not trivia or wording.',
  flashcards:
    'Each card asks one thing on the front and answers it briefly on the back; cards cover what matters, not trivia, and do not repeat each other.',
};

function studyRubric(kind: StudyKind): BenchJudgeSpec {
  return {
    rubricId: `study-${kind}@1`,
    mode: 'rubric',
    instructions:
      `A study tool made a ${kind === 'summary' ? 'summary' : kind === 'quiz' ? 'multiple-choice quiz' : 'flashcard deck'} ` +
      'from the document below, for a student learning it. The reference lists facts a good study aid would ' +
      'cover; it is a guide to coverage, not a script. The output is shown as saved, with its metadata.',
    axes: [
      {
        id: 'faithfulness',
        label: 'Faithful',
        description:
          'Everything it states is what the document says: no invented or distorted facts, and quiz answers marked correct are correct.',
      },
      {
        id: 'coverage',
        label: 'Coverage',
        description:
          'It covers the most important facts across the whole document, not just its opening, in proportion to their importance.',
      },
      { id: 'quality', label: 'Quality', description: QUALITY[kind] },
    ],
  };
}

function studyTask(kind: StudyKind, label: string, description: string): BenchTask<StudyCase> {
  const rubric = studyRubric(kind);
  let cached: StudyCase[] | null = null;
  return {
    info: {
      id: `study-${kind}`,
      family: 'study',
      label,
      description,
      trials: 1,
      scoring: { checks: 0.25, judge: 0.75 },
      judge: rubric,
    },
    cases: () =>
      (cached ??= Object.entries(
        readFixtureJson<Record<string, string[]>>('study', 'key-facts.json'),
      ).map(([file, keyFacts]) => ({
        id: caseId(file),
        label: caseId(file).replace(/-/gu, ' '),
        file,
        keyFacts,
      }))),
    async run(testCase, context): Promise<TaskCaseResult> {
      const source = readFixture('study', testCase.file);
      const outcome = await generateStudyAid({
        ai: context.ai,
        kind,
        source,
        sourceName: testCase.file,
        model: null,
        budget: studyBudget(context.contextWindow),
        now: () => context.now,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (outcome.status !== 'ready') {
        const message = outcome.status === 'failed' ? outcome.message : 'cancelled';
        return {
          usable: false,
          modelError: message,
          checks: [check('made', 'The study aid was made and saved', false, 2, message)],
          artifact: null,
          judgeInput: null,
          notes: [message],
        };
      }
      const count = outcome.count ?? 0;
      // About one item per 400 characters, up to the cap: what the pipeline plans for.
      const planned = Math.min(
        kind === 'quiz' ? QUIZ_QUESTIONS : FLASHCARD_CARDS,
        Math.max(1, Math.floor(source.length / 400)),
      );
      const body = outcome.markdown.replace(/^---[\s\S]*?---\s*/u, '');
      const bullets = (body.match(/^\s*[-*]\s+\S/gmu) ?? []).length;
      return {
        usable: true,
        checks: [
          check('made', 'The study aid was made and saved', true, 2),
          ...(kind === 'summary'
            ? [
                check(
                  'summary-shape',
                  'An opening paragraph and 3–8 bullets',
                  bullets >= 3 && bullets <= 8,
                  1,
                  `${String(bullets)} bullets`,
                ),
              ]
            : [
                check(
                  'items',
                  `At least half the ${kind === 'quiz' ? 'questions' : 'cards'} asked for survived the checks`,
                  count >= planned / 2,
                  2,
                  `${String(count)} of ${String(planned)}`,
                ),
              ]),
        ],
        artifact: { kind: 'markdown', content: outcome.markdown },
        judgeInput: {
          rubricId: rubric.rubricId,
          context: `<document>\n${source}\n</document>`,
          reference: testCase.keyFacts.map((fact) => `- ${fact}`).join('\n'),
        },
        notes: [
          ...(outcome.count === null ? [] : [`${String(outcome.count)} items`]),
          ...outcome.notes,
        ],
      };
    },
  };
}

export const studySummaryTask = studyTask(
  'summary',
  'Summary',
  'Summarize document: a summary paragraph and bullets, saved beside the document.',
);
export const studyQuizTask = studyTask(
  'quiz',
  'Quiz',
  'Create quiz: multiple-choice questions, each grounded in the document.',
);
export const studyFlashcardsTask = studyTask(
  'flashcards',
  'Flashcards',
  'Create flashcards: a deck of question-and-answer cards grounded in the document.',
);
