/**
 * The Dictation and Narration sections of the app Settings dialog: their
 * models, the narration voice and speed, and a voice preview.
 *
 * The two sections are separate tabs over one `useSpeechSettings` session, so
 * they read the same catalog and preferences, and a download started in one
 * disables the other's buttons. It talks only to `DocBlocksHostSpeechAPI`.
 * Downloads start only from a button press, and everything runs on this
 * computer.
 */

import { useId } from 'react';
import type {
  SpeechError,
  SpeechModelInfo,
  SpeechModelKind,
  SpeechReadiness,
} from '@bendyline/docblocks/host';
import { formatModelSize } from '../Speech/format.js';
import type { SpeechFailure, SpeechSettingsSession } from './useSpeechSettings.js';

function readinessSentence(readiness: SpeechReadiness, ready: string): string {
  return readiness.state === 'ready' ? ready : (readiness.reason ?? '');
}

export interface SpeechSectionProps {
  session: SpeechSettingsSession;
}

export function DictationSettingsControls({ session }: SpeechSectionProps) {
  const { status, catalog, preferences, update } = session;
  const error = sectionError(session.failure, 'stt');
  if (!status || !catalog || !preferences) {
    return <SpeechSectionFallback legend="Dictation" error={error} />;
  }

  const sttModels = catalog.models.filter((model) => model.kind === 'stt');
  const installedStt = sttModels.filter((model) => model.installed);
  const appBytes = appModelBytes(sttModels);

  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Dictation</legend>
      <p className="db-settings-hint">
        Dictation runs on this computer; your voice never leaves it. Models download only when you
        choose.
        {appBytes > 0 ? ` Dictation models are using ${formatModelSize(appBytes)}.` : ''}
      </p>
      <SpeechErrorNotice error={error} />
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
      <ul className="db-settings-speech-models">
        {sttModels.map((model) => (
          <SpeechModelRow key={model.id} model={model} session={session} />
        ))}
      </ul>
    </fieldset>
  );
}

export function NarrationSettingsControls({ session }: SpeechSectionProps) {
  const speedId = useId();
  const { status, catalog, preferences, previewing, update } = session;
  const error = sectionError(session.failure, 'tts');
  if (!status || !catalog || !preferences) {
    return <SpeechSectionFallback legend="Narration" error={error} />;
  }

  const ttsModel = catalog.models.find((model) => model.kind === 'tts') ?? null;
  const appBytes = ttsModel ? appModelBytes([ttsModel]) : 0;

  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Narration</legend>
      <p className="db-settings-hint">
        Narration runs on this computer; your documents never leave it. Voices download only when
        you choose.
        {appBytes > 0 ? ` Narration voices are using ${formatModelSize(appBytes)}.` : ''}
      </p>
      <SpeechErrorNotice error={error} />
      {ttsModel ? (
        <>
          <p className="db-settings-hint" role="status" aria-live="polite">
            {readinessSentence(status.tts, 'Ready to read documents aloud.')}
          </p>
          <ul className="db-settings-speech-models">
            <SpeechModelRow model={ttsModel} session={session} />
          </ul>
        </>
      ) : (
        <p className="db-settings-hint">Narration is not available on this computer.</p>
      )}
      {ttsModel?.installed && (
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
              onChange={(event) => session.setSpeedDraft(Number(event.currentTarget.value))}
              onPointerUp={(event) => void update({ speed: Number(event.currentTarget.value) })}
              onKeyUp={(event) => void update({ speed: Number(event.currentTarget.value) })}
            />
          </label>
          <button
            type="button"
            className="db-settings-action db-settings-action--secondary"
            onClick={() => (previewing ? session.stopPreview() : session.startPreview())}
          >
            {previewing ? 'Stop preview' : 'Preview voice'}
          </button>
        </>
      )}
    </fieldset>
  );
}

function SpeechModelRow({
  model,
  session,
}: {
  model: SpeechModelInfo;
  session: SpeechSettingsSession;
}) {
  const { installing } = session;
  const busy = installing?.id === model.id;
  const progress = busy ? installing.progress : null;
  const percent =
    progress && progress.totalBytes
      ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
      : null;
  return (
    <li className="db-settings-speech-model">
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
          {model.source === 'shared'
            ? ' · Available from Gezel, no download needed'
            : model.sharedStorage
              ? ' · Shared speech storage'
              : ''}
          {model.updateRequired ? ' · Update required' : ''}
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
            onClick={session.cancelInstall}
          >
            Cancel
          </button>
        </div>
      ) : model.source === 'app' ? (
        <button
          type="button"
          className="db-settings-action db-settings-action--secondary"
          disabled={installing !== null}
          onClick={() => void session.remove(model)}
        >
          Remove
        </button>
      ) : model.installed ? null : (
        <>
          <button
            type="button"
            className="db-settings-action"
            disabled={installing !== null}
            onClick={() => void session.install(model)}
          >
            {model.updateRequired ? 'Update' : 'Download'}
          </button>
          {model.updateRequired && (
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              disabled={installing !== null}
              onClick={() => void session.remove(model)}
            >
              Remove
            </button>
          )}
        </>
      )}
    </li>
  );
}

/** The failure one section shows: its own, or one that affects both. */
function sectionError(failure: SpeechFailure | null, kind: SpeechModelKind): SpeechError | null {
  return failure && (failure.kind === undefined || failure.kind === kind) ? failure.error : null;
}

/** What this app's own downloads occupy; models shared from Gezel cost nothing extra. */
function appModelBytes(models: readonly SpeechModelInfo[]): number {
  return models
    .filter((model) => model.source === 'app')
    .reduce((sum, model) => sum + model.downloadBytes, 0);
}

/**
 * Still loading draws nothing, but a section that cannot load says so rather
 * than vanishing from Settings.
 */
function SpeechSectionFallback({ legend, error }: { legend: string; error: SpeechError | null }) {
  if (!error) return null;
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">{legend}</legend>
      <SpeechErrorNotice error={error} />
    </fieldset>
  );
}

function SpeechErrorNotice({ error }: { error: SpeechError | null }) {
  if (!error) return null;
  return (
    <p className="db-settings-hint db-settings-ai-error" role="alert">
      {error.message}
    </p>
  );
}
