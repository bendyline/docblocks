/**
 * One chat request run to completion. Every multi-call AI pipeline (pictures,
 * study aids, slide wording, the headless review) awaits each call's `done`
 * before starting the next: a local model serves one request at a time
 * anyway, and the mobile host refuses a second operation until the first has
 * released its lock, which it does only after delivering `done`.
 *
 * Kept free of editor imports so headless callers (the docbench task pack)
 * can use it without loading the editor.
 */

import type {
  AiChatEvent,
  AiChatRequest,
  AiError,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

export type ChatApi = Pick<DocBlocksHostAiAPI, 'chat'>;

export type ChatOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly error: AiError };

/**
 * Run one chat to completion; aborting `signal` cancels it. `onEvent` sees the
 * call's progress and deltas, for a status line; the reply comes from `done`.
 */
export async function chatOnce(
  ai: ChatApi,
  request: AiChatRequest,
  signal?: AbortSignal,
  onEvent?: (event: AiChatEvent) => void,
): Promise<ChatOutcome> {
  if (signal?.aborted) return { kind: 'cancelled' };
  const handle = ai.chat(request, onEvent ?? (() => undefined));
  const abort = () => handle.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await handle.done;
    if (signal?.aborted) return { kind: 'cancelled' };
    if (!result.ok) {
      return result.error.code === 'cancelled'
        ? { kind: 'cancelled' }
        : { kind: 'error', error: result.error };
    }
    if (result.value.finishReason === 'cancelled') return { kind: 'cancelled' };
    return {
      kind: 'ok',
      text: result.value.text,
      truncated: result.value.finishReason === 'length',
    };
  } catch (error: unknown) {
    return {
      kind: 'error',
      error: { code: 'unknown', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
