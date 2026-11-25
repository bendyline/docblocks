/**
 * Study aids. Summarize document runs through the product's
 * `generateStudyAid` — its budgets and part-by-part notes for long documents
 * — and is saved beside the document. Quiz questions and flashcards are study
 * cards kept with each section, made through the product's
 * `generateStudyCards` (Squisq's protocol over DocBlocks' transport): one
 * section and one request at a time, each card judged against its own
 * section, then written into the document. The judge reads the output beside
 * the source and a list of the facts a good aid would cover.
 */

import { generateStudyAid, generateStudyCards, studyBudget } from '@bendyline/docblocks-react/ai';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import {
  readStudyCards,
  studyCardTextKey,
  studySectionsOf,
  writeStudyCards,
  type StudyCardKind,
} from '@bendyline/squisq/study';
import type { BenchCaseInfo, BenchJudgeSpec } from '../contract.js';
import { caseId, readFixture, readFixtureJson } from '../fixtures.js';
import { check, type BenchTask, type TaskCaseResult, type TaskContext } from './types.js';

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
    // @2: quiz questions and flashcards are cards kept with each section.
    rubricId: kind === 'summary' ? 'study-summary@1' : `study-${kind}@2`,
    mode: 'rubric',
    instructions:
      kind === 'summary'
        ? 'A study tool made a summary from the document below, for a student learning it. The reference lists ' +
          'facts a good study aid would cover; it is a guide to coverage, not a script. The output is shown as ' +
          'saved, with its metadata.'
        : `A study tool wrote ${kind === 'quiz' ? 'multiple-choice questions' : 'flashcards'} for each section ` +
          'of the document below, for a student learning it, and kept each card under its section. Judge ' +
          'each card against the section it sits under. The reference lists facts a good set of cards ' +
          'would cover; it is a guide to coverage, not a script. The output is the document with its cards.',
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
      if (kind !== 'summary')
        return runCards(kind === 'quiz' ? 'quiz' : 'flashcard', source, testCase, context);
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
      const body = outcome.markdown.replace(/^---[\s\S]*?---\s*/u, '');
      const bullets = (body.match(/^\s*[-*]\s+\S/gmu) ?? []).length;
      return {
        usable: true,
        checks: [
          check('made', 'The study aid was made and saved', true, 2),
          check(
            'summary-shape',
            'An opening paragraph and 3–8 bullets',
            bullets >= 3 && bullets <= 8,
            1,
            `${String(bullets)} bullets`,
          ),
        ],
        artifact: { kind: 'markdown', content: outcome.markdown },
        judgeInput: {
          rubricId: rubric.rubricId,
          context: `<document>\n${source}\n</document>`,
          reference: testCase.keyFacts.map((fact) => `- ${fact}`).join('\n'),
        },
        notes: outcome.notes,
      };
    },
  };

  /** Quiz questions or flashcards for every section, written into the document. */
  async function runCards(
    cardKind: StudyCardKind,
    source: string,
    testCase: StudyCase,
    context: TaskContext,
  ): Promise<TaskCaseResult> {
    const sections = studySectionsOf(markdownToDoc(parseMarkdown(source)));
    const refused: string[] = [];
    let made: Awaited<ReturnType<typeof generateStudyCards>>;
    try {
      made = await generateStudyCards(context.ai, sections, {
        kinds: [cardKind],
        model: { contextWindow: context.contextWindow },
        ...(context.signal ? { signal: context.signal } : {}),
        onAttempt: (_blockId, _kind, _attempt, outcome) => refused.push(...outcome.problems),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        usable: false,
        modelError: message,
        checks: [check('made', 'Cards were made and written into the document', false, 2, message)],
        artifact: null,
        judgeInput: null,
        notes: [message],
      };
    }
    const written = writeStudyCards(
      source,
      made.cards.map((card) => ({ op: 'add' as const, ownerId: card.ownerId, card: card.draft })),
    );
    const cards = readStudyCards(markdownToDoc(parseMarkdown(written.result))).cards.filter(
      (card) => card.origin === 'ai',
    );
    const asked = made.sections.reduce((sum, section) => sum + section.asked, 0);
    const sent = made.sections.filter((section) => !section.skipped);
    const covered = sent.filter((section) => section.accepted > 0).length;
    const fronts = cards.map((card) => studyCardTextKey(card.question));
    // Taking the cards out again must give back the document exactly.
    const removed = writeStudyCards(
      written.result,
      cards.map((card) => ({ op: 'remove' as const, key: card.key })),
    ).result;
    const checks = [
      check('made', 'Cards were made and written into the document', cards.length > 0, 2),
      check(
        'kept',
        'At least half the cards asked for passed the checks',
        asked > 0 && cards.length >= asked / 2,
        2,
        `${String(cards.length)} of ${String(asked)}`,
      ),
      check(
        'coverage',
        'At least half the sections sent got a card',
        sent.length > 0 && covered >= sent.length / 2,
        1,
        `${String(covered)} of ${String(sent.length)}`,
      ),
      check(
        'owned',
        'Every card sits under its section, can be studied, and is not flagged',
        cards.every((card) => !!card.ownerId && card.usable && !card.stale),
        1,
      ),
      check(
        'prose',
        'The document’s own text is unchanged',
        removed === source && written.rejected.length === 0,
        1,
        written.rejected[0]?.message,
      ),
      check(
        'distinct',
        'No two cards ask the same question',
        new Set(fronts).size === fronts.length,
        1,
      ),
      ...(cardKind === 'quiz'
        ? [
            check(
              'choices',
              'Every question has at least three choices and exactly one right answer',
              cards.every(
                (card) =>
                  (card.choices?.length ?? 0) >= 3 &&
                  (card.choices ?? []).filter((choice) => choice.correct).length === 1,
              ),
              1,
            ),
          ]
        : []),
    ];
    return {
      usable: cards.length > 0,
      checks,
      artifact: { kind: 'markdown', content: written.result },
      judgeInput: {
        rubricId: rubric.rubricId,
        context: `<document>\n${source}\n</document>`,
        reference: testCase.keyFacts.map((fact) => `- ${fact}`).join('\n'),
      },
      notes: [
        `${String(cards.length)} cards in ${String(covered)} sections`,
        ...refused.slice(0, 5),
      ],
    };
  }
}

export const studySummaryTask = studyTask(
  'summary',
  'Summary',
  'Summarize document: a summary paragraph and bullets, saved beside the document.',
);
export const studyQuizTask = studyTask(
  'quiz',
  'Quiz',
  'Quiz questions kept with each section: multiple choice, each grounded in its own section.',
);
export const studyFlashcardsTask = studyTask(
  'flashcards',
  'Flashcards',
  'Flashcards kept with each section: question and answer, each grounded in its own section.',
);
