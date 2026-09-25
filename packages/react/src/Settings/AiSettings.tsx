/**
 * The AI section of the app Settings dialog.
 *
 * It talks only to `DocBlocksHostAiAPI` — which provider sits behind it is the
 * host's business — and shows the one thing a person needs at each step: why
 * AI is not available, the code to type while approval is pending, or which
 * model is in use once connected.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  AiError,
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
          return 'Gezel is not installed on this computer. Install Gezel, then choose Connect.';
        case 'not-running':
          return 'Gezel is not running. Start Gezel, then choose Connect.';
        case 'disconnected':
          return 'Not connected to Gezel.';
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

export function AiSettingsControls({ ai }: AiSettingsControlsProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [preferences, setPreferences] = useState<AiPreferences | null>(null);
  const [models, setModels] = useState<readonly AiModelInfo[]>([]);
  /** A connect or disconnect is in flight. */
  const [busy, setBusy] = useState(false);
  /** A preference write is in flight. */
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AiError | null>(null);
  const mounted = useRef(true);
  const modelSelectId = useId();

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = ai.onStatus((next) => {
      if (mounted.current) setStatus(next);
    });
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
  useEffect(() => {
    if (!ready) {
      setModels([]);
      return;
    }
    let current = true;
    void ai.models().then((result) => {
      if (current && result.ok) setModels(result.value);
    });
    return () => {
      current = false;
    };
  }, [ai, ready]);

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

  const disconnect = useCallback(async () => {
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
      setFailure(null);
      setSaving(true);
      let next: AiPreferences;
      try {
        next = await ai.setPreferences({ enabled });
      } finally {
        if (mounted.current) setSaving(false);
      }
      if (!mounted.current) return;
      setPreferences(next);
      // Ticking the box is the gesture: connect straight away rather than
      // making the person find a second button.
      if (enabled) await connect();
    },
    [ai, connect],
  );

  const setModel = useCallback(
    async (model: string | null) => {
      const next = await ai.setPreferences({ model });
      if (mounted.current) setPreferences(next);
    },
    [ai],
  );

  if (!preferences || !status) return null;

  const enabled = preferences.enabled;
  const connecting = status.kind === 'connecting';
  const code = status.kind === 'connecting' ? status.verificationCode : null;
  const defaultModel = models.find((model) => model.isDefault) ?? null;
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
      <p className="db-settings-hint">
        DocBlocks uses Gezel for AI features: your Gezel app when it is running, or else a copy
        DocBlocks runs itself with the models already in your Gezel folder. Text is sent only when
        you use a feature; the model you choose decides whether it stays on this device.
      </p>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          // Not locked while connecting: approval can take minutes, and
          // switching AI off must stay possible throughout.
          disabled={saving}
          onChange={(event) => void setEnabled(event.currentTarget.checked)}
        />
        Use Gezel for AI features
      </label>

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

          {ready && models.length > 0 && (
            <label className="db-settings-select" htmlFor={modelSelectId}>
              <span className="db-settings-select-header">Model</span>
              <select
                id={modelSelectId}
                className="db-settings-select-input"
                value={preferences.model ?? ''}
                onChange={(event) => void setModel(event.currentTarget.value || null)}
              >
                <option value="">
                  {defaultModel
                    ? `Gezel's default: ${modelLabel(defaultModel)}`
                    : "Gezel's default"}
                </option>
                {preferences.model && !models.some((model) => model.id === preferences.model) && (
                  <option value={preferences.model}>{preferences.model} (not available)</option>
                )}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {ready ? (
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          ) : status.kind === 'error' && !status.retryable ? null : (
            <button
              type="button"
              className="db-settings-action"
              disabled={busy || connecting}
              onClick={() => void connect()}
            >
              {status.kind === 'error' ? 'Try again' : 'Connect'}
            </button>
          )}
        </>
      )}
    </fieldset>
  );
}
