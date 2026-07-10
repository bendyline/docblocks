/**
 * parse-log — pure parser for `git log` output produced with LOG_FORMAT.
 * Records are newline-separated (the format contains no %n and %s never
 * contains newlines); fields are NUL-separated within a record. Consumed
 * by the git commands layer; no process or fs access here.
 */

import type { GitLogEntry } from '@bendyline/docblocks/host';

/** The exact --format value commands.ts passes to git log. */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s';

export function parseLog(stdout: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\0');
    if (fields.length < 7) continue;
    const [sha, parentsRaw, authorName, authorEmail, authorDate, refsRaw] = fields;
    // %s is the last field; if the subject somehow contained a NUL it would
    // have been split — rejoin everything after the sixth separator.
    const subject = fields.slice(6).join('\0');
    entries.push({
      sha,
      parents: parentsRaw === '' ? [] : parentsRaw.split(' '),
      authorName,
      authorEmail,
      authorDate,
      subject,
      refs: refsRaw === '' ? [] : refsRaw.split(', '),
    });
  }
  return entries;
}
