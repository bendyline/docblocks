import { groundText, stripCitations, type EvidenceItem } from '@bendyline/gezel/grounding';
import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type {
  AiFactCheck,
  AiFactCheckRequest,
  AiFactCheckSentence,
} from '@bendyline/docblocks/host';

/** Statuses for a sentence that states something checkable. */
const CHECKABLE = new Set(['supported', 'unattributed', 'uncited', 'unsupported', 'bad-citation']);
/**
 * `unattributed` is left out: every detail is in some passage, the sentence
 * just cites the wrong one or none. A citation slip, not an invention.
 */
const UNSOURCED = new Set(['uncited', 'unsupported', 'bad-citation']);

/**
 * Gezel's factual-writing check (`groundText`): each sentence's years,
 * numbers, months, quotations and names must appear in the passage it cites,
 * in some other passage, or in the person's own text.
 *
 * With `citations`, the model was asked to cite passages as `[n]` and its
 * numbers are checked. Without (no passages, or a run whose requests numbered
 * them differently) a marker means nothing, so it is dropped and each sentence
 * is checked against all of the evidence. Either way this catches a detail
 * written from memory, not a wrong detail copied from a wrong source.
 */
export function checkFacts(request: AiFactCheckRequest): AiFactCheck {
  const evidence: EvidenceItem[] = request.evidence.map((text, index) => ({ n: index + 1, text }));
  const text = request.citations ? request.text : stripCitations(request.text);
  const grounding = groundText(text, evidence, { given: request.given });
  const unsourced: AiFactCheckSentence[] = [];
  let checked = 0;
  for (const sentence of grounding.sentences) {
    if (!CHECKABLE.has(sentence.status)) continue;
    checked += 1;
    if (!UNSOURCED.has(sentence.status)) continue;
    const kinds = new Map(sentence.checks.map((check) => [check.value, check.kind]));
    const missing = [...new Set(sentence.missing)];
    const badCitation = sentence.status === 'bad-citation';
    unsourced.push({
      text: shorten(sentence.text, AI_WIRE_LIMITS.factCheckSentenceCharacters),
      problem: badCitation ? 'bad-citation' : 'unsourced',
      missing: missing
        .slice(0, AI_WIRE_LIMITS.factCheckDetails)
        .map((detail) => shorten(detail, AI_WIRE_LIMITS.knowledgeTitleCharacters)),
      // A made-up citation is as strong as a made-up date. A number found
      // apart from its name has no check of its own.
      strong: badCitation || missing.some((detail) => (kinds.get(detail) ?? 'number') !== 'name'),
    });
  }
  // Stable: document order within each strength.
  unsourced.sort((a, b) => Number(b.strong) - Number(a.strong));
  return { checked, unsourced: unsourced.slice(0, AI_WIRE_LIMITS.factCheckSentences) };
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
