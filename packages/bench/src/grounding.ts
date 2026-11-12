/**
 * The desktop's fact check (`packages/desktop/main/ai/fact-check.ts`), as the
 * draft dialog runs it before Insert: Gezel's model-free `groundText` checks
 * each sentence's years, numbers, months, quotations and names against what
 * the person supplied. Here there are no knowledge passages, so a detail is
 * sourced only when the instructions or the document show it. Keep the
 * statuses in step with the desktop's.
 */

import { groundText, stripCitations } from '@bendyline/gezel/grounding';

/** Sentence statuses the desktop treats as stating something no source shows. */
const UNSOURCED = new Set(['uncited', 'unsupported', 'bad-citation']);

export interface UnsourcedDetails {
  /** Sentences that state something checkable. */
  readonly checked: number;
  /**
   * Details no source shows that are not just names: a number, date, month or
   * quotation. These are what make the desktop ask "Use details no source shows?".
   */
  readonly strong: readonly string[];
  /** Names no source shows; the desktop reports these more softly. */
  readonly names: readonly string[];
}

export function unsourcedDetails(text: string, given: string): UnsourcedDetails {
  const grounding = groundText(stripCitations(text), [], { given });
  const strong = new Set<string>();
  const names = new Set<string>();
  let checked = 0;
  for (const sentence of grounding.sentences) {
    if (sentence.status === 'non-factual' || sentence.status === 'cited') continue;
    checked += 1;
    if (!UNSOURCED.has(sentence.status)) continue;
    const kinds = new Map(sentence.checks.map((check) => [check.value, check.kind]));
    for (const detail of sentence.missing) {
      if ((kinds.get(detail) ?? 'number') === 'name') names.add(detail);
      else strong.add(detail);
    }
  }
  return { checked, strong: [...strong], names: [...names] };
}
