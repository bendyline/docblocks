/**
 * Git error classification — maps raw `git` stderr + exit code to the
 * structured `GitError` wire type. `classifyGitError` walks an ORDERED
 * regex table (first match wins — e.g. a remote "Repository not found"
 * must classify as remote-not-found before the local "not a git
 * repository" rule fires). Pure: no electron, no child_process.
 */

import type { GitError, GitErrorCode } from '@bendyline/docblocks/host';

/** Max raw stderr carried on a GitError (UI details disclosure). */
const MAX_STDERR_BYTES = 8 * 1024;

/** Remove credential-bearing URL components before data crosses into a renderer. */
export function redactGitOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|password|auth)=)[^\s&#]*/gi, '$1[redacted]');
}

/**
 * Ordered classification table. Order is load-bearing: earlier rules win,
 * so specific remote/auth failures beat generic local ones.
 */
const CLASSIFIERS: ReadonlyArray<readonly [GitErrorCode, RegExp]> = [
  [
    'auth-failed',
    /terminal prompts disabled|Authentication failed|could not read Username|could not read Password|Permission denied \(publickey|Invalid username or (password|token)|HTTP Basic: Access denied|401 Unauthorized/i,
  ],
  [
    'remote-not-found',
    /Repository not found|does not appear to be a git repository|remote error: access denied or repository not exported|ERROR: .* not found/i,
  ],
  [
    'network',
    /Could not resolve host|Connection (refused|timed out|reset)|unable to access.*(Failed to connect|Couldn't connect|Operation timed out)|no route to host|Network is unreachable/i,
  ],
  [
    'non-fast-forward',
    /non-fast-forward|fetch first|failed to push some refs|Updates were rejected/i,
  ],
  [
    'merge-conflict',
    /CONFLICT|Automatic merge failed|fix conflicts|needs merge|unmerged files|not concluded your merge|MERGE_HEAD exists/i,
  ],
  [
    'uncommitted-changes',
    /would be overwritten by|Please commit your changes or stash them|cannot pull with rebase: You have unstaged changes/i,
  ],
  [
    'identity-not-configured',
    /Please tell me who you are|empty ident|user\.email|user\.name.*not set/i,
  ],
  [
    'no-upstream',
    /no upstream branch|no tracking information|The current branch .* has no upstream/i,
  ],
  ['unborn-branch', /does not have any commits yet|ambiguous argument 'HEAD'|bad revision 'HEAD'/i],
  ['not-a-repository', /not a git repository/i],
  ['branch-exists', /already exists/i],
  ['invalid-ref-name', /is not a valid branch name|not a valid ref name|check-ref-format/i],
  ['detached-head', /HEAD is detached|detached HEAD/i],
  ['nothing-to-commit', /nothing to commit|no changes added to commit/i],
];

/** Classify raw git stderr into a GitErrorCode via the ordered table above. */
export function classifyGitError(exitCode: number | null, stderr: string): GitErrorCode {
  if (!stderr) return 'unknown';
  for (const [code, pattern] of CLASSIFIERS) {
    if (pattern.test(stderr)) return code;
  }
  return 'unknown';
}

/** First non-empty stderr line, with noise prefixes stripped; null if none. */
function firstMeaningfulLine(stderr: string): string | null {
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Skip pure hint/usage noise — it never summarizes the failure.
    if (/^hint:/i.test(line) || /^usage:/i.test(line)) continue;
    return line.replace(/^(fatal|error|warning):\s*/i, '');
  }
  return null;
}

/**
 * Build a structured GitError: classify stderr, pick a concise one-line
 * message (first meaningful stderr line, else the fallback), and carry the
 * raw stderr truncated to 8 KB for a details disclosure.
 */
export function makeGitError(
  exitCode: number | null,
  stderr: string,
  fallbackMessage?: string,
): GitError {
  const code = classifyGitError(exitCode, stderr);
  const sanitizedStderr = redactGitOutput(stderr);
  const message = firstMeaningfulLine(sanitizedStderr) ?? fallbackMessage ?? 'git command failed';
  const error: GitError = { code, message };
  const trimmedStderr = sanitizedStderr.trim();
  if (trimmedStderr.length > 0) {
    error.stderr =
      trimmedStderr.length > MAX_STDERR_BYTES
        ? trimmedStderr.slice(0, MAX_STDERR_BYTES)
        : trimmedStderr;
  }
  if (exitCode !== null) error.exitCode = exitCode;
  return error;
}
