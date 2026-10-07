/** The live AI status for a host, and how to explain a status that blocks AI. */

import { useEffect, useState } from 'react';
import type { AiStatus, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

export function useAiStatus(ai: DocBlocksHostAiAPI): AiStatus | null {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    let active = true;
    const unsubscribe = ai.onStatus((next) => {
      if (active) setStatus(next);
    });
    void ai.status().then(
      (initial) => {
        if (active) setStatus((current) => current ?? initial);
      },
      () => {
        if (active) {
          setStatus({
            kind: 'error',
            error: { code: 'unknown', message: 'AI status is unavailable.' },
            retryable: true,
          });
        }
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [ai]);
  return status;
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
