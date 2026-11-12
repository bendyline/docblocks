/**
 * The pipelines read Markdown and validate Mermaid through Squisq's editor
 * package, which expects a browser DOM, so the pack registers happy-dom
 * before loading them. happy-dom replaces `fetch` with a browser fetch that
 * sends CORS preflights a model server does not answer, and Node's fetch only
 * accepts Node's own AbortSignal: both are captured here, at import, before
 * anything registers a DOM. Import this module first.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

export const nodeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export const NodeAbortController: typeof AbortController = globalThis.AbortController;

export function registerDom(): void {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') return;
  GlobalRegistrator.register({ url: 'http://localhost/' });
  // KaTeX warns at load unless the page is in standards mode, which happy-dom never reports.
  if (document.compatMode !== 'CSS1Compat') {
    Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true });
  }
}
