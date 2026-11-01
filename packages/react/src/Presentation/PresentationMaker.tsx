/** Design a live summarization. Persist intent and explicit wording, never generated slides. */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  setBlockDurationInSource,
  setBlockStartTimeInSource,
  templateLabel,
  useEditorContext,
  usePreviewSettingsOptional,
} from '@bendyline/squisq-editor-react';
import { BlockRenderer, MediaContext } from '@bendyline/squisq-react';
import {
  markdownToDoc,
  resolveAudioMapping,
  buildPreviewDoc,
  expandDocBlocks,
  flattenRenderableBlocks,
  getPinnedBlockMeta,
  previewBlockTemplate,
} from '@bendyline/squisq/doc';
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
  AUTHORED_PRESENTATION_LAYOUT,
  presentationPassageKey,
  type PresentationHints,
  type PresentationBlockHint,
  type PresentationBeat,
  type PresentationBeatLayout,
  type PresentationLayout,
} from '@bendyline/squisq/transform';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { useAiStatus, unavailableSentence } from '../Ai/ai-status.js';
import { AiReportButton } from '../Ai/AiOutputReport.js';
import { refinePresentationPlan } from './presentation-ai.js';

const LABELS: Record<PresentationLayout, string> = {
  title: 'Title',
  divider: 'Section divider',
  statement: 'Key idea',
  emphasis: 'Big statement',
  quote: 'Quote from the text',
  stat: 'Key number',
  definition: 'Definition',
  list: 'List',
  comparison: 'Comparison',
  steps: 'Steps diagram',
  image: 'Image',
};
/** What a chosen layout shows, and which slides it can apply to. */
const LAYOUT_HELP: Record<PresentationBeatLayout, string> = {
  authored:
    'Shows this section as written, as one slide for its whole narration. To change its block type, use the block picker in the editor.',
  title: 'A large headline with one supporting line.',
  divider: 'A section break that shows only the headline.',
  statement: 'One idea, with its highlights underneath.',
  emphasis:
    'Only the headline, very large. Used on slides whose headline is 60 characters or fewer.',
  quote:
    'One sentence from this section, word for word, set large. Used on slides with a sentence of 110 characters or fewer.',
  stat: 'A prominent number from the text, such as 40% or $3 million. Used on slides that state one.',
  definition: 'The headline as a term, with the highlights as its definition.',
  list: 'The highlights as a bulleted list. Used on slides with at least two.',
  comparison: 'Two highlights side by side. Used on slides with exactly two.',
  steps: 'The highlights as connected steps. Used on slides with at least two.',
  image: 'The section’s picture, with the headline as its caption.',
};
type Sections = ReturnType<typeof presentationSections>;
/** Where a suggestion run stands; `active` is the slide a request is open for. */
interface SuggestionProgress {
  done: number;
  total: number;
  active: { sourceStart: number; sourceEnd: number } | null;
}
function sectionAt(sections: Sections, offset: number) {
  return sections.find((item) => offset >= item.sourceStart && offset < item.sourceEnd);
}
/** Store one accepted suggestion keyed to the exact passage it summarizes, so
 * Squisq reapplies it only while that passage is unchanged. */
function withSuggestion(
  current: PresentationHints,
  sections: Sections,
  sourceText: string,
  item: PresentationBeat,
): PresentationHints {
  const parent = sectionAt(sections, item.sourceStart);
  if (!parent || item.layout === AUTHORED_PRESENTATION_LAYOUT) return current;
  const source = sourceText.slice(item.sourceStart, item.sourceEnd);
  const existing = current.blocks.find((block) => block.blockId === parent.blockId);
  const target: PresentationBlockHint = {
    ...(existing ?? { blockId: parent.blockId }),
    ai: [
      ...(existing?.ai ?? []).filter((entry) => entry.source !== source),
      { source, layout: item.layout, headline: item.headline, points: [...item.points] },
    ].slice(-80),
  };
  return {
    ...current,
    blocks: [...current.blocks.filter((block) => block.blockId !== parent.blockId), target],
  };
}
export function PresentationMaker({
  ai,
  onClose,
}: {
  ai?: DocBlocksHostAiAPI;
  onClose: () => void;
}) {
  return createPortal(<PresentationDialog ai={ai} onClose={onClose} />, document.body);
}
/** Flag the AI slide wording held in the current design. */
function AiSuggestionReport({ ai, hints }: { ai: DocBlocksHostAiAPI; hints: PresentationHints }) {
  const status = useAiStatus(ai);
  const suggestions = hints.blocks.flatMap((block) => block.ai ?? []);
  if (suggestions.length === 0) return null;
  return (
    <AiReportButton
      feature="Suggest slides"
      getOutput={() =>
        suggestions
          .map((entry) => [entry.headline, ...entry.points.map((point) => `- ${point}`)].join('\n'))
          .join('\n\n')
      }
      model={status?.kind === 'ready' ? (status.model?.label ?? null) : null}
    />
  );
}
function AiRefineButton({
  ai,
  disabled,
  buttonRef,
  onRefine,
}: {
  ai: DocBlocksHostAiAPI;
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement>;
  onRefine: () => void;
}) {
  const status = useAiStatus(ai);
  const ready = status?.kind === 'ready' && status.model !== null;
  return (
    <button
      ref={buttonRef}
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
  const layoutHelpId = useId();
  const [hints, setHints] = useState<PresentationHints>(
    () =>
      parsePresentationHints(parseMarkdown(markdownSource).frontmatter?.[PRESENTATION_HINTS_KEY]) ??
      defaultPresentationHints(),
  );
  // One slide per section never adds supporting slides, so their controls rest.
  const perSection = hints.density === 'section';
  const [loaded, setLoaded] = useState<{ doc: Doc; source: string } | null>(null);
  const [selectedSourceStart, setSelectedSourceStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<SuggestionProgress | null>(null);
  const controller = useRef<AbortController | null>(null);
  /** Show each slide as it is suggested until the person picks one themselves. */
  const follow = useRef(false);
  const suggestButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const slidesRef = useRef<HTMLElement>(null);
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
  const running = progress !== null;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    // The Suggest button leaves the footer for the run and Stop takes its
    // place; keep keyboard focus with them instead of dropping it on the page.
    if (document.activeElement === null || document.activeElement === document.body)
      (running ? stopButton.current : suggestButton.current)?.focus();
  }, [running]);
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
    // A hidden slide still previews, so it can be judged and shown again; the
    // deck itself leaves it out.
    const every = { ...plan, beats: plan.beats.map(({ hidden: _hidden, ...beat }) => beat) };
    // Through the deck's own slide projection, so an authored section previews
    // with the template and content the slideshow and video will use.
    const expand = (projected: Doc) => {
      const slides = buildPreviewDoc(projected);
      return expandDocBlocks(slides.blocks, {
        theme: preview?.activeTheme,
        viewport: VIEWPORT_PRESETS.landscape,
        audioSegments: slides.audio.segments,
      });
    };
    try {
      const projected = compilePresentationPlan(doc, every);
      return { doc: projected, blocks: expand(projected), error: null };
    } catch (cause: unknown) {
      // A narration problem must not blank the slides: preview them at reading
      // pace while the alert explains what stops them following the narration.
      let blocks: ReturnType<typeof expand> = [];
      try {
        const untimed: Doc = {
          ...doc,
          presentationNarration: undefined,
          documentMedia: doc.documentMedia?.filter((clip) => clip.anchor !== 'document'),
        };
        blocks = expand(compilePresentationPlan(untimed, every));
      } catch {
        // The plan itself no longer fits the document; the alert says so.
      }
      return {
        doc: null,
        blocks,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [doc, plan, preview?.activeTheme]);
  // Pinned section times stop a deck from following its narration, and they
  // are invisible in Write view, so the alert offers to remove them.
  const pinnedLines = useMemo(
    () =>
      doc?.presentationNarration
        ? flattenRenderableBlocks(doc.blocks).flatMap((block) => {
            const pin = getPinnedBlockMeta(block);
            const line = block.sourceHeading?.position?.start.line;
            return line !== undefined && (pin.duration !== undefined || pin.startTime !== undefined)
              ? [line]
              : [];
          })
        : [],
    [doc],
  );
  const removePins = () => {
    let next = markdownSource;
    for (const line of pinnedLines) {
      next = setBlockDurationInSource(next, line, null) ?? next;
      next = setBlockStartTimeInSource(next, line, null) ?? next;
    }
    if (next !== markdownSource) replaceAll(next);
  };
  // Stored AI wording per section, keyed by the passage it summarizes. Squisq
  // applies an entry only while its passage is unchanged, so this is also what
  // marks a slide in the list as AI-suggested.
  const aiEntries = useMemo(() => {
    const entries = new Map<string, Map<string, PresentationBeat['layout']>>();
    for (const block of hints.blocks)
      entries.set(
        block.blockId,
        new Map((block.ai ?? []).map((entry) => [entry.source, entry.layout])),
      );
    return entries;
  }, [hints]);
  // Names the block type each section renders with when shown as authored.
  const authoredLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (!doc) return labels;
    for (const block of flattenRenderableBlocks(doc.blocks))
      labels.set(
        block.id,
        `As authored (${templateLabel(previewBlockTemplate(block, doc), doc.customTemplates)})`,
      );
    return labels;
  }, [doc]);
  const layoutLabel = (layout: PresentationBeatLayout, blockId: string | undefined) =>
    layout === AUTHORED_PRESENTATION_LAYOUT
      ? (authoredLabels.get(blockId ?? '') ?? 'As authored')
      : LABELS[layout];
  // Layout changes can split or merge slides. Follow the source passage rather
  // than a slide number, which could now belong to a different section.
  const selectedIndex = Math.max(
    0,
    plan?.beats.findIndex(
      (item) => selectedSourceStart >= item.sourceStart && selectedSourceStart < item.sourceEnd,
    ) ?? -1,
  );
  const beat = plan?.beats[selectedIndex];
  const section = beat && sectionAt(sections, beat.sourceStart);
  const hint = hints.blocks.find((item) => item.blockId === section?.blockId);
  const visual = projection?.blocks.find((block) => block.id === beat?.id);
  const handleSlideKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
    )
      return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest('input, textarea, select') || target.isContentEditable)
    )
      return;
    if (!plan?.beats.length) return;
    event.preventDefault();
    event.stopPropagation();
    follow.current = false;
    const nextIndex = Math.max(
      0,
      Math.min(plan.beats.length - 1, selectedIndex + (event.key === 'ArrowRight' ? 1 : -1)),
    );
    setSelectedSourceStart(plan.beats[nextIndex].sourceStart);
    const button = slidesRef.current?.querySelectorAll('button')[nextIndex];
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
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
  const hiddenCount = plan?.beats.filter((item) => item.hidden).length ?? 0;
  const shownCount = (plan?.beats.length ?? 0) - hiddenCount;
  const slideCount = `${shownCount} ${shownCount === 1 ? 'slide' : 'slides'}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`;
  /** Hide or show the selected slide, remembered by its exact source passage. */
  const setHidden = (hide: boolean) => {
    if (!plan || !beat) return;
    const key = presentationPassageKey(plan.sourceText.slice(beat.sourceStart, beat.sourceEnd));
    const rest = (hint?.hidden ?? []).filter((item) => item !== key);
    const hidden = hide ? [...rest, key].slice(-80) : rest;
    updateHint({ hidden: hidden.length ? hidden : undefined });
  };
  const refine = async () => {
    if (!ai || !plan || controller.current) return;
    const run = new AbortController();
    controller.current = run;
    follow.current = true;
    const total = plan.beats.length;
    const outcome = { done: 0, refined: 0, retained: 0 };
    setError(null);
    setNotice('');
    try {
      await refinePresentationPlan(ai, plan, {
        signal: run.signal,
        onProgress: (done) => {
          outcome.done = done;
          const next = plan.beats[done];
          setProgress({
            done,
            total,
            active: next ? { sourceStart: next.sourceStart, sourceEnd: next.sourceEnd } : null,
          });
          if (next && follow.current) setSelectedSourceStart(next.sourceStart);
        },
        // Each accepted slide reaches the list and preview as soon as it
        // resolves, so stopping early keeps everything suggested so far.
        onBeat: (_index, item) => {
          if (!item) {
            outcome.retained++;
            return;
          }
          outcome.refined++;
          setHints((current) => withSuggestion(current, sections, plan.sourceText, item));
        },
      });
      setNotice(
        outcome.retained
          ? `Kept automatic summaries for ${outcome.retained} slides because the AI suggestions could not be validated.`
          : 'AI summaries are ready to review. They will be saved with their source passages.',
      );
    } catch (cause: unknown) {
      if (!run.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      else if (controller.current === run)
        setNotice(
          `Stopped after ${outcome.done} of ${total} slides. ${
            outcome.refined === 0
              ? 'No slides changed.'
              : outcome.refined === 1
                ? 'The one AI suggestion is kept.'
                : `The ${outcome.refined} AI suggestions are kept.`
          }`,
        );
    } finally {
      if (controller.current === run) {
        controller.current = null;
        setProgress(null);
      }
    }
  };
  const apply = () => {
    if (!doc || !plan || running) return;
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
      onKeyDown={handleSlideKeyDown}
      closeOnBackdrop={false}
      footer={
        <>
          <button
            type="button"
            disabled={running}
            onClick={() => {
              setHints(defaultPresentationHints());
              setSelectedSourceStart(0);
              setError(null);
              setNotice('');
            }}
          >
            Reset design
          </button>
          {ai && !progress && (
            <AiRefineButton
              ai={ai}
              buttonRef={suggestButton}
              disabled={!plan}
              onRefine={() => void refine()}
            />
          )}
          {ai && progress && (
            <>
              <div className="db-presentation-progress" role="status">
                <span className="db-ai-spinner" aria-hidden="true" />
                <span>
                  Suggesting slide {Math.min(progress.done + 1, progress.total)} of {progress.total}
                  …
                </span>
                <progress
                  max={progress.total}
                  value={progress.done}
                  aria-label="Slides suggested so far"
                />
              </div>
              <button
                ref={stopButton}
                type="button"
                title="Stop suggesting. Slides already suggested keep their new wording."
                onClick={() => controller.current?.abort()}
              >
                Stop
              </button>
            </>
          )}
          <button type="button" disabled={!plan || running || !!error} onClick={apply}>
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
            disabled={running}
            onChange={(event) =>
              setHints({ ...hints, density: event.target.value as PresentationHints['density'] })
            }
          >
            <option value="concise">Concise — shorter passages per slide</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed — longer passages per slide</option>
            <option value="section">One slide per section — no splits or supporting slides</option>
          </select>
        </label>
        <label className="db-presentation-toggle">
          <input
            type="checkbox"
            checked={hints.inbetweens && !perSection}
            disabled={running || perSection}
            onChange={(event) => setHints({ ...hints, inbetweens: event.target.checked })}
          />{' '}
          Add supporting visual slides where useful
        </label>
      </div>
      <p role="status" aria-live="polite">
        {plan && projection?.doc
          ? `${slideCount} · ${projection.doc.duration.toFixed(1)} seconds · ${doc?.presentationNarration ? 'Follows narration' : 'Estimated pacing — add narration to synchronize'}`
          : plan && projection?.error
            ? `${slideCount} · Not synchronized with the narration`
            : 'Preparing dynamic slides…'}
      </p>
      {(error || generated?.error || projection?.error) && (
        <p role="alert">
          {error ?? generated?.error ?? projection?.error}
          {!error && !generated?.error && projection?.error && pinnedLines.length > 0 && (
            <>
              {' '}
              <button type="button" disabled={running} onClick={removePins}>
                Remove pinned times
              </button>
            </>
          )}
        </p>
      )}
      {notice && (
        <p role="status">
          {notice}
          {ai && !running && (
            <>
              {' '}
              <AiSuggestionReport ai={ai} hints={hints} />
            </>
          )}
        </p>
      )}
      {plan && beat && section && (
        <div className="db-presentation-workspace">
          <nav ref={slidesRef} className="db-presentation-beats" aria-label="Presentation slides">
            {plan.beats.map((item, index) => {
              const owner = sectionAt(sections, item.sourceStart);
              const layout =
                owner &&
                aiEntries
                  .get(owner.blockId)
                  ?.get(plan.sourceText.slice(item.sourceStart, item.sourceEnd));
              const suggested =
                item.layout !== AUTHORED_PRESENTATION_LAYOUT &&
                layout !== undefined &&
                (layout !== 'image' || !!item.imageSrc);
              const active = progress?.active;
              const pending =
                !!active &&
                active.sourceStart === item.sourceStart &&
                active.sourceEnd === item.sourceEnd;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={item.hidden ? 'db-presentation-beat-hidden' : undefined}
                  aria-current={index === selectedIndex ? 'step' : undefined}
                  title={item.headline}
                  onClick={() => {
                    follow.current = false;
                    setSelectedSourceStart(item.sourceStart);
                  }}
                >
                  <span className="db-presentation-beat-title">
                    {index + 1}. {item.headline}
                  </span>
                  <span className="db-presentation-beat-tags">
                    <small>{layoutLabel(item.layout, owner?.blockId)}</small>
                    {item.hidden && <small>Hidden</small>}
                    {pending ? (
                      <small className="db-presentation-beat-ai">
                        <span className="db-ai-spinner" aria-hidden="true" />
                        Suggesting…
                      </small>
                    ) : suggested ? (
                      <small className="db-presentation-beat-ai">
                        <span className="db-visually-hidden">Suggested by </span>AI
                      </small>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="db-presentation-detail">
            <div
              className={`db-presentation-preview${beat.hidden ? ' db-presentation-preview-hidden' : ''}`}
              role="img"
              aria-label={`Slide ${selectedIndex + 1}${beat.hidden ? ' (hidden)' : ''}: ${beat.headline}`}
            >
              <MediaContext.Provider value={mediaProvider ?? null}>
                {visual && (
                  <BlockRenderer
                    block={visual}
                    blockTime={1}
                    animationsEnabled={false}
                    basePath="/"
                    viewport={VIEWPORT_PRESETS.landscape}
                    theme={preview?.activeTheme}
                  />
                )}
              </MediaContext.Provider>
            </div>
            <label className="db-presentation-toggle">
              <input
                type="checkbox"
                checked={!!beat.hidden}
                // A deck needs at least one slide.
                disabled={running || (!beat.hidden && shownCount <= 1)}
                onChange={(event) => setHidden(event.target.checked)}
              />{' '}
              Hide this slide in the presentation
            </label>
            <div className="db-presentation-fields">
              <label>
                Layout preference for this section
                <select
                  value={hint?.layout ?? ''}
                  disabled={running}
                  aria-describedby={hint?.layout ? layoutHelpId : undefined}
                  onChange={(event) =>
                    updateHint({
                      layout: (event.target.value || undefined) as
                        | PresentationBeatLayout
                        | undefined,
                    })
                  }
                >
                  <option value="">Automatic</option>
                  <option value={AUTHORED_PRESENTATION_LAYOUT}>
                    {layoutLabel(AUTHORED_PRESENTATION_LAYOUT, section.blockId)}
                  </option>
                  <optgroup label="Summary layouts">
                    {PRESENTATION_LAYOUTS.filter(
                      (layout) => layout !== 'image' || beat.imageSrc,
                    ).map((layout) => (
                      <option key={layout} value={layout}>
                        {LABELS[layout]}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              {!perSection && beat.layout !== AUTHORED_PRESENTATION_LAYOUT && (
                <label>
                  Supporting slides for this section
                  <select
                    value={hint?.inbetweens === undefined ? '' : String(hint.inbetweens)}
                    disabled={running}
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
              )}
            </div>
            {hint?.layout && (
              <p id={layoutHelpId} className="db-presentation-layout-help">
                {LAYOUT_HELP[hint.layout]}
              </p>
            )}
            <section className="db-presentation-source" aria-labelledby={originalTextId}>
              <div className="db-presentation-source-label">
                <h3 id={originalTextId}>Original document text</h3>
                <span>Read only</span>
              </div>
              <p>{section.text}</p>
            </section>
            {beat.sourceStart === section.sourceStart &&
              beat.layout !== AUTHORED_PRESENTATION_LAYOUT && (
                <details className="db-presentation-wording">
                  <summary>Customize slide wording (slides only)</summary>
                  <p>
                    This section’s opening slide can use your wording. If you change the section
                    text, it returns to an automatic summary.
                  </p>
                  <label>
                    Slide headline
                    <input
                      key={beat.headline}
                      defaultValue={beat.headline}
                      maxLength={110}
                      disabled={running}
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
                      disabled={running}
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
