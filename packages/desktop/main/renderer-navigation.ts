import { isTrustedRendererUrl } from '@bendyline/docblocks/host';

/**
 * Whether a server redirect must be stopped. Electron raises `will-redirect`
 * for every frame, but only the main frame is the DocBlocks renderer and must
 * stay on it. A subframe is a hosted video player, whose own redirects are its
 * business; the renderer's frame-src still checks every redirect target, so a
 * player frame cannot land anywhere the CSP does not allow.
 */
export function blocksRendererRedirect(
  details: { readonly url: string; readonly isMainFrame: boolean },
  developmentOrigin?: string,
): boolean {
  return details.isMainFrame && !isTrustedRendererUrl(details.url, developmentOrigin);
}
