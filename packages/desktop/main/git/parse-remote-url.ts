/**
 * parse-remote-url — pure helpers that map a git remote URL (https, http,
 * ssh://, or scp-like `user@host:owner/repo.git`) to a host-agnostic web
 * location, and derive the directory name a `git clone` of that URL would
 * create. No electron / node imports; consumed by the git commands layer.
 */

export interface ParsedRemoteWeb {
  host: string;
  owner: string;
  repo: string;
  webUrl: string;
}

/** Schemes we know how to map to a web URL. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * scp-like form: `[user@]host:path`. Host must be at least two chars so
 * Windows drive paths (`C:\...`, `C:/...`) never match, and must appear
 * before any `/`.
 */
const SCP_RE = /^(?:[^@\s/]+@)?([A-Za-z0-9._-]{2,}):(.+)$/;

function buildResult(host: string, rawPath: string): ParsedRemoteWeb | null {
  const segments = rawPath
    .replace(/^~\/?/, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1].replace(/\.git$/i, '');
  if (!repo) return null;
  const owner = segments.slice(0, -1).join('/');
  return { host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
}

/**
 * Host-agnostic remote → web mapping; null when unparseable (file://, local
 * paths, no path segments). The web URL is always https with any port
 * dropped, e.g. `ssh://git@host:2222/o/r.git` → `https://host/o/r`.
 */
export function parseRemoteUrl(url: string): ParsedRemoteWeb | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  const schemeMatch = SCHEME_RE.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh') return null;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!parsed.hostname) return null;
    return buildResult(parsed.hostname, parsed.pathname);
  }

  // Absolute / relative local paths are not remotes.
  if (trimmed.startsWith('/') || trimmed.startsWith('.') || trimmed.startsWith('\\')) return null;

  const scp = SCP_RE.exec(trimmed);
  if (scp) {
    const host = scp[1].toLowerCase();
    const path = scp[2];
    // A colon followed by a port-only path is not an scp-like remote.
    if (/^\d+$/.test(path)) return null;
    if (path.startsWith('\\')) return null;
    return buildResult(host, path);
  }

  return null;
}

/**
 * Directory name a clone of this URL should produce: last path segment sans
 * `.git`, sanitized `[^A-Za-z0-9._-]` → `-`, fallback `'repository'`.
 */
export function deriveRepoDirName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const cut = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf(':'),
    trimmed.lastIndexOf('\\'),
  );
  const segment = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  const name = segment
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 120);
  if (
    !name ||
    /^\.+$/u.test(name) ||
    /\.$/u.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  ) {
    return 'repository';
  }
  return name;
}
