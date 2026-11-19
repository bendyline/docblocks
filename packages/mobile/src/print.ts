/**
 * `window.print()` for the native WebViews, which have none.
 *
 * WKWebView and Android WebView both accept `print()` and do nothing, so the
 * Print button in the editor's print preview did nothing on a phone. This
 * gives the page a `print()` that opens the system print dialog
 * (UIPrintInteractionController on iOS, PrintManager on Android) and keeps
 * the browser's contract around it: `beforeprint` first, then `afterprint`
 * once the dialog closes. Squisq's print preview sets up its print-only
 * layout for the dialog and puts it away on `afterprint`.
 *
 * Two kinds of print go through here:
 * - The page itself. Native prints the app's own WebView under its print
 *   styles, which is how Squisq prints slides, pages and flashcards.
 * - A same-origin frame. Squisq prints a text document by calling `print()`
 *   on its preview iframe, but native can print only a top-level page. The
 *   frame's document is therefore sent as a standalone page and printed by
 *   a WebView of its own. Its blob: pictures become data: URLs, because
 *   blob: URLs belong to this page. It also carries this page's
 *   Content-Security-Policy, so it loads only what the preview could load.
 */

export interface NativePrinter {
  /** Prints the app's own page under its print styles. Resolves when the dialog closes. */
  printPage(jobName: string): Promise<void>;
  /** Prints a standalone HTML page. Resolves when the dialog closes. */
  printDocument(jobName: string, html: string): Promise<void>;
}

/** A blob: URL as it appears in markup, in an attribute, a srcset or a CSS url(). */
const BLOB_URL = /blob:[^\s"'()<>,&\\]+/g;

const FALLBACK_JOB_NAME = 'DocBlocks';

export function installNativePrint(
  printer: NativePrinter,
  report: (error: unknown) => void,
  win: Window = window,
): void {
  // The system print dialog is modal. A second print while it is up does
  // nothing, as a second print does behind a browser's dialog.
  let busy = false;
  const run = (target: Window, job: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    target.dispatchEvent(new Event('beforeprint'));
    void job()
      .catch(report)
      .finally(() => {
        busy = false;
        target.dispatchEvent(new Event('afterprint'));
      });
  };

  win.print = () => run(win, () => printer.printPage(printJobName(win.document.title)));

  const adopt = (frame: HTMLIFrameElement) => {
    let frameWindow: Window | null;
    try {
      frameWindow = frame.contentWindow;
      // A cross-origin frame (an embedded video player) throws here; it was
      // never printable from this page.
      if (!frameWindow?.document) return;
    } catch {
      return;
    }
    const target = frameWindow;
    target.print = () =>
      run(target, async () =>
        printer.printDocument(
          printJobName(target.document.title),
          await standalonePage(target.document, win.document),
        ),
      );
  };
  // A frame gets a new window each time it loads, so it is adopted on every
  // load. `load` does not bubble, but it does pass through capture.
  win.document.addEventListener(
    'load',
    (event) => {
      const { HTMLIFrameElement: Frame } = win as Window & typeof globalThis;
      if (event.target instanceof Frame) adopt(event.target);
    },
    true,
  );
  for (const frame of Array.from(win.document.querySelectorAll('iframe'))) adopt(frame);
}

/**
 * A print job's name, which also names the staged page: no path separators
 * or control characters, at most 120 characters, never empty.
 */
export function printJobName(title: string): string {
  const name = title
    // eslint-disable-next-line no-control-regex -- control characters are what this removes.
    .replace(/[\\/:\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return name && name !== '.' && name !== '..' ? name : FALLBACK_JOB_NAME;
}

/**
 * `page` serialized as a page that stands on its own. Its blob: URLs become
 * data: URLs, and `app`'s Content-Security-Policy leads its head.
 */
export async function standalonePage(
  page: Document,
  app: Document,
  readBlob: (url: string) => Promise<string> = blobAsDataUrl,
): Promise<string> {
  let html = page.documentElement.outerHTML;
  const urls = [...new Set(html.match(BLOB_URL) ?? [])];
  const inlined = await Promise.all(
    // A picture that can no longer be read keeps its URL and prints as a
    // broken image rather than stopping the whole print.
    urls.map(async (url) => [url, await readBlob(url).catch(() => url)] as const),
  );
  for (const [url, data] of inlined) html = html.split(url).join(data);

  const policy = app
    .querySelector('meta[http-equiv="Content-Security-Policy" i]')
    ?.getAttribute('content');
  if (policy) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`;
    html = html.replace(/<head\b[^>]*>/i, (open) => open + meta);
  }
  const doctype = page.doctype ? `<!DOCTYPE ${page.doctype.name}>` : '';
  return doctype + html;
}

async function blobAsDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
