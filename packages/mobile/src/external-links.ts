import { parseExternalHttpUrl } from '@bendyline/docblocks/host';

/**
 * Both native WebView boundaries cancel every navigation away from the
 * packaged editor, so a plain `<a target="_blank">` (About, Docs, Terms,
 * Report issue) would do nothing. Activated external links go through the
 * host's exact HTTP URL policy instead. Handlers that already took a click
 * (editor and preview links call preventDefault) and links inside editable
 * content, where a click places the caret, are left alone.
 */
export function routeExternalLinks(
  openExternal: (url: string) => Promise<void>,
  root: Document = document,
): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.isContentEditable) return;
    const url = parseExternalHttpUrl(anchor.href);
    if (!url || new URL(url).origin === root.location?.origin) return;
    event.preventDefault();
    // The policy above already matches the host's, so a failure here is the
    // OS declining to open the browser; there is nothing to retry.
    void openExternal(url).catch(() => undefined);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
