/**
 * Git input validation — pure predicates the git command layer uses to
 * reject bad branch names, SHAs, remote names, and clone URLs BEFORE
 * anything reaches a spawned `git` process. Branch validation mirrors
 * `git check-ref-format --branch` without spawning; URL validation exists
 * to block argument injection (leading '-') and local-path exfiltration.
 */

/** ASCII control chars (<0x20, 0x7f) plus space — banned everywhere in refs. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/** Chars git forbids anywhere in a ref name: ~ ^ : ? * [ \ */
const FORBIDDEN_REF_CHARS = /[~^:?*[\\]/;

/** Mirrors `git check-ref-format --branch` rules without spawning git. */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === '@') return false;
  if (name.startsWith('-') || name.startsWith('.')) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (CONTROL_OR_SPACE.test(name)) return false;
  if (FORBIDDEN_REF_CHARS.test(name)) return false;
  for (const component of name.split('/')) {
    if (component.endsWith('.lock')) return false;
  }
  return true;
}

/** Full or abbreviated (>= 4 hex chars) object SHA. */
export function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(sha);
}

/** Remote names: alphanumeric start, then alphanumerics, '.', '_', '-'. */
export function isValidRemoteName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** URL-scheme clone sources we accept. `file://` is deliberately absent. */
const URL_SCHEME = /^(https?|ssh|git):\/\/[^/]+\/?.*$/i;

/** scp-like syntax: user@host:path (no scheme). */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/;

/**
 * Accepts https/http/ssh/git URLs and scp-like `user@host:path`. Rejects
 * leading '-' (argument injection), `file://`, whitespace/control chars,
 * and — unless `opts.allowLocal` (a test-only escape hatch) — absolute or
 * relative filesystem paths.
 */
export function isValidCloneUrl(url: string, opts?: { allowLocal?: boolean }): boolean {
  if (url.length === 0) return false;
  if (url.startsWith('-')) return false;
  if (/\s/.test(url) || CONTROL_OR_SPACE.test(url)) return false;

  if (/^file:\/\//i.test(url)) return Boolean(opts?.allowLocal);

  if (URL_SCHEME.test(url)) return true;
  if (SCP_LIKE.test(url)) return true;

  // Anything else is a filesystem path (absolute, drive-letter, or relative)
  // or garbage — only permitted via the test-only escape hatch.
  return Boolean(opts?.allowLocal);
}
