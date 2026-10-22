import { groundText, stripCitations, type EvidenceItem } from '@bendyline/gezel';
import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type {
  AiFactCheck,
  AiFactCheckRequest,
  AiFactCheckSentence,
} from '@bendyline/docblocks/host';

/** Statuses for a sentence that states something checkable. */
const CHECKABLE = new Set(['supported', 'unattributed', 'uncited', 'unsupported', 'bad-citation']);
const UNSOURCED = new Set(['uncited', 'unsupported', 'bad-citation']);

/**
 * Gezel's factual-writing check (`groundText`), run without citations.
 *
 * DocBlocks does not number the passages it sends yet, so the model is not
 * asked to cite them, and a stray `[n]` is dropped rather than read as one.
 * Each sentence's years, numbers, months, quotations and names must then
 * appear in some passage or in the person's own text; a sentence whose
 * details appear nowhere is reported. That catches a detail written from
 * memory, not a true detail attached to the wrong source.
 */
export function checkFacts(request: AiFactCheckRequest): AiFactCheck {
  const evidence: EvidenceItem[] = request.evidence.map((text, index) => ({ n: index + 1, text }));
  const grounding = groundText(stripCitations(request.text), evidence, { given: request.given });
  const unsourced: AiFactCheckSentence[] = [];
  let checked = 0;
  for (const sentence of grounding.sentences) {
    if (!CHECKABLE.has(sentence.status)) continue;
    checked += 1;
    if (!UNSOURCED.has(sentence.status)) continue;
    const kinds = new Map(sentence.checks.map((check) => [check.value, check.kind]));
    const missing = [...new Set(sentence.missing)];
    unsourced.push({
      text: shorten(sentence.text, AI_WIRE_LIMITS.factCheckSentenceCharacters),
      missing: missing
        .slice(0, AI_WIRE_LIMITS.factCheckDetails)
        .map((detail) => shorten(detail, AI_WIRE_LIMITS.knowledgeTitleCharacters)),
      // A number found apart from its name has no check of its own.
      strong: missing.some((detail) => (kinds.get(detail) ?? 'number') !== 'name'),
    });
  }
  // Stable: document order within each strength.
  unsourced.sort((a, b) => Number(b.strong) - Number(a.strong));
  return { checked, unsourced: unsourced.slice(0, AI_WIRE_LIMITS.factCheckSentences) };
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
