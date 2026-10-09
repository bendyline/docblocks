import type { OnHeadersReceivedListenerDetails } from 'electron';
import { isTrustedRendererUrl } from '@bendyline/docblocks/host';

type RendererResponseDetails = Pick<
  OnHeadersReceivedListenerDetails,
  'url' | 'resourceType' | 'responseHeaders'
>;

const OWNED_RENDERER_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
]);

/**
 * Security headers owned by the DocBlocks renderer document.
 *
 * This must return null for subframes and subresources. Rewriting every
 * response in the shared Electron session also rewrites third-party player
 * responses, where DocBlocks' CSP and same-origin CORP make the frame fail.
 */
export function desktopRendererResponseHeaders(
  details: RendererResponseDetails,
  contentSecurityPolicy: string,
  developmentOrigin?: string,
): Record<string, string[]> | null {
  if (
    details.resourceType !== 'mainFrame' ||
    !isTrustedRendererUrl(details.url, developmentOrigin)
  ) {
    return null;
  }

  const responseHeaders = Object.fromEntries(
    Object.entries(details.responseHeaders ?? {}).filter(
      ([name]) => !OWNED_RENDERER_RESPONSE_HEADERS.has(name.toLowerCase()),
    ),
  );

  return {
    ...responseHeaders,
    'Cross-Origin-Resource-Policy': ['same-origin'],
    'Content-Security-Policy': [contentSecurityPolicy],
  };
}
