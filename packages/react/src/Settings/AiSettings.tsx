/**
 * The AI section of the app Settings dialog.
 *
 * It talks only to `DocBlocksHostAiAPI` — which provider sits behind it is the
 * host's business — and shows the one thing a person needs at each step: why
 * AI is not available, the code to type while an optional standalone-provider
 * connection is pending, or which model is in use.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AiImageSettings } from './AiImageSettings.js';
import { AiKnowledgeSettings } from './AiKnowledgeSettings.js';
import { textModelDownloads, useModelDownload } from './model-downloads.js';
import type {
  AiError,
  AiModelDocbench,
  AiModelDownloadInfo,
  AiModelInfo,
  AiPreferences,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

export interface AiSettingsControlsProps {
  ai: DocBlocksHostAiAPI;
}

function statusSentence(status: AiStatus): string {
  switch (status.kind) {
    case 'unavailable':
      switch (status.reason) {
        case 'opt-out':
          return 'AI features are off.';
        case 'platform-unsupported':
          return 'AI features are not available in this build of DocBlocks.';
        case 'not-installed':
          return 'DocBlocks could not start its built-in AI service.';
        case 'not-running':
          return 'DocBlocks is restarting its built-in AI service…';
        case 'disconnected':
          return 'DocBlocks is starting its built-in AI service…';
      }
      break;
    case 'connecting':
      switch (status.step) {
        case 'detecting':
          return 'Looking to see if shared AI services (Gezel) are installed; we can use bundled services if they are not available.';
        case 'awaiting-approval':
          return 'Waiting for approval in Gezel…';
        case 'preparing-model':
        case 'preparing-workspace': {
          const progress = status.progress;
          if (!progress?.message) return 'Getting ready…';
          const percent = progress.percent === null ? '' : ` (${Math.round(progress.percent)}%)`;
          return `Getting ready: ${progress.message}${percent}`;
        }
      }
      break;
    case 'ready': {
      const version = status.provider.version ? ` ${status.provider.version}` : '';
      if (status.provider.mode === 'hosted') {
        if (!status.model) return 'Add an on-device model to start using AI.';
        // Ready with a model needs no sentence: the Model picker below says it.
        return '';
      }
      return `Connected to ${status.provider.name}${version}.`;
    }
    case 'error':
      return status.error.message;
  }
  return '';
}

function modelLabel(model: AiModelInfo): string {
  const label = model.local ? `${model.label} (on this device)` : model.label;
  return model.docbench ? `${label} · docbench ${Math.round(model.docbench.score)}` : label;
}

/** docbench families in the benchmark's order, in the words Settings uses. */
const DOCBENCH_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ['review', 'review'],
  ['writing', 'writing'],
  ['visuals', 'pictures'],
  ['presentations', 'slides'],
  ['study', 'study aids'],
  ['narration', 'narration'],
];

/**
 * "Docbench 81 for document work: review 72, writing 90, …" — what the
 * measured score covers, so a reader can weigh the part they use most.
 */
function docbenchSentence(docbench: AiModelDocbench): string {
  const families = DOCBENCH_FAMILIES.flatMap(([id, words]) => {
    const score = docbench.families[id];
    return score === undefined ? [] : [`${words} ${Math.round(score)}`];
  });
  return `Docbench ${Math.round(docbench.score)} for document work${families.length > 0 ? `: ${families.join(', ')}` : ''}`;
}

function modelReady(model: AiModelInfo): boolean {
  return model.availability === undefined || model.availability === 'available';
}

function readinessLabel(model: AiModelInfo): string {
  switch (model.availability) {
    case 'download-required':
      return 'download required';
    case 'downloading':
      return 'downloading';
    default:
      return 'not available';
  }
}

function formatDownloadSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  const gibibytes = bytes / 1024 ** 3;
  if (gibibytes >= 0.95) return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * "Qwen — 15 GB · Recommended · docbench 81",
 * "Gemma — 6.3 GB · 88% match · may run slowly".
 */
function downloadOptionLabel(model: AiModelDownloadInfo): string {
  const size = formatDownloadSize(model.downloadBytes);
  const rating = model.recommended
    ? ' · Recommended'
    : model.score === null
      ? ''
      : ` · ${model.score}% match`;
  const measured = model.docbench ? ` · docbench ${Math.round(model.docbench.score)}` : '';
  const slow = model.fit?.tier === 'tight' ? ` · ${model.fit.label}` : '';
  return `${model.label}${size ? ` — ${size}` : ''}${rating}${measured}${slow}`;
}

export function AiSettingsControls({ ai }: AiSettingsControlsProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [preferences, setPreferences] = useState<AiPreferences | null>(null);
  const [providerInstalled, setProviderInstalled] = useState(false);
  const [models, setModels] = useState<readonly AiModelInfo[]>([]);
  const [availableModels, setAvailableModels] = useState<readonly AiModelDownloadInfo[]>([]);
  const [showModelDownloads, setShowModelDownloads] = useState(false);
  const [downloadModelId, setDownloadModelId] = useState('');
  const downloads = textModelDownloads(ai);
  const download = useModelDownload(downloads);
  const downloadProgress = download.active?.progress ?? null;
  const installingModel = download.active !== null;
  const [loadingAvailableModels, setLoadingAvailableModels] = useState(false);
  /** An optional provider switch is in flight. */
  const [busy, setBusy] = useState(false);
  /** A preference write is in flight. */
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AiError | null>(null);
  const mounted = useRef(true);
  const modelSelectId = useId();

  useEffect(() => {
    mounted.current = true;
    setProviderInstalled(false);
    const unsubscribe = ai.onStatus((next) => {
      if (mounted.current) setStatus(next);
    });
    void ai.providerInstalled().then(
      (installed) => {
        if (mounted.current) setProviderInstalled(installed);
      },
      () => {
        if (mounted.current) setProviderInstalled(false);
      },
    );
    void Promise.all([ai.status(), ai.getPreferences()]).then(([initialStatus, initial]) => {
      if (!mounted.current) return;
      setStatus((current) => current ?? initialStatus);
      setPreferences(initial);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [ai]);

  const ready = status?.kind === 'ready';
  const refreshModels = useCallback(async () => {
    const result = await ai.models();
    if (mounted.current && result.ok) setModels(result.value);
    return result;
  }, [ai]);

  const refreshAvailableModels = useCallback(async () => {
    if (!ai.availableModels) return;
    setLoadingAvailableModels(true);
    try {
      const result = await ai.availableModels();
      if (!mounted.current) return;
      if (result.ok) {
        setAvailableModels(result.value);
        setDownloadModelId((current) =>
          result.value.some((model) => model.id === current)
            ? current
            : (result.value[0]?.id ?? ''),
        );
      } else {
        setFailure(result.error);
      }
    } finally {
      if (mounted.current) setLoadingAvailableModels(false);
    }
  }, [ai]);

  useEffect(() => {
    if (!ready) {
      setModels([]);
      setAvailableModels([]);
      setShowModelDownloads(false);
      return;
    }
    void refreshModels();
    void ai.getPreferences().then((next) => {
      if (mounted.current) setPreferences(next);
    });
  }, [ai, ready, refreshModels, download.completed]);

  useEffect(() => {
    if (ready && (showModelDownloads || installingModel)) void refreshAvailableModels();
  }, [ready, showModelDownloads, installingModel, refreshAvailableModels, download.completed]);

  const connect = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await ai.connect();
      // A cancelled attempt is one the person ended by switching AI off.
      if (mounted.current && !result.ok && result.error.code !== 'cancelled') {
        setFailure(result.error);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [ai]);

  const switchToBuiltIn = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      await ai.disconnect();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [ai]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const previous = preferences;
      setFailure(null);
      setSaving(true);
      // Keep the controlled checkbox in sync with the person's gesture while
      // the persisted preference crosses the host bridge.
      if (previous) setPreferences({ ...previous, enabled });
      let next: AiPreferences;
      try {
        next = await ai.setPreferences({ enabled });
      } catch {
        if (mounted.current && previous) setPreferences(previous);
        return;
      } finally {
        if (mounted.current) setSaving(false);
      }
      if (!mounted.current) return;
      setPreferences(next);
    },
    [ai, preferences],
  );

  const retryBuiltIn = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      await ai.setPreferences({ enabled: true });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [ai]);

  const setModel = useCallback(
    async (model: string | null) => {
      const next = await ai.setPreferences({ model });
      if (mounted.current) setPreferences(next);
    },
    [ai],
  );

  const addModel = useCallback(async () => {
    const selected = availableModels.find((model) => model.id === downloadModelId);
    if (!selected || !ai.installModel) return;
    setFailure(null);
    await downloads.start(
      selected,
      (progress) => ai.installModel!(selected.id, progress),
      async (model) => {
        await ai.setPreferences({ model: model.id });
      },
    );
  }, [ai, availableModels, downloadModelId, downloads]);

  if (!preferences || !status) return null;

  const enabled = preferences.enabled;
  const connecting = status.kind === 'connecting';
  const code = status.kind === 'connecting' ? status.verificationCode : null;
  const defaultModel = models.find((model) => model.isDefault) ?? null;
  const hasReadyModels = models.some(modelReady);
  const unavailableModels = models.filter((model) => !modelReady(model));
  const modelManagement = Boolean(ai.availableModels && ai.installModel);
  const downloadOptions =
    download.active && !availableModels.some((model) => model.id === download.active?.item.id)
      ? [download.active.item, ...availableModels]
      : availableModels;
  const selectedDownload =
    download.active?.item ?? downloadOptions.find((model) => model.id === downloadModelId) ?? null;
  const downloadsVisible = showModelDownloads || installingModel;
  // The status line already carries an error status's message; repeat a
  // failed attempt's message only when it adds something.
  const failureMessage =
    download.failure?.message ??
    (failure &&
    !(status.kind === 'error' && status.error.message === failure.message) &&
    !(status.kind === 'unavailable' && failure.code === 'provider-unavailable')
      ? failure.message
      : null);

  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">AI assistance</legend>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          // Not locked while connecting: approval can take minutes, and
          // switching AI off must stay possible throughout.
          disabled={saving}
          onChange={(event) => void setEnabled(event.currentTarget.checked)}
        />
        Use AI features
      </label>
      <p className="db-settings-hint">
        DocBlocks can offer AI features that run entirely on this device — no account needed. Model
        downloads start only when you choose to add one.
      </p>

      {enabled && (
        <>
          <p className="db-settings-hint" role="status" aria-live="polite">
            {statusSentence(status)}
          </p>
          {code && (
            <p className="db-settings-hint">
              Type this code in Gezel to approve DocBlocks:{' '}
              <strong className="db-settings-ai-code">{code}</strong>
            </p>
          )}
          {failureMessage && (
            <p className="db-settings-hint db-settings-ai-error" role="alert">
              {failureMessage}
            </p>
          )}

          {ready && (
            <>
              <label className="db-settings-select" htmlFor={modelSelectId}>
                <span className="db-settings-select-header">Model</span>
                <select
                  id={modelSelectId}
                  className="db-settings-select-input"
                  value={preferences.model ?? ''}
                  disabled={!hasReadyModels || installingModel}
                  onChange={(event) => void setModel(event.currentTarget.value || null)}
                >
                  {!hasReadyModels ? (
                    <option value="">
                      {models.length ? 'No models ready' : 'No models installed'}
                    </option>
                  ) : (
                    <option value="">
                      {defaultModel ? `Default: ${modelLabel(defaultModel)}` : 'Default'}
                    </option>
                  )}
                  {preferences.model && !models.some((model) => model.id === preferences.model) && (
                    <option value={preferences.model} disabled>
                      Previously selected model (not available)
                    </option>
                  )}
                  {models.map((model) => (
                    <option key={model.id} value={model.id} disabled={!modelReady(model)}>
                      {modelReady(model)
                        ? modelLabel(model)
                        : `${model.label} (${readinessLabel(model)})`}
                    </option>
                  ))}
                </select>
              </label>
              {unavailableModels.map((model) => (
                <p className="db-settings-hint" key={model.id}>
                  {model.label}:{' '}
                  {model.unavailableReason ?? 'This model is not available right now.'}
                </p>
              ))}

              {modelManagement && (
                <div className="db-settings-ai-models">
                  <button
                    type="button"
                    className="db-settings-action db-settings-action--secondary"
                    disabled={installingModel}
                    onClick={() => {
                      const next = !showModelDownloads;
                      setShowModelDownloads(next);
                    }}
                  >
                    {downloadsVisible ? 'Hide model downloads' : 'Add model…'}
                  </button>

                  {downloadsVisible && (
                    <div className="db-settings-ai-model-downloads">
                      <p className="db-settings-hint">
                        Downloads continue when Settings is closed.
                      </p>
                      {loadingAvailableModels ? (
                        <p className="db-settings-hint" role="status">
                          Looking for models…
                        </p>
                      ) : downloadOptions.length === 0 ? (
                        <p className="db-settings-hint">
                          No downloadable models are available for this device.
                        </p>
                      ) : (
                        <>
                          <label className="db-settings-select">
                            <span className="db-settings-select-header">Model to download</span>
                            <select
                              className="db-settings-select-input"
                              value={download.active?.item.id ?? downloadModelId}
                              disabled={installingModel}
                              onChange={(event) => setDownloadModelId(event.currentTarget.value)}
                            >
                              {downloadOptions.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {downloadOptionLabel(model)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {selectedDownload && (
                            <p className="db-settings-hint" title={selectedDownload.fit?.detail}>
                              {selectedDownload.recommended
                                ? 'Recommended for this device'
                                : 'Downloads and runs on this device'}
                              {formatDownloadSize(selectedDownload.downloadBytes)
                                ? ` · ${formatDownloadSize(selectedDownload.downloadBytes)}`
                                : ''}
                              {selectedDownload.fit ? ` · ${selectedDownload.fit.label}` : ''}
                            </p>
                          )}
                          {selectedDownload?.docbench && (
                            <p className="db-settings-hint">
                              {docbenchSentence(selectedDownload.docbench)}
                            </p>
                          )}
                          <button
                            type="button"
                            className="db-settings-action"
                            disabled={!downloadModelId || installingModel}
                            onClick={() => void addModel()}
                          >
                            {installingModel ? 'Downloading…' : 'Download model'}
                          </button>
                        </>
                      )}
                      {installingModel && (
                        <div className="db-settings-ai-download-progress" role="status">
                          <progress
                            max={100}
                            value={downloadProgress?.percent ?? undefined}
                            aria-label="Model download progress"
                          />
                          <button
                            type="button"
                            className="db-settings-action db-settings-action--secondary"
                            onClick={downloads.cancel}
                          >
                            Cancel download
                          </button>
                          <span>
                            {downloadProgress?.message ??
                              `Downloading ${download.active?.item.label}…`}
                            {downloadProgress?.percent == null
                              ? ''
                              : ` (${Math.round(downloadProgress.percent)}%)`}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Keyed by provider so a switch starts each section afresh. The keys
              are siblings, so each needs its own prefix: a shared key makes
              React duplicate the sections on every status update. */}
          {ready && ai.knowledge && (
            <AiKnowledgeSettings
              key={`knowledge-${status.provider.mode}`}
              knowledge={ai.knowledge}
            />
          )}

          {ready && ai.images && (
            <AiImageSettings key={`images-${status.provider.mode}`} images={ai.images} />
          )}

          {ready && status.provider.mode === 'installed' ? (
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              disabled={busy}
              onClick={() => void switchToBuiltIn()}
            >
              Use built-in AI
            </button>
          ) : ready && status.provider.mode === 'hosted' && providerInstalled ? (
            <button
              type="button"
              className="db-settings-action"
              disabled={busy}
              onClick={() => void connect()}
            >
              Connect Gezel app…
            </button>
          ) : status.kind === 'error' && status.retryable ? (
            <button
              type="button"
              className="db-settings-action"
              disabled={busy || connecting}
              onClick={() => void retryBuiltIn()}
            >
              Try built-in AI again
            </button>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
