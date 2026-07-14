/**
 * Clone-dialog helpers — pure URL utilities, unit-testable.
 */

/** Folder name a clone of this URL will produce (mirrors the host's rule). */
export function deriveCloneFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const lastSegment = trimmed.split(/[/:\\]/).pop() ?? '';
  const withoutGit = lastSegment.replace(/\.git$/i, '');
  const sanitized = withoutGit.replace(/[^A-Za-z0-9._-]/g, '-');
  return sanitized.length > 0 ? sanitized : 'repository';
}

/** Loose shape check for enabling the Clone button — the host re-validates. */
export function isLikelyGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  if (trimmed.startsWith('-') || trimmed.toLowerCase().startsWith('file:')) return false;
  if (/^(https?|ssh|git):\/\/\S+\/\S+/i.test(trimmed)) return true;
  // scp-like: user@host:owner/repo
  if (/^[\w.-]+@[\w.-]+:\S+/.test(trimmed)) return true;
  return false;
}
