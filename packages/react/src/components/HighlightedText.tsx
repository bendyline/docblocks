import { Fragment, type ReactNode } from 'react';

export interface HighlightedTextProps {
  readonly text: string;
  /** Sorted, non-overlapping `[start, end)` ranges to mark. */
  readonly ranges: readonly (readonly [number, number])[];
}

/** Text with matched ranges wrapped in `<mark>`, for quick-open and search results. */
export function HighlightedText({ text, ranges }: HighlightedTextProps) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(cursor, Math.min(rawStart, text.length));
    const end = Math.min(rawEnd, text.length);
    if (end <= start) continue;
    if (start > cursor)
      parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor, start)}</Fragment>);
    parts.push(
      <mark key={`m${start}`} className="db-search-match">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length)
    parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}
