/**
 * macOS App Sandbox helpers (Mac App Store builds only).
 *
 * A sandboxed app loses access to user-picked folders when it relaunches.
 * The picker mints a *security-scoped bookmark* (a base64 blob) that we
 * persist; on the next launch we re-open access with it before touching the
 * folder via node:fs.
 *
 * Every function here is a guarded no-op outside a MAS build (`process.mas`
 * is only true when packaged for the Mac App Store), so the Developer-ID /
 * Windows / Linux builds are completely unaffected.
 */

import { app } from 'electron';

/** True only in a Mac App Store (sandboxed) build. */
export function isSandboxed(): boolean {
  return process.mas === true;
}

// Access handles kept open for the app's lifetime; released on quit.
const activeStops: Array<() => void> = [];

/**
 * Begin accessing a folder from its saved security-scoped bookmark. The
 * access is held until {@link releaseAllScopedResources} (app quit). Returns
 * true if access was (re)established. No-op returning false outside MAS or
 * when no bookmark is available.
 */
export function startAccessingBookmark(bookmark: string | undefined): boolean {
  if (!isSandboxed() || !bookmark) return false;
  try {
    // Electron types this as the generic `Function`; it's a zero-arg stopper.
    const stop = app.startAccessingSecurityScopedResource(bookmark) as () => void;
    activeStops.push(stop);
    return true;
  } catch {
    // A stale/invalid bookmark (folder moved or deleted) throws — the
    // workspace simply won't be reachable until the user re-opens it.
    return false;
  }
}

/** Release every scoped-resource handle. Call once on app quit. */
export function releaseAllScopedResources(): void {
  while (activeStops.length > 0) {
    const stop = activeStops.pop();
    try {
      stop?.();
    } catch {
      // best-effort — never block shutdown
    }
  }
}
