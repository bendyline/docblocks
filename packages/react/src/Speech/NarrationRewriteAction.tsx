import { useEffect, useRef, useState } from 'react';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { unavailableSentence, useAiStatus } from '../Ai/ai-status.js';
import { rewriteNarration } from './narration-rewrite.js';

export function NarrationRewriteAction({
  ai,
  text,
  disabled,
  onRewrite,
  onBusy,
}: {
  ai: DocBlocksHostAiAPI;
  text: string;
  disabled: boolean;
  onRewrite: (text: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const status = useAiStatus(ai);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      run.current?.abort();
      run.current = null;
    },
    [],
  );
  const ready = status?.kind === 'ready' && status.model !== null;
  const rewrite = async () => {
    if (run.current || !ready) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const result = await rewriteNarration(ai, text, controller.signal, (done, total) => {
        setProgress(`Rewriting part ${done + 1} of ${total}…`);
      });
      if (!controller.signal.aborted) onRewrite(result);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'AI rewrite failed.');
    } finally {
      if (run.current === controller) {
        run.current = null;
        setBusy(false);
        onBusy(false);
      }
    }
  };
  return (
    <div className="db-narration-rewrite">
      {busy ? (
        <button type="button" onClick={() => run.current?.abort()}>
          Stop rewriting
        </button>
      ) : (
        <button
          type="button"
          disabled={disabled || !ready || !text.trim()}
          onClick={() => void rewrite()}
        >
          Rewrite with AI
        </button>
      )}
      <p className="db-narration-note" role="status">
        {busy
          ? progress
          : ready
            ? 'AI can improve grammar and flow. Review the result before inserting.'
            : unavailableSentence(status)}
      </p>
      {error && (
        <p className="db-settings-ai-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
