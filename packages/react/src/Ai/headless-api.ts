/**
 * `@bendyline/docblocks-react/ai`: the AI pipelines without any UI.
 *
 * These are the same functions the editor's panels call — request builders,
 * reply readers, repairs and retries — exported so something other than the
 * editor can drive them. The docbench task pack does, to score models on
 * exactly what a person would be shown. Every function takes an
 * `ai: { chat }` with the `DocBlocksHostAiAPI` contract, so any transport
 * that honours it works.
 *
 * No React component is reachable from here. Some pipelines read Markdown and
 * validate Mermaid through `@bendyline/squisq-editor-react`, which expects a
 * DOM: in Node, register one (happy-dom) before calling them.
 */

export { chatOnce, type ChatApi, type ChatOutcome } from './chat-once.js';

// Review
export {
  AI_REVIEW_DOCUMENT_CHARACTERS,
  REVIEW_PASSES,
  applyAiReviewFinding,
  findUniqueExcerpt,
  parseAiReviewResponse,
  type AiReviewFinding,
  type AiReviewParse,
} from './ai-assistant.js';
export {
  REVIEW_TOO_LONG_MESSAGE,
  numberReviewFindings,
  readReviewReply,
  reviewDocument,
  reviewStepRequest,
  startReviewRun,
  type ReviewReply,
  type ReviewReplyResult,
  type ReviewResult,
  type ReviewRun,
  type ReviewStart,
  type ReviewStep,
} from './review-run.js';
export { reviewFindingLimit } from './review-parts.js';
export {
  AI_REVIEW_STYLES,
  AI_REVIEW_STYLE_DEFINITIONS,
  isAiReviewStyle,
  type AiReviewStyle,
  type AiReviewStyleDefinition,
} from './review-styles.js';

// Writing
export {
  AI_INSTRUCTION_CHARACTERS,
  AI_REWRITE_SELECTION_CHARACTERS,
  buildDraftContinuation,
  buildDraftRequest,
  sanitizeGeneratedMarkdown,
  type AiDraftMode,
} from './ai-assistant.js';
export {
  draftToApply,
  runDraft,
  settleDraft,
  type DraftResult,
  type SettledDraft,
} from './draft-run.js';

// Study budgets and narration limits the pipelines size themselves by
export { studyBudget } from './study-sections.js';
export { MAX_NARRATION_CHARACTERS } from '../Speech/narration-text.js';

// Pictures
export {
  drawDiagram,
  findIdeas,
  realizeDiagram,
  startIllustrationRun,
  type DiagramOutcome,
  type FindIdeasOutcome,
  type IllustrationEvent,
  type IllustrationRun,
} from './illustrate-pipeline.js';
export { promptBudget, type PlanPick, type PromptBudget } from './illustrate-prompts.js';
export { segmentPassages, type Passage } from './illustrate-passages.js';
export {
  ILLUSTRATION_MIN_CONTEXT,
  canDrawIllustrations,
  extractSvg,
  illustrationTokens,
  inventedNumbers,
  realizeIllustration,
  type IllustrationOptions,
  type PictureOutcome,
} from './illustration.js';
export {
  checkBriefGrounding,
  designPrompt,
  parseBrief,
  realizeDesign,
  type DesignBrief,
} from './design-brief.js';
export type { CompiledDiagram } from './diagram-compile.js';
export type { DiagramKind, DiagramSpec } from './diagram-spec.js';

// Study aids
export {
  FLASHCARD_CARDS,
  MIN_STUDY_CHARACTERS,
  QUIZ_QUESTIONS,
  generateStudyAid,
  type StudyOptions,
  type StudyOutcome,
} from './study-pipeline.js';

// Presentations
export {
  refinePresentationPlan,
  type RefinePresentationOptions,
} from '../Presentation/presentation-ai.js';

// Narration
export { rewriteNarration } from '../Speech/narration-rewrite.js';
