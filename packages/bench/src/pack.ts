/**
 * docbench: every AI workload DocBlocks ships, as a model benchmark.
 *
 * The families and their weights are the benchmark's definition of "good at
 * DocBlocks work"; a change to them, to a fixture, or to a rubric changes
 * {@link DOCBENCH_VERSION}, and scores are compared only within one version.
 * Families with no task yet still carry their weight here so the definition
 * is visible; a harness scores the families present and says which are not.
 */

import {
  BENCH_PACK_SCHEMA_VERSION,
  type BenchFamily,
  type BenchPackManifest,
  type BenchTaskInfo,
} from './contract.js';
import { fixtureSet } from './fixtures.js';
import { illustrationTask } from './tasks/illustration.js';
import { narrationTask } from './tasks/narration.js';
import { presentationTask } from './tasks/presentation.js';
import { reviewGeneralTask, reviewResumeTask, styleReviewTask } from './tasks/review.js';
import { studyFlashcardsTask, studyQuizTask, studySummaryTask } from './tasks/study.js';
import type { BenchTask } from './tasks/types.js';
import { designBriefTask, diagramDrawTask, diagramPlanTask } from './tasks/visuals.js';
import { appendTask, composeTask, insertTask, rewriteTask } from './tasks/writing.js';

export const DOCBENCH_ID = 'docbench';
/**
 * 0.2: every family has tasks. General review (with complexity levels) and
 * content generation (compose, append, insert, rewrite) join the slice;
 * presentations' checks share dropped from 0.5 to 0.3. 0.2.1: narration
 * cleanup no longer lets a thinking model reason away its whole output cap
 * (a product fix this benchmark found), so 0.2.0 narration scores are stale.
 * 0.2.2: a stream Gezel ends with an error is a failed request, as the
 * product shows it, not an empty reply; engine crashes in mid-stream are
 * infrastructure and retried. Scores move only where an engine crashed.
 */
export const DOCBENCH_VERSION = '0.2.2';

/**
 * What "good at DocBlocks work" weighs. Reviewing and writing are what people
 * use most, so they carry half the score between them.
 */
export const DOCBENCH_FAMILIES: readonly BenchFamily[] = [
  { id: 'review', label: 'Review and feedback', weight: 0.25 },
  { id: 'writing', label: 'Writing new content', weight: 0.25 },
  { id: 'visuals', label: 'Diagrams and illustrations', weight: 0.2 },
  { id: 'presentations', label: 'Presentations', weight: 0.1 },
  { id: 'study', label: 'Study aids', weight: 0.15 },
  { id: 'narration', label: 'Narration cleanup', weight: 0.05 },
];

/** Review styles beyond General and Resume, each with its own seeded documents. */
const STYLE_REVIEWS = (['facts', 'concise', 'plain', 'strunk', 'un', 'creative'] as const).map(
  styleReviewTask,
);

export const DOCBENCH_TASKS: readonly BenchTask[] = [
  reviewGeneralTask,
  reviewResumeTask,
  ...STYLE_REVIEWS,
  composeTask,
  appendTask,
  insertTask,
  rewriteTask,
  diagramPlanTask,
  diagramDrawTask,
  illustrationTask,
  designBriefTask,
  presentationTask,
  studySummaryTask,
  studyQuizTask,
  studyFlashcardsTask,
  narrationTask,
] as readonly BenchTask[];

export function findTask(id: string): BenchTask | undefined {
  return DOCBENCH_TASKS.find((task) => task.info.id === id);
}

export function describePack(): BenchPackManifest {
  const tasks: BenchTaskInfo[] = DOCBENCH_TASKS.map((task) => ({
    ...task.info,
    cases: task.cases().map(({ id, label }) => ({ id, label })),
  }));
  return {
    schemaVersion: BENCH_PACK_SCHEMA_VERSION,
    id: DOCBENCH_ID,
    version: DOCBENCH_VERSION,
    fixtures: fixtureSet(),
    families: DOCBENCH_FAMILIES,
    tasks,
  };
}
