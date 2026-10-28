/**
 * Generate an image from a description and insert it into the document.
 *
 * A side panel rather than a dialog: a render takes seconds on a fast
 * graphics card and minutes for the largest models, and the person keeps
 * writing meanwhile. Results stay in the panel, newest first, until they are
 * inserted or discarded; inserting saves the PNG beside the document and
 * adds an image block at the cursor as one undoable step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import type {
  AiImageAspect,
  AiImageHandle,
  AiImageModel,
  AiImageProgress,
  AiImageResult,
  AiImagesAPI,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { AI_IMAGE_ASPECTS } from '@bendyline/docblocks/host';
import {
  imageAccessSentence,
  imageProgressFraction,
  imageProgressText,
  useImageAccess,
} from './ai-image-access.js';
import { imageAltText, imageMarkdown, saveGeneratedImage } from './insert-generated-image.js';

export interface AiImagePanelProps {
  ai: DocBlocksHostAiAPI;
  onClose: () => void;
}

const ASPECT_LABELS: Record<AiImageAspect, string> = {
  '1:1': 'Square',
  '4:3': 'Landscape',
  '3:4': 'Portrait',
  '16:9': 'Wide',
  '9:16': 'Tall',
};

/** The selection seeds the description, up to a paragraph's worth. */
const PREFILL_CHARACTERS = 600;

interface ImageResult {
  readonly key: string;
  readonly prompt: string;
  readonly aspect: AiImageAspect;
  readonly model: string | null;
  status: 'rendering' | 'done' | 'failed' | 'stopped';
  progress: AiImageProgress | null;
  image: AiImageResult | null;
  url: string | null;
  alt: string;
  error: string | null;
  inserted: boolean;
}

function imagesOf(ai: DocBlocksHostAiAPI): AiImagesAPI | undefined {
  return ai.images;
}

export function AiImagePanel({ ai, onClose }: AiImagePanelProps) {
  const images = imagesOf(ai);
  const access = useImageAccess(images);
  const { getSelection, insertBlockAfterCursor, mediaProvider, bumpMediaRevision } =
    useEditorContext();
  const [prompt, setPrompt] = useState(() => {
    const selection = getSelection();
    const text = selection && !selection.empty ? selection.text.trim() : '';
    return text.slice(0, PREFILL_CHARACTERS);
  });
  const [aspect, setAspect] = useState<AiImageAspect>('1:1');
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<readonly AiImageModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [results, setResults] = useState<ImageResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const handle = useRef<AiImageHandle | null>(null);
  const urls = useRef(new Set<string>());
  const counter = useRef(0);
  const ready = access?.kind === 'ready';

  useEffect(() => {
    if (!images) return;
    let live = true;
    void images
      .getPreferences()
      .then((preferences) => {
        if (!live) return;
        setAspect(preferences.aspect);
        setModel(preferences.model);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [images]);

  useEffect(() => {
    if (!images || !ready) return;
    let live = true;
    void images.models().then((result) => {
      if (!live) return;
      if (result.ok) {
        setModels(result.value);
        setModelsError(null);
      } else {
        setModelsError(result.error.message);
      }
    });
    return () => {
      live = false;
    };
  }, [images, ready]);

  useEffect(() => {
    const owned = urls.current;
    return () => {
      handle.current?.cancel();
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  const installed = (models ?? []).filter((entry) => entry.state === 'installed');
  const chosen = installed.find((entry) => entry.id === model) ?? installed[0] ?? null;
  const rendering = results.some((result) => result.status === 'rendering');

  const update = useCallback((key: string, change: Partial<ImageResult>) => {
    setResults((current) =>
      current.map((result) => (result.key === key ? { ...result, ...change } : result)),
    );
  }, []);

  const render = (text: string, shape: AiImageAspect) => {
    if (!images || !chosen || !text.trim() || handle.current) return;
    counter.current += 1;
    const key = `image-${String(counter.current)}`;
    setNotice(null);
    setResults((current) => [
      {
        key,
        prompt: text.trim(),
        aspect: shape,
        model: chosen.id,
        status: 'rendering',
        progress: null,
        image: null,
        url: null,
        alt: imageAltText(text),
        error: null,
        inserted: false,
      },
      ...current,
    ]);
    const started = images.generate(
      { prompt: text.trim(), aspect: shape, model: chosen.id },
      (event) => {
        if (event.kind === 'progress') update(key, { progress: event.progress });
      },
    );
    handle.current = started;
    void started.done.then((outcome) => {
      if (handle.current === started) handle.current = null;
      if (outcome.ok) {
        const url = URL.createObjectURL(new Blob([outcome.value.data], { type: 'image/png' }));
        urls.current.add(url);
        update(key, { status: 'done', image: outcome.value, url, progress: null });
      } else {
        update(key, {
          status: outcome.error.code === 'cancelled' ? 'stopped' : 'failed',
          error: outcome.error.code === 'cancelled' ? null : outcome.error.message,
          progress: null,
        });
      }
    });
  };

  const chooseAspect = (next: AiImageAspect) => {
    setAspect(next);
    void images?.setPreferences({ aspect: next }).catch(() => undefined);
  };

  const chooseModel = (next: string) => {
    setModel(next);
    void images?.setPreferences({ model: next }).catch(() => undefined);
  };

  const insert = async (result: ImageResult) => {
    if (!result.image) return;
    if (!mediaProvider) {
      setNotice('Save the document in a folder to insert images.');
      return;
    }
    try {
      const path = await saveGeneratedImage(mediaProvider, result.image, result.prompt);
      bumpMediaRevision?.();
      if (!insertBlockAfterCursor(imageMarkdown(path, result.alt || result.prompt))) {
        setNotice('Switch to Write or Source view, place the cursor, then insert again.');
        return;
      }
      update(result.key, { inserted: true });
    } catch (error) {
      setNotice(
        `DocBlocks could not save the image beside the document. ${error instanceof Error ? error.message : ''}`.trim(),
      );
    }
  };

  const discard = (result: ImageResult) => {
    if (result.url) {
      URL.revokeObjectURL(result.url);
      urls.current.delete(result.url);
    }
    setResults((current) => current.filter((entry) => entry.key !== result.key));
  };

  const allow = async () => {
    if (!images) return;
    setAllowing(true);
    const outcome = await images.requestAccess();
    setAllowing(false);
    if (!outcome.ok) setNotice(outcome.error.message);
  };

  const blocked = imageAccessSentence(access);
  const modelLabel = (id: string | null) =>
    (models ?? []).find((entry) => entry.id === id)?.label ?? 'the image model';

  return (
    <aside className="db-ai-review-panel db-ai-image-panel" aria-label="Generate image">
      <div className="db-ai-review-header">
        <div>
          <h2>Generate image</h2>
          {chosen && <span className="db-ai-review-count">{chosen.label}</span>}
        </div>
        <button
          type="button"
          className="db-ai-review-close"
          onClick={onClose}
          aria-label="Close Generate image"
        >
          ×
        </button>
      </div>

      {blocked && (
        <div className="db-ai-review-empty" role="status">
          {access?.kind === 'awaiting-approval' && access.verificationCode ? (
            <>
              In Gezel, approve DocBlocks and enter this code:
              <span className="db-ai-image-code">{access.verificationCode}</span>
            </>
          ) : (
            blocked
          )}
          {access?.kind === 'needs-approval' && (
            <div className="db-ai-illustrate-bar db-ai-image-allow">
              <button type="button" disabled={allowing} onClick={() => void allow()}>
                Allow image generation…
              </button>
            </div>
          )}
        </div>
      )}

      {ready && models !== null && installed.length === 0 && (
        <div className="db-ai-review-empty" role="status">
          No image model is installed yet. Download one under Settings, AI assistance.
        </div>
      )}
      {ready && modelsError && (
        <div className="db-ai-review-empty db-ai-error" role="alert">
          {modelsError}
        </div>
      )}

      {ready && installed.length > 0 && (
        <section className="db-ai-image-form" aria-label="Describe the image">
          <label className="db-ai-field">
            Description
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="A watercolor lighthouse on a cliff at dusk"
              maxLength={4000}
            />
          </label>
          <div className="db-ai-image-aspects" role="radiogroup" aria-label="Shape">
            {AI_IMAGE_ASPECTS.map((shape) => (
              <button
                key={shape}
                type="button"
                role="radio"
                aria-checked={aspect === shape}
                onClick={() => chooseAspect(shape)}
              >
                {ASPECT_LABELS[shape]}
              </button>
            ))}
          </div>
          {installed.length > 1 && (
            <label className="db-ai-field db-ai-field--inline">
              Model
              <select
                value={chosen?.id ?? ''}
                onChange={(event) => chooseModel(event.target.value)}
              >
                {installed.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="db-ai-illustrate-bar db-ai-image-actions">
            {rendering ? (
              <button type="button" onClick={() => handle.current?.cancel()}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="db-ai-image-generate"
                disabled={!prompt.trim()}
                onClick={() => render(prompt, aspect)}
              >
                Generate
              </button>
            )}
          </div>
        </section>
      )}

      {notice && (
        <div className="db-ai-review-empty db-ai-error" role="alert">
          {notice}
        </div>
      )}

      {results.length > 0 && (
        <ol className="db-ai-review-list db-ai-image-results">
          {results.map((result) => {
            const fraction = imageProgressFraction(result.progress);
            return (
              <li key={result.key} className="db-ai-review-finding db-ai-image-result">
                <p className="db-ai-image-prompt">{result.prompt}</p>
                {result.status === 'rendering' && (
                  <div className="db-ai-illustrate-progress" role="status">
                    <span className="db-ai-spinner" aria-hidden="true" />
                    {imageProgressText(result.progress, modelLabel(result.model))}
                    {fraction !== null && <progress max={1} value={fraction} />}
                  </div>
                )}
                {result.status === 'failed' && (
                  <p className="db-ai-error" role="alert">
                    {result.error}
                  </p>
                )}
                {result.status === 'stopped' && <p className="db-ai-note">Stopped.</p>}
                {result.status === 'done' && result.url && result.image && (
                  <>
                    <img
                      className="db-ai-image-preview"
                      src={result.url}
                      alt={result.alt}
                      width={result.image.width}
                      height={result.image.height}
                    />
                    <label className="db-ai-field db-ai-image-alt">
                      Description for readers
                      <input
                        value={result.alt}
                        onChange={(event) => update(result.key, { alt: event.target.value })}
                        maxLength={160}
                      />
                    </label>
                  </>
                )}
                <div className="db-ai-illustrate-bar db-ai-image-result-actions">
                  {result.status === 'done' && (
                    <button
                      type="button"
                      disabled={result.inserted}
                      onClick={() => void insert(result)}
                    >
                      {result.inserted ? 'Inserted' : 'Insert'}
                    </button>
                  )}
                  {result.status !== 'rendering' && (
                    <button
                      type="button"
                      disabled={rendering || !chosen}
                      onClick={() => render(result.prompt, result.aspect)}
                    >
                      {result.status === 'done' ? 'Regenerate' : 'Try again'}
                    </button>
                  )}
                  {result.status !== 'rendering' && (
                    <button type="button" onClick={() => discard(result)}>
                      Discard
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
