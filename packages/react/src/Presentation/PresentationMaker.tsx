/** Design a live summarization. Persist intent and explicit wording, never generated slides. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorContext, usePreviewSettingsOptional } from '@bendyline/squisq-editor-react';
import { BlockRenderer, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc, resolveAudioMapping, expandDocBlocks } from '@bendyline/squisq/doc';
import { parseMarkdown, setFrontmatterValues } from '@bendyline/squisq/markdown';
import { VIEWPORT_PRESETS, type Doc } from '@bendyline/squisq/schemas';
import {
  compilePresentationPlan,
  createPresentationPlan,
  defaultPresentationHints,
  parsePresentationHints,
  serializePresentationHints,
  presentationSections,
  PRESENTATION_HINTS_KEY,
  DYNAMIC_PRESENTATION_STYLE,
  PRESENTATION_KEY,
  PRESENTATION_LAYOUTS,
  type PresentationHints,
  type PresentationBlockHint,
  type PresentationBeat,
} from '@bendyline/squisq/transform';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { useAiStatus, unavailableSentence } from '../Ai/ai-status.js';
import { refinePresentationPlan } from './presentation-ai.js';

const LABELS = {
  title: 'Title',
  statement: 'Key idea',
  list: 'List',
  comparison: 'Comparison',
  steps: 'Steps diagram',
  image: 'Image',
};
export function PresentationMaker({
  ai,
  onClose,
}: {
  ai?: DocBlocksHostAiAPI;
  onClose: () => void;
}) {
  return createPortal(<PresentationDialog ai={ai} onClose={onClose} />, document.body);
}
function AiRefineButton({
  ai,
  disabled,
  onRefine,
}: {
  ai: DocBlocksHostAiAPI;
  disabled: boolean;
  onRefine: () => void;
}) {
  const status = useAiStatus(ai);
  const ready = status?.kind === 'ready' && status.model !== null;
  return (
    <button
      type="button"
      disabled={disabled || !ready}
      title={
        ready
          ? 'Suggest layouts and shorter slide wording from the current text.'
          : unavailableSentence(status)
      }
      onClick={onRefine}
    >
      Suggest with AI
    </button>
  );
}
function PresentationDialog({ ai, onClose }: { ai?: DocBlocksHostAiAPI; onClose: () => void }) {
  const { workspaceContainer, markdownSource, replaceAll, mediaProvider } = useEditorContext();
  const preview = usePreviewSettingsOptional();
  const originalTextId = useId();
  const [hints, setHints] = useState<PresentationHints>(
    () =>
      parsePresentationHints(parseMarkdown(markdownSource).frontmatter?.[PRESENTATION_HINTS_KEY]) ??
      defaultPresentationHints(),
  );
  const [loaded, setLoaded] = useState<{ doc: Doc; source: string } | null>(null);
  const [selectedSourceStart, setSelectedSourceStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let disposed = false;
    const parsed = markdownToDoc(parseMarkdown(markdownSource));
    const load = workspaceContainer
      ? resolveAudioMapping(parsed, workspaceContainer)
      : Promise.resolve(parsed);
    void load
      .then((doc) => {
        if (!disposed) setLoaded({ doc, source: markdownSource });
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      controller.current?.abort();
    };
  }, [markdownSource, workspaceContainer]);
  const doc = loaded?.source === markdownSource ? loaded.doc : null;
  const generated = useMemo(() => {
    if (!doc) return null;
    try {
      return { plan: createPresentationPlan(doc, hints), error: null };
    } catch (cause: unknown) {
      return { plan: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [doc, hints]);
  const plan = generated?.plan;
  const sections = useMemo(() => (doc ? presentationSections(doc) : []), [doc]);
  const projection = useMemo(() => {
    if (!doc || !plan) return null;
    try {
      const projected = compilePresentationPlan(doc, plan);
      return {
        doc: projected,
        blocks: expandDocBlocks(projected.blocks, {
          theme: preview?.activeTheme,
          viewport: VIEWPORT_PRESETS.landscape,
          audioSegments: projected.audio.segments,
        }),
        error: null,
      };
    } catch (cause: unknown) {
      return {
        doc: null,
        blocks: [],
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [doc, plan, preview?.activeTheme]);
  // Layout changes can split or merge slides. Follow the source passage rather
  // than a slide number, which could now belong to a different section.
  const selectedIndex = Math.max(
    0,
    plan?.beats.findIndex(
      (item) => selectedSourceStart >= item.sourceStart && selectedSourceStart < item.sourceEnd,
    ) ?? -1,
  );
  const beat = plan?.beats[selectedIndex];
  const section = sections.find(
    (item) => beat && beat.sourceStart >= item.sourceStart && beat.sourceStart < item.sourceEnd,
  );
  const hint = hints.blocks.find((item) => item.blockId === section?.blockId);
  const visual = projection?.blocks.find((block) => block.id === beat?.id);
  const updateHint = (patch: Partial<PresentationBlockHint>) => {
    if (!section) return;
    const entry = { ...hint, blockId: section.blockId, ...patch };
    if (entry.wording && entry.wording.headline === undefined && entry.wording.points === undefined)
      delete entry.wording;
    const next = {
      ...hints,
      blocks: [...hints.blocks.filter((item) => item.blockId !== section.blockId), entry],
    };
    if (!parsePresentationHints(next)) {
      setError(
        'Use a headline of at most 110 characters and up to four highlights of at most 180 characters each.',
      );
      return;
    }
    setError(null);
    setHints(next);
  };
  const refine = async () => {
    if (!ai || !plan || progress) return;
    const run = new AbortController();
    controller.current = run;
    setError(null);
    setNotice('');
    try {
      const result = await refinePresentationPlan(ai, plan, {
        signal: run.signal,
        onProgress: (done, total) =>
          setProgress(`Suggesting slide ${Math.min(done + 1, total)} of ${total}…`),
      });
      if (!run.signal.aborted) {
        setHints((current) => {
          const blocks = current.blocks.map((item) => ({
            ...item,
            ai: item.ai ? [...item.ai] : undefined,
          }));
          for (const index of result.refined) {
            const item = result.plan.beats[index]!;
            const parent = sections.find(
              (s) => item.sourceStart >= s.sourceStart && item.sourceStart < s.sourceEnd,
            );
            if (!parent) continue;
            let target = blocks.find((b) => b.blockId === parent.blockId);
            if (!target) {
              target = { blockId: parent.blockId, ai: undefined };
              blocks.push(target);
            }
            const source = plan.sourceText.slice(item.sourceStart, item.sourceEnd);
            target.ai = [
              ...(target.ai ?? []).filter((v) => v.source !== source),
              {
                source,
                layout: item.layout,
                headline: item.headline,
                points: item.points,
              },
            ].slice(-80);
          }
          return { ...current, blocks };
        });
        setNotice(
          result.retained
            ? `Kept automatic summaries for ${result.retained} slides because the AI suggestions could not be validated.`
            : 'AI summaries are ready to review. They will be saved with their source passages.',
        );
      }
    } catch (cause: unknown) {
      if (!run.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (controller.current === run) {
        controller.current = null;
        setProgress(null);
      }
    }
  };
  const apply = () => {
    if (!doc || !plan || progress) return;
    try {
      const next = setFrontmatterValues(markdownSource, {
        [PRESENTATION_HINTS_KEY]: serializePresentationHints(hints),
        [PRESENTATION_KEY]: null,
        'squisq-cover-slide': false,
        'squisq-transform': DYNAMIC_PRESENTATION_STYLE,
        'transform-style': null,
      });
      replaceAll(next);
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Dialog
      title="Summarization designer"
      size="full"
      className="db-presentation db-ai-draft-dialog"
      onClose={onClose}
      closeOnBackdrop={false}
      footer={
        <>
          {progress ? (
            <button type="button" onClick={() => controller.current?.abort()}>
              Cancel suggestions
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setHints(defaultPresentationHints());
                setSelectedSourceStart(0);
                setError(null);
                setNotice('');
              }}
            >
              Reset design
            </button>
          )}
          {ai && (
            <AiRefineButton ai={ai} disabled={!plan || !!progress} onRefine={() => void refine()} />
          )}
          <button type="button" disabled={!plan || !!progress || !!error} onClick={apply}>
            Use dynamic slides
          </button>
        </>
      }
    >
      <p className="db-presentation-intro">
        Design how your text is summarized for presentation in slides and video. Note that your
        document text and narration will remain unchanged.
      </p>
      <div className="db-presentation-fields db-presentation-preferences">
        <label>
          Summary density
          <select
            value={hints.density}
            disabled={!!progress}
            onChange={(event) =>
              setHints({ ...hints, density: event.target.value as PresentationHints['density'] })
            }
          >
            <option value="concise">Concise — shorter passages per slide</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed — longer passages per slide</option>
          </select>
        </label>
        <label className="db-presentation-toggle">
          <input
            type="checkbox"
            checked={hints.inbetweens}
            disabled={!!progress}
            onChange={(event) => setHints({ ...hints, inbetweens: event.target.checked })}
          />{' '}
          Add supporting visual slides where useful
        </label>
      </div>
      <p role="status" aria-live="polite">
        {progress ??
          (plan && projection?.doc
            ? `${plan.beats.length} slides · ${projection.doc.duration.toFixed(1)} seconds · ${doc?.presentationNarration ? 'Follows narration' : 'Estimated pacing — add narration to synchronize'}`
            : 'Preparing dynamic slides…')}
      </p>
      {(error || generated?.error || projection?.error) && (
        <p role="alert">{error ?? generated?.error ?? projection?.error}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {plan && beat && section && (
        <div className="db-presentation-workspace">
          <nav className="db-presentation-beats" aria-label="Presentation slides">
            {plan.beats.map((item, index) => (
              <button
                type="button"
                key={item.id}
                aria-current={index === selectedIndex ? 'step' : undefined}
                title={item.headline}
                onClick={() => setSelectedSourceStart(item.sourceStart)}
              >
                <span className="db-presentation-beat-title">
                  {index + 1}. {item.headline}
                </span>
                <small>{LABELS[item.layout]}</small>
              </button>
            ))}
          </nav>
          <div className="db-presentation-detail">
            <div
              className="db-presentation-preview"
              role="img"
              aria-label={`Slide ${selectedIndex + 1}: ${beat.headline}`}
            >
              <MediaContext.Provider value={mediaProvider ?? null}>
                {visual && (
                  <BlockRenderer
                    block={visual}
                    blockTime={1}
                    animationsEnabled={false}
                    basePath="/"
                    viewport={VIEWPORT_PRESETS.landscape}
                  />
                )}
              </MediaContext.Provider>
            </div>
            <div className="db-presentation-fields">
              <label>
                Layout preference for this section
                <select
                  value={hint?.layout ?? ''}
                  disabled={!!progress}
                  onChange={(event) =>
                    updateHint({
                      layout: (event.target.value || undefined) as
                        | PresentationBeat['layout']
                        | undefined,
                    })
                  }
                >
                  <option value="">Automatic</option>
                  {PRESENTATION_LAYOUTS.filter((layout) => layout !== 'image' || beat.imageSrc).map(
                    (layout) => (
                      <option key={layout} value={layout}>
                        {LABELS[layout]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Supporting slides for this section
                <select
                  value={hint?.inbetweens === undefined ? '' : String(hint.inbetweens)}
                  disabled={!!progress}
                  onChange={(event) =>
                    updateHint({
                      inbetweens:
                        event.target.value === '' ? undefined : event.target.value === 'true',
                    })
                  }
                >
                  <option value="">Use document preference</option>
                  <option value="true">Allow</option>
                  <option value="false">Do not add</option>
                </select>
              </label>
            </div>
            <section className="db-presentation-source" aria-labelledby={originalTextId}>
              <div className="db-presentation-source-label">
                <h3 id={originalTextId}>Original document text</h3>
                <span>Read only</span>
              </div>
              <p>{section.text}</p>
            </section>
            {beat.sourceStart === section.sourceStart && (
              <details className="db-presentation-wording">
                <summary>Customize slide wording (slides only)</summary>
                <p>
                  This section’s opening slide can use your wording. If you change the section text,
                  it returns to an automatic summary.
                </p>
                <label>
                  Slide headline
                  <input
                    key={beat.headline}
                    defaultValue={beat.headline}
                    maxLength={110}
                    disabled={!!progress}
                    onBlur={(event) =>
                      updateHint({
                        wording: {
                          ...(hint?.wording?.source === section.text ? hint.wording : {}),
                          source: section.text,
                          headline: event.target.value.trim() || undefined,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Slide highlights, one per line
                  <textarea
                    rows={3}
                    key={beat.points.join('\n')}
                    defaultValue={beat.points.join('\n')}
                    disabled={!!progress}
                    onBlur={(event) =>
                      updateHint({
                        wording: {
                          ...(hint?.wording?.source === section.text ? hint.wording : {}),
                          source: section.text,
                          points: event.target.value.split('\n').filter(Boolean),
                        },
                      })
                    }
                  />
                </label>
              </details>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
