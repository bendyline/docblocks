import type { WebviewToExtensionMessage } from '../../src/messages.js';

export type WebviewPostMessage = (message: WebviewToExtensionMessage) => void;

export interface DebouncedEditPoster {
  schedule(content: string): void;
  flush(): void;
  dispose(): void;
}

export function createDebouncedEditPoster(
  postMessage: WebviewPostMessage,
  delayMs: number,
): DebouncedEditPoster {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingContent: string | null = null;

  function clearTimer(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function flush(): void {
    clearTimer();
    if (pendingContent === null) return;
    const content = pendingContent;
    pendingContent = null;
    postMessage({ type: 'edit', content });
  }

  return {
    schedule(content) {
      pendingContent = content;
      clearTimer();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    dispose: flush,
  };
}
