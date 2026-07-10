/**
 * clone-progress — stateful parser for `git clone --progress` stderr output.
 * Feed raw chunks as they arrive; lines are buffered until terminated by
 * `\r` (in-place progress updates) or `\n`, parsed into GitCloneProgress
 * events, and deduplicated so identical consecutive phase+percent pairs are
 * emitted only once. Pure module: no electron / node imports.
 */

import type { GitCloneProgress } from '@bendyline/docblocks/host';

/** `Receiving objects:  42% (123/291)` → phase + percent. */
const PERCENT_RE = /^(.+?):\s+(\d{1,3})%/;

/** `Counting objects: 5, done.` — phase followed by a count, no percent. */
const COUNT_RE = /^(.+?):\s+\d+(?:\s*\(|,|$)/;

/**
 * Stateful stderr-chunk parser: feed raw chunks, emits parsed progress
 * events via `onProgress`.
 */
export function createCloneProgressParser(
  onProgress: (p: GitCloneProgress) => void,
): (chunk: string) => void {
  let buffer = '';
  let lastKey: string | null = null;

  function handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;

    // `remote: Counting objects: 5, done.` — strip the prefix, keep the
    // inner phase, but preserve the full raw line as detail.
    const inner = line.replace(/^remote:\s*/, '').trim();
    if (!inner) return;

    let phase: string;
    let percent: number | null;

    const percentMatch = PERCENT_RE.exec(inner);
    if (percentMatch) {
      phase = percentMatch[1].trim();
      percent = Number(percentMatch[2]);
    } else if (/^Cloning into\b/.test(inner)) {
      phase = 'Cloning into';
      percent = null;
    } else {
      const countMatch = COUNT_RE.exec(inner);
      if (!countMatch) return;
      phase = countMatch[1].trim();
      percent = null;
    }

    const key = `${phase}|${String(percent)}`;
    if (key === lastKey) return;
    lastKey = key;
    onProgress({ phase, percent, detail: line });
  }

  return (chunk: string): void => {
    buffer += chunk;
    const parts = buffer.split(/[\r\n]/);
    buffer = parts.pop() ?? '';
    for (const part of parts) handleLine(part);
  };
}
