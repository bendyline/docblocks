import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiImageModel,
  AiImageStyle,
  AiImagePreferences,
  AiImagesAPI,
} from '@bendyline/docblocks/host';
import { parseExternalHttpUrl } from '@bendyline/docblocks/host';
import { imageAccessSentence, useImageAccess } from '../Ai/ai-image-access.js';
import { openExternalUrl } from '../external-url.js';
import { formatModelSize } from '../Speech/format.js';
import { imageModelFacts, imageModelFits } from './image-model-facts.js';
import { ImageCatalogDialog } from './ImageCatalogDialog.js';
import { imageModelDownloads, useModelDownload } from './model-downloads.js';

export interface AiImageSettingsProps {
  images: AiImagesAPI;
}
type Kind = 'model' | 'style';
type Item = AiImageModel | AiImageStyle;

export function AiImageSettings({ images }: AiImageSettingsProps) {
  const access = useImageAccess(images);
  const [models, setModels] = useState<readonly AiImageModel[] | null>(null);
  const [styles, setStyles] = useState<readonly AiImageStyle[]>([]);
  const [preferences, setPreferences] = useState<AiImagePreferences | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [styleFailure, setStyleFailure] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Kind | null>(null);
  const downloads = imageModelDownloads(images);
  const download = useModelDownload(downloads);
  const installing = download.active
    ? {
        kind: download.active.item.kind,
        id: download.active.item.model.id,
        progress: download.active.progress,
      }
    : null;
  const failureMessage = failure ?? download.failure?.message ?? null;
  const [removing, setRemoving] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const mounted = useRef(true);
  const ready = access?.kind === 'ready';
  const busy = installing !== null || removing;

  const refresh = useCallback(async () => {
    await Promise.all([
      images
        .models()
        .then((result) => {
          if (!mounted.current) return;
          if (result.ok) setModels(result.value);
          else setFailure(result.error.message);
        })
        .catch((error: unknown) => {
          if (mounted.current) setFailure(String(error));
        }),
      images
        .styles?.()
        .then((result) => {
          if (!mounted.current) return;
          if (result.ok) {
            setStyles(result.value);
            setStyleFailure(null);
          } else {
            setStyles([]);
            setStyleFailure(result.error.message);
          }
        })
        .catch((error: unknown) => {
          if (mounted.current) setStyleFailure(String(error));
        }),
    ]);
  }, [images]);

  useEffect(() => {
    mounted.current = true;
    void images
      .getPreferences()
      .then((initial) => {
        if (mounted.current) setPreferences(initial);
      })
      .catch((error: unknown) => {
        if (mounted.current) setFailure(String(error));
      });
    return () => {
      mounted.current = false;
    };
  }, [images]);
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh, download.completed]);

  const install = async (kind: Kind, item: Item) => {
    setFailure(null);
    await downloads.start<Item>({ kind, model: item }, (progress) => {
      const handle =
        kind === 'model'
          ? images.installModel(item.id, progress)
          : images.installStyle?.(item.id, progress);
      if (!handle) throw new Error('Update the app to add image styles.');
      return handle;
    });
  };
  const remove = async (kind: Kind, item: Item) => {
    setFailure(null);
    setRemoving(true);
    try {
      const result =
        kind === 'model' ? await images.removeModel(item.id) : await images.removeStyle?.(item.id);
      if (!mounted.current) return;
      if (result && !result.ok) setFailure(result.error.message);
      else setPreferences(await images.getPreferences());
      await refresh();
    } catch (error) {
      if (mounted.current) setFailure(String(error));
    } finally {
      if (mounted.current) setRemoving(false);
    }
  };
  const choose = async (patch: Partial<AiImagePreferences>) => {
    try {
      const next = await images.setPreferences(patch);
      if (mounted.current) setPreferences(next);
    } catch (error) {
      if (mounted.current) setFailure(String(error));
    }
  };
  const allow = async () => {
    setAllowing(true);
    setFailure(null);
    try {
      const result = await images.requestAccess();
      if (mounted.current && !result.ok) setFailure(result.error.message);
    } catch (error) {
      if (mounted.current) setFailure(String(error));
    } finally {
      if (mounted.current) setAllowing(false);
    }
  };

  const installed = (models ?? []).filter(
    (model) => model.state === 'installed' && imageModelFits(model),
  );
  const designModels = installed.filter((model) => model.rendersText);
  const downloadable = (models ?? []).filter(imageModelFits);
  const compatibleStyles = styles.filter((style) =>
    style.baseModels.some((id) => installed.some((model) => model.id === id)),
  );
  const blocked = imageAccessSentence(access);
  const styleSupport = Boolean(images.styles && images.installStyle && images.removeStyle);

  const row = (kind: Kind, item: Item, inCatalog = false) => {
    const active = installing?.kind === kind && installing.id === item.id;
    const progress = active ? installing.progress : null;
    const facts =
      'fit' in item
        ? imageModelFacts(item)
        : [
            item.downloadBytes !== null ? formatModelSize(item.downloadBytes) : null,
            item.license,
            item.commercialUse === false ? 'Not for commercial use' : null,
          ].filter((fact): fact is string => Boolean(fact));
    const licenseUrl = parseExternalHttpUrl(item.licenseUrl);
    return (
      <li className="db-settings-speech-model" key={item.id}>
        <div className="db-settings-speech-model-text">
          <span className="db-settings-speech-model-name">{item.label}</span>
          {inCatalog && item.description && (
            <span className="db-settings-hint">{item.description}</span>
          )}
          <span className="db-settings-hint">
            {facts.map((fact, i) => (
              <Fragment key={i}>
                {i > 0 ? ' · ' : ''}
                {fact === item.license && licenseUrl ? (
                  <a
                    href={licenseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternalUrl(licenseUrl).catch((error: unknown) =>
                        setFailure(String(error)),
                      );
                    }}
                  >
                    {fact}
                  </a>
                ) : (
                  fact
                )}
              </Fragment>
            ))}
          </span>
          {'baseModels' in item && (
            <span className="db-settings-hint">
              For{' '}
              {item.baseModels
                .map((id) => models?.find((model) => model.id === id)?.label ?? id)
                .join(', ')}
            </span>
          )}
        </div>
        {active ? (
          <div className="db-settings-ai-download-progress" role="status">
            <progress
              max={100}
              value={progress?.percent ?? undefined}
              aria-label={`${item.label} download progress`}
            />
            <span>
              {progress?.message ?? 'Starting…'}
              {progress?.percent != null ? ` ${String(Math.round(progress.percent))}%` : ''}
            </span>
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              onClick={downloads.cancel}
            >
              Cancel
            </button>
          </div>
        ) : item.state === 'installed' ? (
          inCatalog ? (
            <span className="db-knowledge-catalog-added">Downloaded</span>
          ) : 'shared' in item && item.shared ? null : (
            <button
              type="button"
              className="db-settings-action db-settings-action--secondary"
              disabled={busy}
              aria-label={`Remove ${item.label}`}
              onClick={() => void remove(kind, item)}
            >
              Remove
            </button>
          )
        ) : (
          <button
            type="button"
            className="db-settings-action"
            disabled={busy}
            aria-label={`Download ${item.label}`}
            onClick={() => void install(kind, item)}
          >
            {item.state === 'downloading' ? 'Show download' : 'Download'}
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
          Images are generated on this computer. Add models and styles from the catalog when you
          need them. Downloads continue when Settings is closed.
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
      {failureMessage && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {failureMessage}
        </p>
      )}
      {ready && preferences && installed.length > 0 && (
        <label className="db-settings-select">
          <span className="db-settings-select-header">Model for Generate image</span>
          <select
            className="db-settings-select-input"
            value={installed.some((m) => m.id === preferences.model) ? preferences.model! : ''}
            onChange={(event) =>
              void choose({ model: event.currentTarget.value || null, style: null })
            }
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
            value={
              designModels.some((m) => m.id === preferences.designModel)
                ? preferences.designModel!
                : ''
            }
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
      {ready && models && (
        <>
          <button
            type="button"
            className="db-settings-action db-settings-action--secondary"
            onClick={() => setCatalog('model')}
          >
            Add model…
          </button>
          {!models.some((model) => model.state !== 'download-required') && !installing && (
            <p className="db-settings-hint">No image models downloaded yet.</p>
          )}
          <ul className="db-settings-speech-models">
            {models
              .filter(
                (model) =>
                  model.state !== 'download-required' ||
                  (installing?.kind === 'model' && installing.id === model.id),
              )
              .map((model) => row('model', model))}
          </ul>
          {styleSupport && (
            <>
              <h3 className="db-settings-select-header">Rendering styles</h3>
              <p className="db-settings-hint">
                Download a style, then choose it in Generate image. Styles work with specific image
                models.
              </p>
              {styleFailure ? (
                <p className="db-settings-hint" role="status">
                  {styleFailure}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className="db-settings-action db-settings-action--secondary"
                    onClick={() => setCatalog('style')}
                  >
                    Add style…
                  </button>
                  {installed.length === 0 && (
                    <p className="db-settings-hint">
                      Download an image model to see compatible styles.
                    </p>
                  )}
                  <ul className="db-settings-speech-models">
                    {styles
                      .filter(
                        (style) =>
                          style.state !== 'download-required' ||
                          (installing?.kind === 'style' && installing.id === style.id),
                      )
                      .map((style) => row('style', style))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
      {ready && catalog && (
        <ImageCatalogDialog<Item>
          title={catalog === 'model' ? 'Add image model' : 'Add rendering style'}
          items={catalog === 'model' ? downloadable : compatibleStyles}
          description={
            catalog === 'model'
              ? 'Models that exceed this device’s memory or configured limit are hidden. Downloads start only when you choose Download.'
              : 'Styles compatible with your downloaded image models. Each style downloads separately.'
          }
          busy={busy}
          failure={failureMessage}
          renderRow={(item) => row(catalog, item, true)}
          onRefresh={() => void refresh()}
          onClose={() => setCatalog(null)}
        />
      )}
    </section>
  );
}
