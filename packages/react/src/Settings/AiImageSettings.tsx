/**
 * Image models: which renders "Generate image" and which draws Illustrate's
 * design graphics, plus downloads. Image models are large — a design model
 * can be tens of gigabytes — so every download follows a click, shows its
 * size and license, and says plainly when a model needs a workstation or
 * cannot run on this computer at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiImageInstallHandle,
  AiImageModel,
  AiImagePreferences,
  AiImagesAPI,
  AiProgress,
} from '@bendyline/docblocks/host';
import { imageAccessSentence, useImageAccess } from '../Ai/ai-image-access.js';
import { imageModelFacts } from './image-model-facts.js';

export interface AiImageSettingsProps {
  images: AiImagesAPI;
}

export function AiImageSettings({ images }: AiImageSettingsProps) {
  const access = useImageAccess(images);
  const [models, setModels] = useState<readonly AiImageModel[] | null>(null);
  const [preferences, setPreferences] = useState<AiImagePreferences | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [installing, setInstalling] = useState<{ id: string; progress: AiProgress | null } | null>(
    null,
  );
  const [allowing, setAllowing] = useState(false);
  const installHandle = useRef<AiImageInstallHandle | null>(null);
  const mounted = useRef(true);
  const ready = access?.kind === 'ready';

  const refresh = useCallback(async () => {
    const result = await images.models();
    if (!mounted.current) return;
    if (result.ok) setModels(result.value);
    else setFailure(result.error.message);
  }, [images]);

  useEffect(() => {
    mounted.current = true;
    void images.getPreferences().then(
      (initial) => {
        if (mounted.current) setPreferences(initial);
      },
      () => undefined,
    );
    return () => {
      mounted.current = false;
      installHandle.current?.cancel();
    };
  }, [images]);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  const install = async (model: AiImageModel) => {
    setFailure(null);
    setInstalling({ id: model.id, progress: null });
    const handle = images.installModel(model.id, (progress) => {
      if (mounted.current) setInstalling({ id: model.id, progress });
    });
    installHandle.current = handle;
    try {
      const result = await handle.done;
      if (!mounted.current) return;
      if (!result.ok && result.error.code !== 'cancelled') setFailure(result.error.message);
      await refresh();
    } finally {
      if (installHandle.current === handle) installHandle.current = null;
      if (mounted.current) setInstalling(null);
    }
  };

  const remove = async (model: AiImageModel) => {
    setFailure(null);
    const result = await images.removeModel(model.id);
    if (!mounted.current) return;
    if (!result.ok) setFailure(result.error.message);
    else setPreferences(await images.getPreferences());
    await refresh();
  };

  const choose = async (patch: Partial<AiImagePreferences>) => {
    setPreferences(await images.setPreferences(patch));
  };

  const allow = async () => {
    setAllowing(true);
    setFailure(null);
    const result = await images.requestAccess();
    if (!mounted.current) return;
    setAllowing(false);
    if (!result.ok) setFailure(result.error.message);
  };

  const installed = (models ?? []).filter((model) => model.state === 'installed');
  const designModels = installed.filter((model) => model.rendersText);
  const blocked = imageAccessSentence(access);

  const modelRow = (model: AiImageModel) => {
    const busy = installing?.id === model.id;
    const percent = busy && installing.progress ? installing.progress.percent : null;
    const wontRun = model.fit?.verdict === 'wont-run';
    return (
      <li className="db-settings-speech-model" key={model.id}>
        <div className="db-settings-speech-model-text">
          <span className="db-settings-speech-model-name">{model.label}</span>
          <span className="db-settings-hint">{imageModelFacts(model).join(' · ')}</span>
        </div>
        {busy ? (
          <div className="db-settings-ai-download-progress" role="status">
            <progress
              max={100}
              value={percent ?? undefined}
              aria-label={`${model.label} download progress`}
            />
            <span>
              {installing.progress?.phase === 'verifying'
                ? 'Verifying…'
                : percent === null
                  ? 'Starting…'
                  : `${String(Math.round(percent))}%`}
            </span>
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              onClick={() => installHandle.current?.cancel()}
            >
              Cancel
            </button>
          </div>
        ) : model.state === 'installed' ? (
          model.shared ? null : (
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              disabled={installing !== null}
              onClick={() => void remove(model)}
            >
              Remove
            </button>
          )
        ) : (
          <button
            type="button"
            className="db-settings-action"
            disabled={installing !== null || wontRun}
            title={wontRun ? (model.fit?.reason ?? undefined) : undefined}
            onClick={() => void install(model)}
          >
            {model.state === 'downloading' ? 'Show download' : 'Download'}
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="db-settings-ai-knowledge" aria-label="Image generation">
      <h3 className="db-settings-select-header">Image generation</h3>
      {blocked ? (
        <p className="db-settings-hint" role="status" aria-live="polite">
          {access?.kind === 'awaiting-approval' && access.verificationCode
            ? `In Gezel, approve DocBlocks and enter the code ${access.verificationCode}.`
            : blocked}
        </p>
      ) : (
        <p className="db-settings-hint">
          Images are generated on this computer. Models download only when you choose, and some are
          large.
        </p>
      )}
      {access?.kind === 'needs-approval' && (
        <button
          type="button"
          className="db-settings-action"
          disabled={allowing}
          onClick={() => void allow()}
        >
          Allow image generation…
        </button>
      )}
      {failure && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {failure}
        </p>
      )}
      {ready && preferences && installed.length > 0 && (
        <label className="db-settings-select">
          <span className="db-settings-select-header">Model for Generate image</span>
          <select
            className="db-settings-select-input"
            value={preferences.model ?? ''}
            onChange={(event) => void choose({ model: event.currentTarget.value || null })}
          >
            <option value="">First installed</option>
            {installed.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {ready && preferences && designModels.length > 0 && (
        <label className="db-settings-select">
          <span className="db-settings-select-header">Model for design graphics</span>
          <select
            className="db-settings-select-input"
            value={preferences.designModel ?? ''}
            onChange={(event) => void choose({ designModel: event.currentTarget.value || null })}
          >
            <option value="">None</option>
            {designModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {ready && models && <ul className="db-settings-speech-models">{models.map(modelRow)}</ul>}
    </section>
  );
}
