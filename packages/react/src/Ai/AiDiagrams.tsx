/**
 * AI diagrams: "Insert diagram…" and the "Illustrate document" panel.
 *
 * The model describes each diagram as a small JSON spec; DocBlocks compiles,
 * checks, and previews it, and inserts it as one undoable edit. See
 * `illustrate-pipeline.ts` for the calls and `illustrate-passages.ts` for
 * where diagrams go.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  headingDepthForInsertion,
  useEditorContext,
  usePreviewSettingsOptional,
  validateMermaidSource,
  type BlockInsertionBuilder,
  type EditorSelectionInfo,
  type InsertBlockOptions,
} from '@bendyline/squisq-editor-react';
import { LinearDocView } from '@bendyline/squisq-react/page';
import type { DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

import { Dialog } from '../components/Dialog.js';
import { unavailableSentence, useAiStatus } from './ai-status.js';
import type { CompiledDiagram } from './diagram-compile.js';
import { clip } from './diagram-sanitize.js';
import { DIAGRAM_KINDS, DIAGRAM_KIND_LABELS, type DiagramKind } from './diagram-spec.js';
import {
  documentTitle,
  idsIn,
  locatePassage,
  planInsertions,
  type PendingInsertion,
} from './illustrate-passages.js';
import {
  realizeDiagram,
  specSummaryForAvoid,
  startIllustrationRun,
  type DiagramOutcome,
  type IllustrationRun,
} from './illustrate-pipeline.js';
import {
  AI_DIAGRAM_DESCRIPTION_CHARACTERS,
  inferKind,
  promptBudget,
  type PlanPick,
} from './illustrate-prompts.js';

/** Kinds whose links between boxes cannot be checked against the text. */
const LINKED_KINDS: ReadonlySet<DiagramKind> = new Set(['flow', 'sequence', 'hierarchy']);

function contextWindowOf(status: ReturnType<typeof useAiStatus>): number | null {
  return status?.kind === 'ready' ? (status.model?.contextWindow ?? null) : null;
}

/** The diagram as the document will show it, labelled with its text alternative. */
export function DiagramPreview({ compiled }: { compiled: CompiledDiagram }) {
  const preview = usePreviewSettingsOptional();
  const markdown = useMemo(() => compiled.render(2, new Set()), [compiled]);
  return (
    <div
      className="db-ai-diagram-preview"
      role="img"
      aria-label={`${compiled.title}. ${compiled.summary}`}
    >
      <LinearDocView
        markdown={markdown}
        showCover={false}
        thinMargins
        theme={preview?.activeTheme}
      />
    </div>
  );
}

function DiagramSource({ compiled }: { compiled: CompiledDiagram }) {
  const markdown = useMemo(() => compiled.render(2, new Set()), [compiled]);
  return <pre className="db-ai-diagram-source">{markdown}</pre>;
}

function placementNote(compiled: CompiledDiagram): string | null {
  return compiled.placement === 'sectionEnd' ? 'Goes at the end of this section.' : null;
}

// ─── Insert diagram dialog ─────────────────────────────────

export interface AiDiagramDialogProps {
  ai: DocBlocksHostAiAPI;
  documentSource: string;
  capturedSelection: EditorSelectionInfo;
  getSelection: () => EditorSelectionInfo | null;
  insertBlockAfterCursor: (
    block: string | BlockInsertionBuilder,
    options?: InsertBlockOptions,
  ) => boolean;
  onClose: () => void;
}

export function AiDiagramDialog({
  ai,
  documentSource,
  capturedSelection,
  getSelection,
  insertBlockAfterCursor,
  onClose,
}: AiDiagramDialogProps) {
  const status = useAiStatus(ai);
  const material = capturedSelection.text.trim();
  const [description, setDescription] = useState('');
  const [kindChoice, setKindChoice] = useState<'auto' | DiagramKind>('auto');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<DiagramOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const autoKind = inferKind(description, material);
  const kind = kindChoice === 'auto' ? autoKind : kindChoice;
  const ready = outcome?.status === 'ready' ? outcome : null;

  const generate = useCallback(async () => {
    const request = description.trim();
    if (!request && !material) {
      setError('Describe the diagram you want, or select the text to draw it from.');
      promptRef.current?.focus();
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestRef.current;
    const avoid = ready ? specSummaryForAvoid(ready.compiled) : undefined;
    setRunning(true);
    setError(null);
    const result = await realizeDiagram({
      ai,
      kind,
      material: material || request,
      heading: '',
      title: request ? clip(request.charAt(0).toUpperCase() + request.slice(1), 60) : '',
      description: request || undefined,
      avoid,
      // With selected text, the diagram must stick to it. Without, the person
      // asked the model to supply the content.
      ground: material.length > 0,
      budget: promptBudget(contextWindowOf(status)),
      validateMermaid: validateMermaidSource,
      signal: controller.signal,
    });
    if (requestRef.current !== requestId) return;
    setRunning(false);
    if (result.status === 'cancelled') return;
    if (result.status === 'failed') {
      setError(result.message);
      return;
    }
    setOutcome(result);
  }, [ai, description, kind, material, ready, status]);

  const stop = useCallback(() => controllerRef.current?.abort(), []);

  const insert = useCallback(() => {
    if (!ready) return;
    const current = getSelection();
    if (!current || current.view !== capturedSelection.view) {
      setError('Return to the original editor view and try again.');
      return;
    }
    const { compiled } = ready;
    const taken = idsIn(documentSource);
    let noDepth = false;
    const inserted = insertBlockAfterCursor(
      (context) => {
        if (compiled.placement === 'afterBlock') return compiled.render(2, taken);
        const depth = headingDepthForInsertion(context, { childLevels: 1 });
        if (depth === null) noDepth = true;
        return depth === null ? null : compiled.render(depth, taken);
      },
      { placement: compiled.placement },
    );
    if (!inserted) {
      setError(
        noDepth
          ? 'This diagram cannot go at the end of this section. Move the cursor to another section and try again.'
          : 'DocBlocks could not insert the diagram in the current editor view.',
      );
      return;
    }
    onClose();
  }, [
    capturedSelection.view,
    documentSource,
    getSelection,
    insertBlockAfterCursor,
    onClose,
    ready,
  ]);

  const dialog = (
    <Dialog
      title="Insert diagram with AI"
      onClose={onClose}
      size="wide"
      closeOnBackdrop={!running}
      initialFocusRef={promptRef as RefObject<HTMLElement | null>}
      className="db-ai-draft-dialog db-ai-diagram-dialog"
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {running ? (
            <button type="button" className="db-ai-secondary-action" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="db-ai-secondary-action"
              onClick={() => void generate()}
            >
              {ready ? 'Regenerate' : 'Generate'}
            </button>
          )}
          <button type="button" disabled={!ready || running} onClick={insert}>
            Insert
          </button>
        </>
      }
    >
      <label className="db-ai-field">
        <span>What should the diagram show?</span>
        <textarea
          ref={promptRef}
          value={description}
          maxLength={AI_DIAGRAM_DESCRIPTION_CHARACTERS}
          rows={3}
          placeholder={
            material
              ? 'Optional. For example: Show the approval steps as a flowchart.'
              : 'For example: How a pull request is reviewed and merged.'
          }
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      <label className="db-ai-field db-ai-field--inline">
        <span>Kind</span>
        <select
          value={kindChoice}
          onChange={(event) => setKindChoice(event.currentTarget.value as 'auto' | DiagramKind)}
        >
          <option value="auto">Auto ({DIAGRAM_KIND_LABELS[autoKind]})</option>
          {DIAGRAM_KINDS.map((option) => (
            <option key={option} value={option}>
              {DIAGRAM_KIND_LABELS[option]}
            </option>
          ))}
        </select>
      </label>

      {material && (
        <div className="db-ai-selection-preview">
          <span>Drawing from the selected text</span>
          <blockquote>{clip(material, 600)}</blockquote>
        </div>
      )}

      {running && (
        <p className="db-ai-progress" role="status">
          <span className="db-ai-spinner" aria-hidden="true" /> Drawing…
        </p>
      )}
      {ready && !running && (
        <div className="db-ai-diagram-result">
          <DiagramPreview compiled={ready.compiled} />
          {ready.notes.map((note) => (
            <p key={note} className="db-ai-note">
              {note}
            </p>
          ))}
          {placementNote(ready.compiled) && (
            <p className="db-ai-note">{placementNote(ready.compiled)}</p>
          )}
          {LINKED_KINDS.has(ready.compiled.kind) && (
            <p className="db-ai-note">Check the links between boxes before inserting.</p>
          )}
          <button
            type="button"
            className="db-ai-link-button"
            aria-expanded={showSource}
            onClick={() => setShowSource((open) => !open)}
          >
            {showSource ? 'Hide source' : 'Show source'}
          </button>
          {showSource && <DiagramSource compiled={ready.compiled} />}
        </div>
      )}
      {status && !(status.kind === 'ready' && status.model) && (
        <p className="db-ai-note">{unavailableSentence(status)}</p>
      )}
      {error && (
        <p className="db-ai-error" role="alert">
          {error}
        </p>
      )}
      <p className="db-ai-disclaimer">Review AI-generated diagrams before adding them.</p>
    </Dialog>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

// ─── Illustrate panel ──────────────────────────────────────

interface Suggestion {
  readonly key: string;
  readonly pick: PlanPick;
  readonly state: 'waiting' | 'drawing' | 'done';
  readonly outcome: DiagramOutcome | null;
  readonly inserted: boolean;
  readonly dismissed: boolean;
  readonly problem: string | null;
}

type IllustratePhase = 'idle' | 'planning' | 'drawing' | 'done' | 'error';

export interface AiIllustratePanelProps {
  ai: DocBlocksHostAiAPI;
  onClose: () => void;
}

export function AiIllustratePanel({ ai, onClose }: AiIllustratePanelProps) {
  const { markdownSource, applySourceEdits } = useEditorContext();
  const status = useAiStatus(ai);
  const contextWindow = contextWindowOf(status);
  const ready = status?.kind === 'ready' && status.model !== null;
  const [phase, setPhase] = useState<IllustratePhase>('idle');
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [kindChoice, setKindChoice] = useState<Readonly<Record<string, DiagramKind>>>({});
  const runRef = useRef<IllustrationRun | null>(null);
  const regenerateRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const startedRef = useRef(false);

  const update = useCallback((key: string, change: (current: Suggestion) => Suggestion) => {
    setSuggestions((current) => current.map((item) => (item.key === key ? change(item) : item)));
  }, []);

  const start = useCallback(() => {
    runRef.current?.cancel();
    regenerateRef.current?.abort();
    const generation = ++generationRef.current;
    setSuggestions([]);
    setError(null);
    setNotice(null);
    setProgress(null);
    setPhase('planning');
    runRef.current = startIllustrationRun({
      ai,
      source: markdownSource,
      title: documentTitle(markdownSource),
      budget: promptBudget(contextWindow),
      validateMermaid: validateMermaidSource,
      onEvent: (event) => {
        if (generationRef.current !== generation) return;
        switch (event.type) {
          case 'planning':
            setPhase('planning');
            break;
          case 'planned':
            setSuggestions(
              event.picks.map((pick) => ({
                key: pick.passage.id,
                pick,
                state: 'waiting',
                outcome: null,
                inserted: false,
                dismissed: false,
                problem: null,
              })),
            );
            break;
          case 'drawing':
            setPhase('drawing');
            setProgress({ index: event.index, total: event.total });
            setSuggestions((current) =>
              current.map((item, index) =>
                index === event.index ? { ...item, state: 'drawing' } : item,
              ),
            );
            break;
          case 'suggestion':
            update(event.pick.passage.id, (item) => ({
              ...item,
              state: 'done',
              outcome: event.outcome,
            }));
            break;
          case 'error':
            setError(event.message);
            setPhase('error');
            break;
          case 'done':
            runRef.current = null;
            setProgress(null);
            setPhase((current) => (current === 'error' ? current : 'done'));
            setSuggestions((current) =>
              current.map((item) => (item.state === 'done' ? item : { ...item, state: 'done' })),
            );
            break;
        }
      },
    });
  }, [ai, contextWindow, markdownSource, update]);

  const stop = useCallback(() => {
    runRef.current?.cancel();
    regenerateRef.current?.abort();
  }, []);

  useEffect(() => {
    if (startedRef.current || !ready) return;
    startedRef.current = true;
    start();
  }, [ready, start]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      runRef.current?.cancel();
      regenerateRef.current?.abort();
      // StrictMode replays mount effects in development; let the replay start.
      startedRef.current = false;
    },
    [],
  );

  const insert = useCallback(
    (items: readonly Suggestion[]) => {
      const pending: PendingInsertion[] = [];
      for (const item of items) {
        if (item.inserted || item.dismissed || item.outcome?.status !== 'ready') continue;
        pending.push({
          key: item.key,
          passage: item.pick.passage,
          compiled: item.outcome.compiled,
        });
      }
      if (pending.length === 0) return;
      const plan = planInsertions(markdownSource, pending);
      const stale = new Set(plan.stale);
      const unplaceable = new Set(plan.unplaceable);
      if (plan.edits.length > 0 && !applySourceEdits(plan.edits, { baseSource: markdownSource })) {
        setNotice('Switch to Write or Source view, in the Document layout, to insert diagrams.');
        return;
      }
      setNotice(null);
      setSuggestions((current) =>
        current.map((item) => {
          if (!pending.some((entry) => entry.key === item.key)) return item;
          if (stale.has(item.key)) {
            return {
              ...item,
              problem: 'This passage changed. Regenerate the diagram or dismiss it.',
            };
          }
          if (unplaceable.has(item.key)) {
            return {
              ...item,
              problem:
                'No heading level fits at the end of this section without capturing the text after it.',
            };
          }
          return { ...item, inserted: true, problem: null };
        }),
      );
    },
    [applySourceEdits, markdownSource],
  );

  const regenerate = useCallback(
    async (item: Suggestion) => {
      if (runRef.current || regenerating) return;
      const kind = kindChoice[item.key] ?? item.pick.kind;
      const controller = new AbortController();
      regenerateRef.current = controller;
      const generation = generationRef.current;
      setRegenerating(item.key);
      update(item.key, (current) => ({ ...current, state: 'drawing', problem: null }));
      const outcome = await realizeDiagram({
        ai,
        kind,
        material: item.pick.passage.plain,
        heading: item.pick.passage.heading,
        title: item.pick.title,
        avoid:
          item.outcome?.status === 'ready' && kind === item.pick.kind
            ? specSummaryForAvoid(item.outcome.compiled)
            : undefined,
        ground: true,
        budget: promptBudget(contextWindow),
        validateMermaid: validateMermaidSource,
        signal: controller.signal,
      });
      if (generationRef.current !== generation) return;
      setRegenerating(null);
      regenerateRef.current = null;
      update(item.key, (current) =>
        outcome.status === 'cancelled'
          ? { ...current, state: 'done' }
          : { ...current, state: 'done', outcome, pick: { ...current.pick, kind } },
      );
    },
    [ai, contextWindow, kindChoice, regenerating, update],
  );

  const busy = phase === 'planning' || phase === 'drawing' || regenerating !== null;
  const visible = suggestions.filter((item) => !item.dismissed);
  const insertable = visible.filter(
    (item) =>
      !item.inserted &&
      item.outcome?.status === 'ready' &&
      locatePassage(markdownSource, item.pick.passage) !== null,
  );

  return (
    <aside className="db-ai-review-panel db-ai-illustrate-panel" aria-label="AI illustrations">
      <div className="db-ai-review-header">
        <div>
          <h2>AI illustrations</h2>
          {phase === 'done' && (
            <span className="db-ai-review-count">
              {visible.length} {visible.length === 1 ? 'suggestion' : 'suggestions'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="db-ai-review-close"
          onClick={onClose}
          aria-label="Close AI illustrations"
        >
          ×
        </button>
      </div>

      <div className="db-ai-review-actions">
        {busy ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" disabled={!ready} onClick={start}>
            {phase === 'idle' ? 'Suggest diagrams' : 'Suggest again'}
          </button>
        )}
      </div>

      {!ready && status && (
        <div className="db-ai-review-empty" role="status">
          {unavailableSentence(status)}
        </div>
      )}
      {(phase === 'planning' || phase === 'drawing') && (
        <div className="db-ai-review-empty" role="status">
          <span className="db-ai-spinner" aria-hidden="true" />{' '}
          {phase === 'planning' || !progress
            ? 'Reading the document…'
            : `Drawing diagram ${String(progress.index + 1)} of ${String(progress.total)}…`}
        </div>
      )}
      {phase === 'error' && error && (
        <div className="db-ai-review-empty db-ai-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="db-ai-review-stale" role="status">
          {notice}
        </div>
      )}
      {phase === 'done' && visible.length === 0 && (
        <div className="db-ai-review-empty">
          {suggestions.length === 0
            ? 'No passage here would be clearer as a diagram.'
            : 'All suggestions have been handled.'}
        </div>
      )}

      <ol className="db-ai-review-list">
        {visible.map((item) => {
          const outcome = item.outcome;
          const compiled = outcome?.status === 'ready' ? outcome.compiled : null;
          const kind = item.pick.kind;
          const passageMoved = locatePassage(markdownSource, item.pick.passage) === null;
          return (
            <li key={item.key} className="db-ai-review-finding db-ai-illustrate-card">
              <div className="db-ai-review-finding-meta">
                <span className="db-ai-review-severity db-ai-illustrate-kind">
                  {DIAGRAM_KIND_LABELS[kind]}
                </span>
                {item.pick.passage.heading && <span>{clip(item.pick.passage.heading, 48)}</span>}
              </div>
              <h3>{compiled?.title || item.pick.title || DIAGRAM_KIND_LABELS[kind]}</h3>
              {item.pick.why && <p>{item.pick.why}</p>}
              <div className="db-ai-review-excerpt">
                <span>After</span>
                <blockquote>{clip(item.pick.passage.plain, 180)}</blockquote>
              </div>

              {item.state === 'waiting' && <p className="db-ai-note">Waiting…</p>}
              {item.state === 'drawing' && (
                <p className="db-ai-progress" role="status">
                  <span className="db-ai-spinner" aria-hidden="true" /> Drawing…
                </p>
              )}
              {item.inserted && <p className="db-ai-note">Inserted.</p>}
              {item.state === 'done' && compiled && !item.inserted && (
                <>
                  <DiagramPreview compiled={compiled} />
                  {placementNote(compiled) && (
                    <p className="db-ai-note">{placementNote(compiled)}</p>
                  )}
                  {LINKED_KINDS.has(compiled.kind) && (
                    <p className="db-ai-note">Check the links between boxes before inserting.</p>
                  )}
                  {sourceOpen.has(item.key) && <DiagramSource compiled={compiled} />}
                </>
              )}
              {item.state === 'done' && outcome?.status === 'failed' && (
                <p className="db-ai-error" role="alert">
                  {outcome.message}
                </p>
              )}
              {passageMoved && !item.inserted && (
                <p className="db-ai-error" role="alert">
                  This passage changed. Regenerate the diagram or dismiss it.
                </p>
              )}
              {item.problem && !passageMoved && (
                <p className="db-ai-error" role="alert">
                  {item.problem}
                </p>
              )}

              {!item.inserted && item.state === 'done' && (
                <div className="db-ai-review-finding-actions db-ai-illustrate-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setSuggestions((current) =>
                        current.map((entry) =>
                          entry.key === item.key ? { ...entry, dismissed: true } : entry,
                        ),
                      )
                    }
                  >
                    Dismiss
                  </button>
                  {compiled && (
                    <button
                      type="button"
                      aria-expanded={sourceOpen.has(item.key)}
                      onClick={() =>
                        setSourceOpen((current) => {
                          const next = new Set(current);
                          if (next.has(item.key)) next.delete(item.key);
                          else next.add(item.key);
                          return next;
                        })
                      }
                    >
                      {sourceOpen.has(item.key) ? 'Hide source' : 'Source'}
                    </button>
                  )}
                  <select
                    aria-label="Diagram kind"
                    value={kindChoice[item.key] ?? kind}
                    disabled={busy || passageMoved}
                    onChange={(event) => {
                      const value = event.currentTarget.value as DiagramKind;
                      setKindChoice((current) => ({ ...current, [item.key]: value }));
                    }}
                  >
                    {DIAGRAM_KINDS.map((option) => (
                      <option key={option} value={option}>
                        {DIAGRAM_KIND_LABELS[option]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || passageMoved}
                    onClick={() => void regenerate(item)}
                  >
                    Regenerate
                  </button>
                  {compiled && (
                    <button
                      type="button"
                      disabled={busy || passageMoved}
                      onClick={() => insert([item])}
                    >
                      Insert
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {insertable.length > 1 && !busy && (
        <div className="db-ai-review-actions db-ai-illustrate-footer">
          <button type="button" onClick={() => insert(insertable)}>
            Insert all ({insertable.length})
          </button>
        </div>
      )}
      <p className="db-ai-review-disclaimer">
        AI diagrams can be wrong. Check each one before inserting it.
      </p>
    </aside>
  );
}
