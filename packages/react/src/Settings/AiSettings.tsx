/**
 * The AI section of the app Settings dialog.
 *
 * It talks only to `DocBlocksHostAiAPI` — which provider sits behind it is the
 * host's business — and shows the one thing a person needs at each step: why
 * AI is not available, the code to type while an optional standalone-provider
 * connection is pending, or which model is in use.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AiKnowledgeSettings } from './AiKnowledgeSettings.js';
import type {
  AiError,
  AiModelDownloadInfo,
  AiModelInfo,
  AiModelInstallHandle,
  AiPreferences,
  AiProgress,
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
          return 'Looking for Gezel…';
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
        if (!status.model) {
          return `Running ${status.provider.name}${version} inside DocBlocks. Add an on-device model to start using AI.`;
        }
        return `Running ${status.provider.name}${version} inside DocBlocks, with the models already on this device.`;
      }
      return `Connected to ${status.provider.name}${version}.`;
    }
    case 'error':
      return status.error.message;
  }
  return '';
}

function modelLabel(model: AiModelInfo): string {
  return model.local ? `${model.label} (on this device)` : model.label;
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

export function AiSettingsControls({ ai }: AiSettingsControlsProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [preferences, setPreferences] = useState<AiPreferences | null>(null);
  const [providerInstalled, setProviderInstalled] = useState(false);
  const [models, setModels] = useState<readonly AiModelInfo[]>([]);
  const [availableModels, setAvailableModels] = useState<readonly AiModelDownloadInfo[]>([]);
  const [showModelDownloads, setShowModelDownloads] = useState(false);
  const [downloadModelId, setDownloadModelId] = useState('');
  const [downloadProgress, setDownloadProgress] = useState<AiProgress | null>(null);
  const [loadingAvailableModels, setLoadingAvailableModels] = useState(false);
  const [installingModel, setInstallingModel] = useState(false);
  /** An optional provider switch is in flight. */
  const [busy, setBusy] = useState(false);
  /** A preference write is in flight. */
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AiError | null>(null);
  const mounted = useRef(true);
  const installHandle = useRef<AiModelInstallHandle | null>(null);
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
      installHandle.current?.cancel();
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
  }, [ready, refreshModels]);

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
    if (!downloadModelId || !ai.installModel) return;
    setFailure(null);
    setDownloadProgress({ phase: 'starting', message: 'Starting download…', percent: null });
    setInstallingModel(true);
    const handle = ai.installModel(downloadModelId, (progress) => {
      if (mounted.current) setDownloadProgress(progress);
    });
    installHandle.current = handle;
    try {
      const result = await handle.done;
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.error.code !== 'cancelled') setFailure(result.error);
        return;
      }
      const nextPreferences = await ai.setPreferences({ model: result.value.id });
      if (!mounted.current) return;
      setPreferences(nextPreferences);
      await Promise.all([refreshModels(), refreshAvailableModels()]);
    } finally {
      if (installHandle.current === handle) installHandle.current = null;
      if (mounted.current) {
        setInstallingModel(false);
        setDownloadProgress(null);
      }
    }
  }, [ai, downloadModelId, refreshAvailableModels, refreshModels]);

  if (!preferences || !status) return null;

  const enabled = preferences.enabled;
  const connecting = status.kind === 'connecting';
  const code = status.kind === 'connecting' ? status.verificationCode : null;
  const defaultModel = models.find((model) => model.isDefault) ?? null;
  const hasReadyModels = models.some(modelReady);
  const unavailableModels = models.filter((model) => !modelReady(model));
  const modelManagement = Boolean(ai.availableModels && ai.installModel);
  const selectedDownload = availableModels.find((model) => model.id === downloadModelId) ?? null;
  // The status line already carries an error status's message; repeat a
  // failed attempt's message only when it adds something.
  const failureMessage =
    failure &&
    !(status.kind === 'error' && status.error.message === failure.message) &&
    !(status.kind === 'unavailable' && failure.code === 'provider-unavailable')
      ? failure.message
      : null;

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
        DocBlocks runs AI inside this app when AI is on. Model downloads start only when you choose
        to add one.
        {providerInstalled
          ? ' Connecting your Gezel app is optional and lets DocBlocks use that app instead.'
          : ''}
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
                      {defaultModel
                        ? `Gezel's default: ${modelLabel(defaultModel)}`
                        : "Gezel's default"}
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
                      if (next) void refreshAvailableModels();
                    }}
                  >
                    {showModelDownloads ? 'Hide model downloads' : 'Add model…'}
                  </button>

                  {showModelDownloads && (
                    <div className="db-settings-ai-model-downloads">
                      {loadingAvailableModels ? (
                        <p className="db-settings-hint" role="status">
                          Looking for models…
                        </p>
                      ) : availableModels.length === 0 ? (
                        <p className="db-settings-hint">
                          No downloadable models are available for this device.
                        </p>
                      ) : (
                        <>
                          <label className="db-settings-select">
                            <span className="db-settings-select-header">Model to download</span>
                            <select
                              className="db-settings-select-input"
                              value={downloadModelId}
                              disabled={installingModel}
                              onChange={(event) => setDownloadModelId(event.currentTarget.value)}
                            >
                              {availableModels.map((model) => {
                                const size = formatDownloadSize(model.downloadBytes);
                                return (
                                  <option key={model.id} value={model.id}>
                                    {model.label}
                                    {size ? ` — ${size}` : ''}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                          {selectedDownload && (
                            <p className="db-settings-hint">
                              Downloads and runs on this device
                              {formatDownloadSize(selectedDownload.downloadBytes)
                                ? ` · ${formatDownloadSize(selectedDownload.downloadBytes)}`
                                : ''}
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
                      {installingModel && downloadProgress && (
                        <div className="db-settings-ai-download-progress" role="status">
                          <progress
                            max={100}
                            value={downloadProgress.percent ?? undefined}
                            aria-label="Model download progress"
                          />
                          <button
                            type="button"
                            className="db-settings-action db-settings-action--secondary"
                            onClick={() => installHandle.current?.cancel()}
                          >
                            Cancel download
                          </button>
                          <span>
                            {downloadProgress.message}
                            {downloadProgress.percent === null
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

          {ready && ai.knowledge && (
            <AiKnowledgeSettings key={status.provider.mode} knowledge={ai.knowledge} />
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
