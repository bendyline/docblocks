import type { EmbeddingsStatus } from '@bendyline/docblocks/host';
import type { SemanticProgress } from '../WorkspaceIndex/embedding-scheduler.js';

export interface SemanticSearchSettingsControlsProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  /** How far the open workspace is embedded; null before the first count. */
  progress: SemanticProgress | null;
  /** The host's model; null before its first status. */
  model?: EmbeddingsStatus | null;
  /** Downloads the model, on a host that does not bundle it. */
  onDownload?: () => void;
  /** The workspace index has not started (it waits for a first search on phones). */
  waiting?: boolean;
  /** Whether AI answers draw on the open workspace; present where AI is available. */
  aiGrounding?: {
    enabled: boolean;
    onChange: (enabled: boolean) => void;
    /** The AI provider runs remotely, so passages would leave this device. */
    remote: boolean;
  };
}

const count = (value: number) => value.toLocaleString();

/** Decimal megabytes, as phones and app stores count them. */
function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000)).toLocaleString()} MB`;
}

function coverage(progress: SemanticProgress | null, enabled: boolean, waiting: boolean): string {
  if (waiting) return 'The open workspace is prepared once you first search it.';
  if (!progress) return enabled ? 'Preparing the open workspace…' : '';
  if (progress.total === 0) return 'Nothing in the open workspace to prepare yet.';
  if (progress.embedded >= progress.total) {
    return `The open workspace is ready: ${count(progress.total)} passages.`;
  }
  const done = `${count(progress.embedded)} of ${count(progress.total)} passages ready`;
  if (!enabled) return `${done}; paused.`;
  return progress.working ? `${done}…` : `${done}.`;
}

function ModelRow({
  model,
  onDownload,
}: {
  model: EmbeddingsStatus;
  onDownload: (() => void) | undefined;
}) {
  if (model.state === 'unavailable') {
    return (
      <p className="db-settings-hint" role="status">
        {model.reason ?? 'Semantic search is not available on this device.'}
      </p>
    );
  }
  if (model.state === 'downloading') {
    const total = model.download?.totalBytes ?? 0;
    const received = Math.min(model.download?.receivedBytes ?? 0, total);
    return (
      <p className="db-settings-hint" role="status" data-testid="semantic-search-download">
        Downloading the search model: {megabytes(received)} of {megabytes(total)}…
      </p>
    );
  }
  if (model.state === 'download-required') {
    return (
      <>
        <p className="db-settings-hint">
          Searching by meaning needs a search model on this device (
          {megabytes(model.download?.totalBytes ?? 0)}), downloaded once.
        </p>
        {model.reason && (
          <p className="db-settings-hint" role="status">
            {model.reason}
          </p>
        )}
        {onDownload && (
          <button type="button" className="db-settings-action" onClick={onDownload}>
            Download search model
          </button>
        )}
      </>
    );
  }
  return null;
}

/**
 * The semantic search switch and the open workspace's coverage. Word search
 * is always complete; meaning fills in as passages are prepared.
 */
export function SemanticSearchSettingsControls({
  enabled,
  onChange,
  progress,
  model = null,
  onDownload,
  waiting = false,
  aiGrounding,
}: SemanticSearchSettingsControlsProps) {
  const ready = model === null || model.state === 'ready';
  const status = ready ? coverage(progress, enabled, waiting) : '';
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Semantic search</legend>
      <p className="db-settings-hint">
        Best matches in workspace search also find passages close in meaning, not only those sharing
        your words. The model runs on this device; nothing you write is sent anywhere.
      </p>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        Search by meaning
      </label>
      {model && <ModelRow model={model} onDownload={onDownload} />}
      {status && (
        <p className="db-settings-hint" role="status" data-testid="semantic-search-coverage">
          {status}
        </p>
      )}
      {ready && (
        <p className="db-settings-hint">
          Preparing a large workspace takes a while the first time, and pauses while DocBlocks is in
          the background. Turning this off pauses it and keeps what is prepared.
        </p>
      )}
      {aiGrounding && (
        <>
          <label className="db-settings-checkbox">
            <input
              type="checkbox"
              checked={aiGrounding.enabled}
              disabled={!enabled}
              onChange={(event) => aiGrounding.onChange(event.currentTarget.checked)}
            />
            Use this workspace in AI answers
          </label>
          <p className="db-settings-hint">
            AI actions also draw on notes in the open workspace that are close in meaning, and cite
            them.{' '}
            {aiGrounding.remote
              ? 'Your AI provider runs remotely, so those passages are sent to it.'
              : 'Your AI runs on this device, so they stay here.'}{' '}
            Set for each workspace.
          </p>
        </>
      )}
    </fieldset>
  );
}
