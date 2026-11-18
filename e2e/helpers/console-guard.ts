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
    // Upstream defect in harper.js (2.7 through 2.13): WorkerLinter's
    // Serializer constructor calls `binary.setup()` on the page and drops the
    // promise, so the page instantiates both harper binaries itself (lints are
    // rebuilt there) with nothing to catch a failure. Under parallel load,
    // WebKit intermittently traps in the full binary's start function, harper's
    // Rust `setup`, as unreachable code or as an out-of-bounds access. The
    // worker that lints is a separate instance, so proofing can still report,
    // until the page uses its own broken instance to rebuild a lint (the
    // allowance after the worker's). Squisq never sees that promise, so
    // the fix belongs in harper.js. Anchored on a frame in harper's prebundle
    // (WebKit only runs against the dev server) because the text alone would
    // also cover an IronCalc start failure. WebKit names either the glue's
    // `__wbg_finalize_init` or, across the await, the BinaryModule `setup`
    // that dropped the promise.
    reason: 'upstream: harper.js drops the promise for its page-side WASM setup',
    match:
      /^Unhandled Promise Rejection: RuntimeError: (?:Unreachable code should not be executed|Out of bounds memory access) \(evaluating 'wasm(?:\$1)?\.__wbindgen_start\(\)'\)\n[\s\S]*?\bat (?:__wbg_finalize_init(?:\$1)?|setup) \([^)\s]*\/node_modules\/\.vite\/deps\/harper__js\.js\?/u,
  },
  {
    // The same WebKit trap inside harper.js's lint worker (2.7 through 2.13):
    // under parallel load the worker's WASM traps in `linter_lint`, or as an
    // out-of-bounds access in `linter_new` while it builds the linter, and the
    // worker runs each request in an async `processRequest` with no catch, so
    // the rejection is unhandled in the inlined blob: worker and no reply is
    // posted. WorkerLinter answers requests strictly in order, so proofing
    // then stops for that page until it reloads. Nothing in DocBlocks or
    // Squisq can catch a rejection inside harper's worker; the fix belongs in
    // harper.js, and recovering (a timeout that rebuilds the engine) in
    // Squisq's harper provider. Anchored on harper's wasm-bindgen export and
    // the blob: worker URL that reports it.
    reason: 'upstream: harper.js lint worker leaves a WebKit WASM trap unhandled',
    match:
      /^Unhandled Promise Rejection: RuntimeError: (?:access to a null reference \(evaluating 'wasm\.linter_lint\(|Out of bounds memory access \(evaluating 'wasm\.linter_new\()/u,
    location: /^blob:http:\/\/localhost:\d+\/[0-9a-f-]{36}:\d+:\d+$/u,
  },
  {
    // The same WebKit trap on the page while rebuilding a lint the worker
    // sent back (harper.js 2.7 through 2.13): WorkerLinter's Serializer runs
    // `Lint.from_json` on the page's own instance, in an onmessage `.then` with
    // no catch, so the reply is never answered. The status then reads
    // "✓ Proofing" while no finding ever arrives, and proofing stops for that
    // page. Seen after the page's own start trapped. Upstream in harper.js,
    // like the two above. Anchored on the export and a frame in harper's
    // prebundle; WebKit drops the ?v= query from this frame.
    reason: 'upstream: harper.js drops a WebKit WASM trap while rebuilding a lint on the page',
    match:
      /^Unhandled Promise Rejection: RuntimeError: Out of bounds memory access \(evaluating 'wasm\.lint_from_json\([^)]*\)'\)\n[\s\S]*?\bat \S+ \([^)\s]*\/node_modules\/\.vite\/deps\/harper__js\.js[?:]/u,
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
  {
    // /desktop/ looks up the latest release from the GitHub API without a
    // token. CI runners share IPs, so GitHub intermittently answers with its
    // rate limit, and Chromium logs that before the page falls back to its
    // generic download links. Stubbing the request instead needs routing,
    // which disables the HTTP cache for the whole context and slowed Monaco's
    // dev-server reload past its assertion timeout.
    reason: 'GitHub API rate limit on the download page release lookup',
    match: /^Failed to load resource: the server responded with a status of (?:403|429)\b/u,
    location: /^https:\/\/api\.github\.com\/repos\/bendyline\/docblocks\/releases\?/u,
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
      // WebKit reports an error that has no stack trace with an empty `stack`.
      text: error.stack || `${error.name}: ${error.message}`,
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

/**
 * Name a network change the page lived through, if it saw one.
 *
 * When the operating system reports an IP change (a VPN, a dock, Wi-Fi
 * roaming, a USB-tethered phone dropping off the bus), Chromium aborts every
 * in-flight request with `net::ERR_NETWORK_CHANGED`, the dev server on
 * localhost included, and it has no switch to ignore the change. A page that
 * loses its module requests that way never mounts, and the test then fails on
 * an assertion that reads like a regression. This is never something to allow
 * (the test really did not run), only something to say plainly.
 */
export function describeNetworkChange(errors: readonly RuntimeError[]): string | undefined {
  const aborted = errors.filter((error) => error.text.includes('net::ERR_NETWORK_CHANGED')).length;
  if (aborted === 0) return undefined;
  return (
    `The operating system reported a network change during this test, and Chromium ` +
    `aborted ${aborted} in-flight ${aborted === 1 ? 'request' : 'requests'} ` +
    '(net::ERR_NETWORK_CHANGED), localhost included. Something on this machine changed ' +
    'its network: a VPN, a dock, Wi-Fi, or a USB-tethered phone. That is not a DocBlocks ' +
    'defect. Steady the network and run the test again.'
  );
}

/** Render the failure message a guarded test reports. */
export function formatRuntimeErrors(errors: readonly RuntimeError[]): string {
  const lines = errors.map(
    (error) => `  [${error.kind}] ${error.text.split('\n')[0]}\n      at ${error.location}`,
  );
  const networkChange = describeNetworkChange(errors);
  return (
    `The page reported ${errors.length} runtime ` +
    `${errors.length === 1 ? 'error' : 'errors'} that no assertion covered:\n${lines.join('\n')}\n\n` +
    (networkChange ? `${networkChange}\n\n` : '') +
    'Fix the error, or add a narrowly scoped allowance with its reason to ' +
    'e2e/helpers/console-guard.ts.'
  );
}
