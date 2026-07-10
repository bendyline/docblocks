/**
 * parse-refs — pure parser for `git for-each-ref` output produced with
 * FOR_EACH_REF_FORMAT. One record per line, NUL-separated fields. Skips
 * symbolic remote HEAD entries (e.g. origin/HEAD). Consumed by the git
 * commands layer; no process or fs access here.
 */

import type { GitBranchInfo } from '@bendyline/docblocks/host';

export const FOR_EACH_REF_FORMAT =
  '%(HEAD)%00%(refname:short)%00%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso8601-strict)%00%(contents:subject)';

function parseTrack(track: string): { ahead: number; behind: number; upstreamGone: boolean } {
  const result = { ahead: 0, behind: 0, upstreamGone: false };
  if (track === '') return result;
  if (track === '[gone]') {
    result.upstreamGone = true;
    return result;
  }
  const aheadMatch = /\bahead (\d+)/.exec(track);
  if (aheadMatch) result.ahead = Number(aheadMatch[1]);
  const behindMatch = /\bbehind (\d+)/.exec(track);
  if (behindMatch) result.behind = Number(behindMatch[1]);
  return result;
}

export function parseForEachRef(stdout: string): GitBranchInfo[] {
  const branches: GitBranchInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\0');
    if (fields.length < 8) continue;
    const [head, shortName, refName, objectName, upstreamShort, upstreamTrack, date] = fields;
    // %(contents:subject) is the last field; rejoin in case it contained a NUL.
    const subject = fields.slice(7).join('\0');
    // Symbolic remote HEAD (e.g. refs/remotes/origin/HEAD) — not a real branch.
    if (shortName.endsWith('/HEAD')) continue;
    const { ahead, behind, upstreamGone } = parseTrack(upstreamTrack);
    branches.push({
      name: shortName,
      kind: refName.startsWith('refs/remotes/') ? 'remote' : 'local',
      current: head === '*',
      upstream: upstreamShort === '' ? null : upstreamShort,
      ahead,
      behind,
      upstreamGone,
      headSha: objectName,
      headSubject: subject,
      headDate: date,
    });
  }
  return branches;
}
