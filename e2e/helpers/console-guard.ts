/**
 * Runtime-error invariant shared by the browser E2E suites.
 *
 * Playwright fails a test when an assertion fails, not when the page logs an
 * error, so a failed lazy chunk, a blocked resource, or an unhandled rejection
 * can pass green for as long as the assertions under test still hold. The
 * 2.6.2 ship-readiness audit found exactly that shape of fault: map tiles
 * blocked by the production CSP, each failure caught per tile, and a canvas
 * that looked rendered while being empty.
 *
 * This module collects `console.error` and uncaught page errors for a page and
 * reports the ones that are not explicitly allowed. Adding an allowance is a
 * deliberate act: each entry carries the reason it is not our bug to fix.
 */

import type { ConsoleMessage, Page } from '@playwright/test';

export interface AllowedRuntimeError {
  /** Why this message is not a DocBlocks defect. */
  readonly reason: string;
  /** Pattern for the message text. */
  readonly match?: RegExp;
  /**
   * Pattern for the reporting location. A blocked or missing resource reports a
   * generic text ("Failed to load resource: … 404") and names the resource only
   * here, so matching on text alone would allow every 404 on the page.
   */
  readonly location?: RegExp;
}

export interface RuntimeError {
  readonly kind: 'console.error' | 'pageerror';
  readonly text: string;
  readonly location: string;
}

/**
 * Messages that are not DocBlocks defects.
 *
 * Keep this list short and specific. A broad pattern here silently re-opens the
 * gap this guard exists to close, so prefer anchoring on the exact text and
 * naming the owner in `reason`.
 */
export const SHARED_ALLOWED_RUNTIME_ERRORS: readonly AllowedRuntimeError[] = [
  {
    // `interactive-widget=resizes-content` in packages/site/index.html is a
    // Chrome-only viewport key that keeps the on-screen keyboard from covering
    // the caret (see packages/react/src/layout/useKeyboardInset.ts). WebKit
    // announces that it ignored the key, which is the progressive enhancement
    // working as intended rather than a defect.
    reason: 'WebKit reports ignoring the Chrome-only interactive-widget viewport key',
    match: /Viewport argument key "interactive-widget" not recognized/u,
  },
  {
    // Upstream defect in @bendyline/squisq-editor-react: a ProseMirror widget
    // decoration calls ReactDOMRoot.render() synchronously while the editor
    // view updates, which React reports as a nested update from render. React
    // logs it in development builds only. Squisq is a dependency, not a fork,
    // so the fix belongs in ../squisq; the component name keeps this allowance
    // from also hiding the same mistake in a DocBlocks component.
    reason: 'upstream: squisq-editor-react WysiwygEditor renders a widget during a view update',
    match: /Render methods should be a pure function[\s\S]*WysiwygEditor/u,
  },
  {
    // Upstream: Tiptap's React node-view renderer creates node views with
    // flushSync. When squisq's WysiwygEditor pushes an external source change
    // (a timeline edit, a media-edit recipe) into Tiptap from its sync effect,
    // the audio/video/image node views it recreates flush inside that React
    // lifecycle and React logs this development-only warning. The render still
    // completes; the fix (deferring the external setContent) belongs in
    // ../squisq.
    reason: 'upstream: Tiptap node views flush during squisq WysiwygEditor external sync',
    match:
      /^Warning: flushSync was called from inside a lifecycle method\. React cannot flush when React is already rendering\./u,
  },
  {
    // Chromium logs the network failure before any application code can see the
    // response, so an offline test that deliberately severs the network cannot
    // suppress it at the source.
    reason: 'deliberate offline navigation in the PWA suite',
    match: /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/u,
  },
  {
    // Same shape: the service-worker suite installs a failing cache on purpose
    // to prove the first-install failure stays unobtrusive.
    reason: 'deliberate first-install cache failure in the PWA suite',
    match: /Failed to load resource: net::ERR_FAILED/u,
  },
];

function describeLocation(message: ConsoleMessage): string {
  const { url, lineNumber, columnNumber } = message.location();
  if (!url) return '(no location)';
  return `${url}:${lineNumber}:${columnNumber}`;
}

/**
 * Start collecting runtime errors from a page. The returned reader is a
 * snapshot function so a caller can assert mid-test as well as at teardown.
 */
export function collectRuntimeErrors(page: Page): () => readonly RuntimeError[] {
  const collected: RuntimeError[] = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    collected.push({
      kind: 'console.error',
      text: message.text(),
      location: describeLocation(message),
    });
  });
  page.on('pageerror', (error) => {
    collected.push({
      kind: 'pageerror',
      text: error.stack ?? error.message,
      location: '(uncaught)',
    });
  });

  return () => [...collected];
}

/**
 * An allowance matches only when every pattern it declares matches, so a
 * text-and-location pair narrows rather than widens. An allowance with neither
 * pattern would match everything, and is treated as matching nothing.
 */
export function isAllowedRuntimeError(
  error: RuntimeError,
  allowed: readonly AllowedRuntimeError[],
): boolean {
  return allowed.some((allowance) => {
    if (allowance.match === undefined && allowance.location === undefined) return false;
    if (allowance.match !== undefined && !allowance.match.test(error.text)) return false;
    if (allowance.location !== undefined && !allowance.location.test(error.location)) return false;
    return true;
  });
}

export function unexpectedRuntimeErrors(
  errors: readonly RuntimeError[],
  allowed: readonly AllowedRuntimeError[] = SHARED_ALLOWED_RUNTIME_ERRORS,
): readonly RuntimeError[] {
  return errors.filter((error) => !isAllowedRuntimeError(error, allowed));
}

/** Render the failure message a guarded test reports. */
export function formatRuntimeErrors(errors: readonly RuntimeError[]): string {
  const lines = errors.map(
    (error) => `  [${error.kind}] ${error.text.split('\n')[0]}\n      at ${error.location}`,
  );
  return (
    `The page reported ${errors.length} runtime ` +
    `${errors.length === 1 ? 'error' : 'errors'} that no assertion covered:\n${lines.join('\n')}\n\n` +
    'Fix the error, or add a narrowly scoped allowance with its reason to ' +
    'e2e/helpers/console-guard.ts.'
  );
}
