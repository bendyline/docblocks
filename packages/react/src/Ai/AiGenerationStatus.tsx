import { useEffect, useState } from 'react';
import type { AiChatProgress } from '@bendyline/docblocks/host';

export interface AiGenerationState {
  progress: AiChatProgress | null;
  startedAt: number;
  lastActivityAt: number;
}

const LABELS: Record<AiChatProgress['phase'], string> = {
  starting: 'Waiting for model…',
  queued: 'Waiting for an available model…',
  loading_model: 'Loading model…',
  prefill: 'Processing input (prefill)…',
  reasoning: 'Thinking…',
  generating: 'Writing…',
};

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function AiGenerationStatus({
  state,
  characters,
}: {
  state: AiGenerationState;
  characters: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const progress = state.progress;
  const label = progress ? LABELS[progress.phase] : 'Waiting for response…';
  // This measures prompt processing, never completion of the entire response.
  const percent = progress?.phase === 'prefill' ? progress.percent : null;
  const details = [`${duration(now - state.startedAt)} elapsed`];
  if (progress?.outputTokens != null) {
    details.push(`${progress.outputTokens.toLocaleString()} tokens generated`);
  } else if (characters > 0) {
    details.push(`${characters.toLocaleString()} characters received`);
  }
  if (progress?.tokensPerSecond != null) {
    details.push(`${progress.tokensPerSecond.toFixed(1)} tokens/s`);
  }
  if (now - state.lastActivityAt >= 15_000) {
    details.push(
      progress || characters > 0
        ? `Last update ${duration(now - state.lastActivityAt)} ago`
        : 'No progress updates received',
    );
  }

  return (
    <div className="db-ai-generation-status">
      <p className="db-ai-progress" role="status">
        <span className="db-ai-spinner" aria-hidden="true" />
        {label}
        {percent != null ? ` ${Math.floor(percent)}%` : ''}
      </p>
      {percent != null && (
        <progress aria-label={label.replace('…', '')} max={100} value={percent} />
      )}
      {/* Counters and the clock remain readable without announcing every tick. */}
      <p className="db-ai-note" aria-live="off">
        {details.join(' · ')}
      </p>
    </div>
  );
}
