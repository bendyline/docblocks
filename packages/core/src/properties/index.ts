/**
 * @bendyline/docblocks/properties — the frontmatter properties DocBlocks
 * gives meaning to (due date, category, tags, repeat, completion), with the
 * calendar-date arithmetic they need.
 */

export {
  REPEAT_RULES,
  addDays,
  addMonths,
  compareDue,
  daysBetween,
  describeDue,
  dueDate,
  dueTime,
  isLocalDate,
  localDateOf,
  localTimeOf,
  nextOccurrence,
  normalizeDue,
  weekdayOf,
  type DueStatus,
  type DueValue,
  type LocalDate,
  type RepeatRule,
} from './dates.js';
export {
  DOCUMENT_PROPERTY_KEYS,
  DOCUMENT_PROPERTY_LIMITS,
  completedOn,
  isCompleted,
  type DocumentProperties,
  type DocumentPropertiesPatch,
  type DocumentPropertyKey,
} from './types.js';
export { hasTaskProperties, readDocumentProperties, splitFrontmatterList } from './read.js';
export {
  DocumentPropertyError,
  applyDocumentProperties,
  documentPropertyUpdates,
} from './write.js';
export { parseCapture, type Capture } from './capture.js';
export { countChecklist, countChecklistLines, type ChecklistProgress } from './checklist.js';
