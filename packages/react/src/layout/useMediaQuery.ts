import { useEffect, useState } from 'react';

/**
 * The display modes that mean "running as an installed app" rather than in a
 * browser tab. Previously duplicated in `DocBlocksShell/document-title.ts` and
 * `Export/browser-save.ts`; both now import this.
 */
export const INSTALLED_DISPLAY_QUERIES = [
  '(display-mode: window-controls-overlay)',
  '(display-mode: standalone)',
] as const;

export function matchesMediaQuery(query: string): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia(query).matches;
}

export function isInstalledDisplayMode(): boolean {
  return INSTALLED_DISPLAY_QUERIES.some(matchesMediaQuery);
}

/**
 * Subscribe to one media query.
 *
 * `useOsTheme`, `useResponsivePreviewViewportPreset`, and the old
 * `useIsMobile` each hand-rolled this same effect. Guards `matchMedia` because
 * the unit suite runs under happy-dom and the shell is also rendered in
 * non-browser contexts.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesMediaQuery(query));

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return;
    const list = globalThis.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    // Re-read on subscribe: the query may have changed between the initial
    // render and this effect.
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}
