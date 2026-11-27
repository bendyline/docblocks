/** The live AI status for a host, and how to explain a status that blocks AI. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiStatus, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

export function useAiStatus(ai: DocBlocksHostAiAPI): AiStatus | null {
  return useLiveAiStatus(ai).status;
}

/**
 * The live AI status, plus `recheck` to ask the host again. A control that
 * stays mounted for the app's life rechecks when it is about to show the
 * status, so an answer the host has since revised never sticks.
 */
export function useLiveAiStatus(ai: DocBlocksHostAiAPI): {
  status: AiStatus | null;
  recheck: () => void;
} {
  const [status, setStatus] = useState<AiStatus | null>(null);
  /** The host this hook listens to; null once it stops listening. */
  const listening = useRef<DocBlocksHostAiAPI | null>(null);
  /** Counts pushed updates: one newer than a question outranks its answer. */
  const pushes = useRef(0);

  const ask = useCallback((host: DocBlocksHostAiAPI) => {
    const asked = pushes.current;
    const answer = (next: AiStatus) => {
      if (listening.current === host && pushes.current === asked) setStatus(next);
    };
    void host.status().then(answer, () =>
      answer({
        kind: 'error',
        error: { code: 'unknown', message: 'AI status is unavailable.' },
        retryable: true,
      }),
    );
  }, []);

  useEffect(() => {
    listening.current = ai;
    const unsubscribe = ai.onStatus((next) => {
      if (listening.current !== ai) return;
      pushes.current += 1;
      setStatus(next);
    });
    ask(ai);
    return () => {
      if (listening.current === ai) listening.current = null;
      unsubscribe();
    };
  }, [ai, ask]);

  const recheck = useCallback(() => ask(ai), [ai, ask]);
  return { status, recheck };
}

export function unavailableSentence(status: AiStatus | null): string {
  if (!status) return 'Checking AI connection…';
  if (status.kind === 'connecting') return 'AI is getting ready…';
  if (status.kind === 'error') return status.error.message;
  if (status.kind === 'ready' && !status.model) return 'Add a model in Settings to use AI.';
  if (status.kind === 'unavailable') {
    if (status.reason === 'opt-out') return 'Turn on AI features in Settings.';
    if (status.reason === 'disconnected') return 'Built-in AI is starting…';
    if (status.reason === 'not-installed') return 'Built-in AI is not available in this build.';
    if (status.reason === 'not-running') return 'Built-in AI is restarting…';
    return 'AI is not available in this build.';
  }
  return '';
}

/**
 * Whether AI features are offered: AI is on (any status but unavailable for
 * opt-out — hosts report that exactly while AI is off), or it
 * is off and this device is being invited to turn it on. False while the
 * status is unknown, so nothing appears and then disappears.
 */
export function useAiOffered(ai: DocBlocksHostAiAPI | undefined, invite: boolean): boolean {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!ai) return;
    let live = true;
    void ai.status().then(
      (next) => {
        if (live) setStatus(next);
      },
      () => undefined,
    );
    const unsubscribe = ai.onStatus((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [ai]);
  if (!ai) return false;
  const optedOut = status?.kind === 'unavailable' && status.reason === 'opt-out';
  return invite || (status !== null && !optedOut);
}
