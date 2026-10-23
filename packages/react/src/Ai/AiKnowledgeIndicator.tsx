import type { ReactNode } from 'react';
import type { AiChatKnowledge, AiFactCheck } from '@bendyline/docblocks/host';

import { KnowledgeIcon, SourcedFactsIcon, UnsourcedFactsIcon } from '../icons.js';

const QUIET_NOTES = {
  none: 'Your knowledge catalogs were searched, and nothing in them matched this request.',
  skipped:
    'Your knowledge catalogs could not be searched for this request. A long document can leave no room for reference passages.',
} as const;

/**
 * A small pill saying whether the person's knowledge catalogs informed the AI
 * output; it opens to list the cited articles or explain why none were.
 */
export function AiKnowledgeIndicator({ knowledge }: { knowledge: AiChatKnowledge | null }) {
  if (!knowledge) return null;
  if (knowledge.outcome !== 'used') {
    return (
      <details className="db-ai-knowledge db-ai-knowledge--quiet">
        <summary>
          <KnowledgeIcon />
          {knowledge.outcome === 'none' ? 'No matching knowledge' : 'Knowledge not searched'}
        </summary>
        <p>{QUIET_NOTES[knowledge.outcome]}</p>
      </details>
    );
  }
  const several = knowledge.sources.length > 1;
  const count = knowledge.sources.reduce((sum, source) => sum + source.titles.length, 0);
  return (
    <details className="db-ai-knowledge db-ai-knowledge--used">
      <summary>
        <KnowledgeIcon />
        {/* One line: long catalog names truncate here and show in full when opened. */}
        <span className="db-ai-knowledge-names">
          Knowledge: {knowledge.sources.map((source) => source.name).join(', ')}
        </span>
        {count > 0 && (
          <span className="db-ai-knowledge-count">
            {' '}
            · {count} {count === 1 ? 'article' : 'articles'}
          </span>
        )}
      </summary>
      <p>Passages from these articles were given to the model as reference material:</p>
      {knowledge.sources.map((source) => (
        <div key={source.catalogId} className="db-ai-knowledge-source">
          {several && <p className="db-ai-knowledge-catalog">{source.name}</p>}
          <ul>
            {source.titles.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** `text` with each unsourced detail marked, so the eye lands on what to check. */
function markDetails(text: string, details: readonly string[]): ReactNode[] {
  const terms = details
    // "2020 next to Panama": the source states 2020, but not beside that name.
    .map((detail) => detail.replace(/ next to .+$/u, ''))
    .filter(Boolean)
    .map((detail) => detail.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [text];
  // Whole words only, though "19" still marks the 19 in "19th".
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${terms.join('|')})(?=(?:st|nd|rd|th)?(?![\\p{L}\\p{N}]))`,
    'giu',
  );
  return text
    .split(pattern)
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

/**
 * Whether the draft states names, dates, numbers or quotations that none of
 * its sources show. Opens to list those sentences with the details marked.
 */
export function AiFactsIndicator({ check }: { check: AiFactCheck | null }) {
  if (!check || check.checked === 0) return null;
  if (check.unsourced.length === 0) {
    return (
      <details className="db-ai-knowledge db-ai-knowledge--quiet db-ai-facts--sourced">
        <summary>
          <SourcedFactsIcon />
          Details found in sources
        </summary>
        <p>
          Every name, date, number and quotation in the draft appears in your document, your
          instructions or the reference passages. The check cannot tell whether a source is right.
        </p>
      </details>
    );
  }
  const count = check.unsourced.length;
  return (
    <details className="db-ai-knowledge db-ai-facts">
      <summary>
        <UnsourcedFactsIcon />
        {count} {count === 1 ? 'statement' : 'statements'} to check
      </summary>
      <p>
        Neither your document, your instructions nor the reference passages show the marked details.
        The model may have written them from memory.
      </p>
      <ul>
        {check.unsourced.map((sentence, index) => (
          <li key={index}>
            {sentence.problem === 'bad-citation' ? (
              <>
                {sentence.text}{' '}
                <span className="db-ai-facts-note">
                  It cites {sentence.missing.join(', ')}, which is not one of the reference
                  passages.
                </span>
              </>
            ) : (
              markDetails(sentence.text, sentence.missing)
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
