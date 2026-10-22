import { hostSupports, maybeGetDocBlocksHost } from '@bendyline/docblocks/host';

/**
 * Open an HTTP(S) URL in the system browser, or a `mailto:` URL to support in
 * the mail app, through the host when it has one.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const shell = maybeGetDocBlocksHost()?.shell;
  if (hostSupports('externalNavigation') && shell?.openExternal) {
    await shell.openExternal(url);
    return;
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}
