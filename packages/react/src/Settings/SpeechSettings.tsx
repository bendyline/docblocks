/**
 * The Speech section of the app Settings dialog: dictation and narration
 * models, the narration voice and speed, and a voice preview.
 *
 * It talks only to `DocBlocksHostSpeechAPI`. Downloads start only from a
 * button press, and everything runs on this computer.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  DocBlocksHostSpeechAPI,
  SpeechCatalog,
  SpeechError,
  SpeechInstallHandle,
  SpeechModelInfo,
  SpeechPreferences,
  SpeechProgress,
  SpeechReadiness,
  SpeechStatus,
  SpeechSynthesisHandle,
} from '@bendyline/docblocks/host';
import { formatModelSize } from '../Speech/format.js';
import { ProgressivePlayer } from '../Speech/progressive-player.js';

export interface SpeechSettingsControlsProps {
  speech: DocBlocksHostSpeechAPI;
}

function readinessSentence(readiness: SpeechReadiness, ready: string): string {
  return readiness.state === 'ready' ? ready : (readiness.reason ?? '');
}

const PREVIEW_TEXT = 'This is how I sound when I read your documents aloud.';

export function SpeechSettingsControls({ speech }: SpeechSettingsControlsProps) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [preferences, setPreferences] = useState<SpeechPreferences | null>(null);
  const [installing, setInstalling] = useState<{
    id: string;
    progress: SpeechProgress | null;
  } | null>(null);
  const [failure, setFailure] = useState<SpeechError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const mounted = useRef(true);
  const installHandle = useRef<SpeechInstallHandle | null>(null);
  const preview = useRef<{ handle: SpeechSynthesisHandle; player: ProgressivePlayer } | null>(null);
  const dictationModelId = useId();
  const voiceId = useId();
  const speedId = useId();

  const refresh = useCallback(async () => {
    const [nextStatus, nextCatalog] = await Promise.all([speech.status(), speech.catalog()]);
    if (!mounted.current) return;
    setStatus(nextStatus);
    if (nextCatalog.ok) setCatalog(nextCatalog.value);
    else setFailure(nextCatalog.error);
  }, [speech]);

  const stopPreview = useCallback(() => {
    preview.current?.handle.cancel();
    preview.current?.player.dispose();
    preview.current = null;
    setPreviewing(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = speech.onStatus((next) => {
      if (!mounted.current) return;
      setStatus(next);
      void speech.catalog().then((result) => {
        if (mounted.current && result.ok) setCatalog(result.value);
      });
    });
    void refresh();
    void speech.getPreferences().then((initial) => {
      if (mounted.current) setPreferences(initial);
    });
    return () => {
      mounted.current = false;
      installHandle.current?.cancel();
      preview.current?.handle.cancel();
      preview.current?.player.dispose();
      unsubscribe();
    };
  }, [refresh, speech]);

  const install = useCallback(
    async (model: SpeechModelInfo) => {
      setFailure(null);
      setInstalling({ id: model.id, progress: null });
      const handle = speech.installModel(model.id, (progress) => {
        if (mounted.current) setInstalling({ id: model.id, progress });
      });
      installHandle.current = handle;
      try {
        const result = await handle.done;
        if (!mounted.current) return;
        if (!result.ok && result.error.code !== 'cancelled') setFailure(result.error);
        await refresh();
      } finally {
        if (installHandle.current === handle) installHandle.current = null;
        if (mounted.current) setInstalling(null);
      }
    },
    [refresh, speech],
  );

  const remove = useCallback(
    async (model: SpeechModelInfo) => {
      setFailure(null);
      const result = await speech.removeModel(model.id);
      if (!mounted.current) return;
      if (!result.ok) setFailure(result.error);
      await refresh();
    },
    [refresh, speech],
  );

  const update = useCallback(
    async (patch: Partial<SpeechPreferences>) => {
      try {
        const next = await speech.setPreferences(patch);
        if (mounted.current) setPreferences(next);
      } catch {
        // The control snaps back to the stored preference on the next render.
      }
    },
    [speech],
  );

  const startPreview = useCallback(() => {
    const synthesize = speech.synthesize;
    if (!synthesize) return;
    stopPreview();
    const player = ProgressivePlayer.create(() => undefined);
    if (!player) return;
    // Prime inside the click so audio is allowed to start later.
    player.prime();
    setPreviewing(true);
    const handle = synthesize({ text: PREVIEW_TEXT }, (event) => {
      if (event.kind === 'chunk') {
        player.append(event.chunk);
        void player.play();
      } else if (event.kind === 'done') {
        player.finish();
      }
    });
    preview.current = { handle, player };
    void handle.done.then((result) => {
      if (!mounted.current || preview.current?.handle !== handle) return;
      if (!result.ok && result.error.code !== 'cancelled') setFailure(result.error);
      // Leave the player to finish speaking; it is disposed on the next preview.
      setPreviewing(false);
    });
  }, [speech, stopPreview]);

  if (!status || !catalog || !preferences) return null;

  const sttModels = catalog.models.filter((model) => model.kind === 'stt');
  const ttsModel = catalog.models.find((model) => model.kind === 'tts') ?? null;
  const installedStt = sttModels.filter((model) => model.installed);
  const appBytes = catalog.models
    .filter((model) => model.source === 'app')
    .reduce((sum, model) => sum + model.downloadBytes, 0);

  const modelRow = (model: SpeechModelInfo) => {
    const busy = installing?.id === model.id;
    const progress = busy ? installing.progress : null;
    const percent =
      progress && progress.totalBytes
        ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
        : null;
    return (
      <li className="db-settings-speech-model" key={model.id}>
        <div className="db-settings-speech-model-text">
          <span className="db-settings-speech-model-name">
            {model.label}
            {model.recommended ? ' (recommended)' : ''}
          </span>
          <span className="db-settings-hint">
            {model.description} {formatModelSize(model.downloadBytes)} ·{' '}
            <a href={model.licenseUrl} target="_blank" rel="noreferrer">
              {model.license}
            </a>
            {model.source === 'shared' ? ' · Shared with Gezel, using no extra space' : ''}
          </span>
        </div>
        {busy ? (
          <div className="db-settings-ai-download-progress" role="status">
            <progress
              max={100}
              value={percent ?? undefined}
              aria-label={`${model.label} download progress`}
            />
            <span>
              {progress?.phase === 'verifying'
                ? 'Verifying…'
                : percent === null
                  ? 'Starting…'
                  : `${percent}%`}
            </span>
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              onClick={() => installHandle.current?.cancel()}
            >
              Cancel
            </button>
          </div>
        ) : model.source === 'app' ? (
          <button
            type="button"
            className="db-settings-action db-settings-action--secondary"
            disabled={installing !== null}
            onClick={() => void remove(model)}
          >
            Remove
          </button>
        ) : model.installed ? null : (
          <button
            type="button"
            className="db-settings-action"
            disabled={installing !== null}
            onClick={() => void install(model)}
          >
            Download
          </button>
        )}
      </li>
    );
  };

  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Speech</legend>
      <p className="db-settings-hint">
        Dictation and narration run on this computer; your voice and documents never leave it.
        Models download only when you choose.
        {appBytes > 0 ? ` Speech models are using ${formatModelSize(appBytes)}.` : ''}
      </p>
      {failure && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {failure.message}
        </p>
      )}

      {speech.transcribe && (
        <section className="db-settings-speech-section" aria-labelledby={dictationModelId}>
          <h4 className="db-settings-subheading" id={dictationModelId}>
            Dictation
          </h4>
          <p className="db-settings-hint" role="status" aria-live="polite">
            {readinessSentence(status.stt, 'Ready. Use the microphone button in the toolbar.')}
          </p>
          {installedStt.length > 1 && (
            <label className="db-settings-select">
              <span className="db-settings-select-header">Dictation model</span>
              <select
                className="db-settings-select-input"
                value={preferences.sttModel ?? ''}
                onChange={(event) => void update({ sttModel: event.currentTarget.value || null })}
              >
                <option value="">Recommended</option>
                {installedStt.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ul className="db-settings-speech-models">{sttModels.map(modelRow)}</ul>
        </section>
      )}

      {speech.synthesize && ttsModel && (
        <section className="db-settings-speech-section" aria-labelledby={voiceId}>
          <h4 className="db-settings-subheading" id={voiceId}>
            Narration
          </h4>
          <p className="db-settings-hint" role="status" aria-live="polite">
            {readinessSentence(status.tts, 'Ready to read documents aloud.')}
          </p>
          <ul className="db-settings-speech-models">{modelRow(ttsModel)}</ul>
          {ttsModel.installed && (
            <>
              <label className="db-settings-select">
                <span className="db-settings-select-header">Voice</span>
                <select
                  className="db-settings-select-input"
                  value={preferences.voice ?? catalog.voices[0]?.id ?? ''}
                  onChange={(event) => void update({ voice: event.currentTarget.value })}
                >
                  {catalog.voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label} ({voice.language === 'en-GB' ? 'UK' : 'US'}
                      {voice.gender ? ` ${voice.gender}` : ''})
                    </option>
                  ))}
                </select>
              </label>
              <label className="db-settings-select" htmlFor={speedId}>
                <span className="db-settings-select-header">
                  Speed: {preferences.speed.toFixed(2)}×
                </span>
                <input
                  id={speedId}
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={preferences.speed}
                  onChange={(event) =>
                    setPreferences({ ...preferences, speed: Number(event.currentTarget.value) })
                  }
                  onPointerUp={(event) => void update({ speed: Number(event.currentTarget.value) })}
                  onKeyUp={(event) => void update({ speed: Number(event.currentTarget.value) })}
                />
              </label>
              <button
                type="button"
                className="db-settings-action db-settings-action--secondary"
                onClick={() => (previewing ? stopPreview() : startPreview())}
              >
                {previewing ? 'Stop preview' : 'Preview voice'}
              </button>
            </>
          )}
        </section>
      )}
    </fieldset>
  );
}
