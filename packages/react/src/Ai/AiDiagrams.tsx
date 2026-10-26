/**
 * AI diagrams: "Insert diagram…" and the "Illustrate document" panel.
 *
 * The model describes each diagram as a small JSON spec; DocBlocks compiles,
 * checks, and previews it, and inserts it as one undoable edit. The panel
 * works in two steps: ideas (what to picture, editable) and then pictures.
 * See `illustrate-pipeline.ts` for the calls and `illustrate-passages.ts` for
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
import { AiReportButton } from './AiOutputReport.js';
import { AiKnowledgeIndicator } from './AiKnowledgeIndicator.js';
import { useAiKnowledge } from './ai-knowledge.js';
import { unavailableSentence, useAiStatus } from './ai-status.js';
import type { CompiledDiagram, PictureKind } from './diagram-compile.js';
import { clip } from './diagram-sanitize.js';
import { DIAGRAM_KINDS, DIAGRAM_KIND_LABELS } from './diagram-spec.js';
import {
  documentTitle,
  idsIn,
  locatePassage,
  planInsertions,
  segmentPassages,
  type Passage,
  type PendingInsertion,
} from './illustrate-passages.js';
import {
  drawDiagram,
  findIdeas,
  realizeDiagram,
  specSummaryForAvoid,
} from './illustrate-pipeline.js';
import { canDrawIllustrations, realizeIllustration, type PictureOutcome } from './illustration.js';
import { imageProgressText, useImageAccess } from './ai-image-access.js';
import { realizeDesign } from './design-brief.js';
import { saveGeneratedImage } from './insert-generated-image.js';
import {
  AI_DIAGRAM_DESCRIPTION_CHARACTERS,
  inferKind,
  promptBudget,
} from './illustrate-prompts.js';

/** Kinds whose links between boxes cannot be checked against the text. */
const LINKED_KINDS: ReadonlySet<PictureKind> = new Set(['flow', 'sequence', 'hierarchy']);

/** What the person should check that DocBlocks cannot. */
function checkNote(kind: PictureKind): string | null {
  if (LINKED_KINDS.has(kind)) return 'Check the links between boxes before inserting.';
  if (kind === 'matrix') return 'Check that each quadrant is in the right corner before inserting.';
  if (kind === 'illustration') return 'Check the picture against your text before inserting.';
  if (kind === 'design') return 'Check every word in the picture before inserting.';
  return null;
}

/** A design graphic's picture, shown from memory until it is inserted. */
function ImagePreview({ compiled }: { compiled: CompiledDiagram }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!compiled.image) return;
    const next = URL.createObjectURL(new Blob([compiled.image.data], { type: 'image/png' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [compiled]);
  return (
    <div
      className="db-ai-diagram-preview db-ai-design-preview"
      role="img"
      aria-label={`${compiled.title}. ${compiled.summary}`}
    >
      {url && <img src={url} alt="" />}
    </div>
  );
}

function contextWindowOf(status: ReturnType<typeof useAiStatus>): number | null {
  return status?.kind === 'ready' ? (status.model?.contextWindow ?? null) : null;
}

/** The diagram as the document will show it, labelled with its text alternative. */
export function DiagramPreview({ compiled }: { compiled: CompiledDiagram }) {
  const preview = usePreviewSettingsOptional();
  const markdown = useMemo(() => compiled.render(2, new Set()), [compiled]);
  if (compiled.image) return <ImagePreview compiled={compiled} />;
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
  return <pre className="db-ai-diagram-source">{compiled.image?.prompt ?? markdown}</pre>;
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
  const contextWindow = contextWindowOf(status);
  const drawsIllustrations = canDrawIllustrations(contextWindow);
  const material = capturedSelection.text.trim();
  const [description, setDescription] = useState('');
  const [kindChoice, setKindChoice] = useState<'auto' | PictureKind>('auto');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<PictureOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const { knowledge, ai: knowledgeAi, reset: resetKnowledge } = useAiKnowledge(ai);

  useEffect(
    () => () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const autoKind = inferKind(description, material);
  // A model switched to a smaller one in settings can no longer draw.
  const choice = kindChoice === 'illustration' && !drawsIllustrations ? 'auto' : kindChoice;
  const kind: PictureKind = choice === 'auto' ? autoKind : choice;
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
    resetKnowledge();
    const title = request ? clip(request.charAt(0).toUpperCase() + request.slice(1), 60) : '';
    // With selected text, the picture must stick to it. Without, the person
    // asked the model to supply the content.
    const ground = material.length > 0;
    const result =
      kind === 'illustration' && contextWindow !== null
        ? await realizeIllustration({
            ai: knowledgeAi,
            material,
            description: request,
            title,
            avoid,
            ground,
            contextWindow,
            signal: controller.signal,
          })
        : await realizeDiagram({
            ai: knowledgeAi,
            kind: kind === 'illustration' || kind === 'design' ? autoKind : kind,
            material: material || request,
            heading: '',
            title,
            description: request || undefined,
            avoid,
            ground,
            budget: promptBudget(contextWindow),
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
  }, [autoKind, contextWindow, description, kind, knowledgeAi, material, ready, resetKnowledge]);

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
          value={choice}
          onChange={(event) => setKindChoice(event.currentTarget.value as 'auto' | PictureKind)}
        >
          <option value="auto">Auto ({DIAGRAM_KIND_LABELS[autoKind]})</option>
          {DIAGRAM_KINDS.map((option) => (
            <option key={option} value={option}>
              {DIAGRAM_KIND_LABELS[option]}
            </option>
          ))}
          {drawsIllustrations && <option value="illustration">Illustration (drawn by AI)</option>}
        </select>
      </label>
      {choice === 'illustration' && (
        <p className="db-ai-note">
          The model draws this picture itself, as SVG. Describe what it should show; it takes longer
          than a diagram and can need a second try.
        </p>
      )}

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
      {(running || ready) && <AiKnowledgeIndicator knowledge={knowledge} />}
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
          {checkNote(ready.compiled.kind) && (
            <p className="db-ai-note">{checkNote(ready.compiled.kind)}</p>
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
      <p className="db-ai-disclaimer">
        Review AI-generated diagrams before adding them.
        {ready && !running && (
          <>
            {' '}
            <AiReportButton
              feature="Insert diagram"
              getOutput={() => ready.compiled.render(2, new Set())}
              model={status?.kind === 'ready' ? (status.model?.label ?? null) : null}
            />
          </>
        )}
      </p>
    </Dialog>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

// ─── Illustrate panel ──────────────────────────────────────

/** An idea's kind: a picture kind, or Auto, inferred from its prompt and passage. */
type IdeaKind = PictureKind | 'auto';

/**
 * One idea for a picture. Phase one suggests ideas; the person edits them or
 * writes their own; phase two draws each one.
 */
interface Idea {
  readonly key: string;
  /** The passage the picture takes its facts from and goes after. */
  readonly passage: Passage;
  readonly kind: IdeaKind;
  readonly title: string;
  /** What the picture should show. */
  readonly prompt: string;
  /** The person wrote or changed the prompt, so its facts count as stated. */
  readonly personPrompt: boolean;
  /** The person wrote or changed the idea, so finding ideas again keeps it. */
  readonly edited: boolean;
  readonly status: 'idle' | 'queued' | 'drawing';
  readonly picture: DrawnPicture | null;
  readonly inserted: boolean;
  readonly problem: string | null;
}

interface DrawnPicture {
  readonly outcome: Exclude<PictureOutcome, { readonly status: 'cancelled' }>;
  /** The idea's {@link ideaSignature} when drawn, to tell when it changed since. */
  readonly drawnFrom: string;
}

type IdeaEdit = Partial<Pick<Idea, 'passage' | 'kind' | 'title' | 'prompt'>>;

type IllustrateStep = 'ideas' | 'pictures';

function resolvedKind(idea: Pick<Idea, 'kind' | 'prompt' | 'passage'>): PictureKind {
  return idea.kind === 'auto' ? inferKind(idea.prompt, idea.passage.plain) : idea.kind;
}

function kindLabel(kind: PictureKind): string {
  if (kind === 'illustration') return 'Illustration';
  if (kind === 'design') return 'Design graphic';
  return DIAGRAM_KIND_LABELS[kind];
}

/** What a picture is drawn from; where it goes can change without a redraw. */
function ideaSignature(idea: Idea): string {
  return JSON.stringify([resolvedKind(idea), idea.title.trim(), idea.prompt.trim()]);
}

/** The idea's picture, when it is ready and the idea has not changed since. */
function freshPicture(idea: Idea): CompiledDiagram | null {
  const picture = idea.picture;
  return picture?.outcome.status === 'ready' && picture.drawnFrom === ideaSignature(idea)
    ? picture.outcome.compiled
    : null;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function passageLabel(passage: Passage): string {
  const text = clip(passage.plain, 60);
  return passage.heading ? `${clip(passage.heading, 28)}: ${text}` : text;
}

/** Where a new idea starts: the selected passage, else the first without an idea. */
function defaultPassage(
  anchors: readonly Passage[],
  ideas: readonly Idea[],
  selection: EditorSelectionInfo | null,
): Passage | null {
  const selected = selection?.text.replace(/\s+/gu, ' ').trim().slice(0, 80) ?? '';
  const holding = selected ? anchors.find((anchor) => anchor.plain.includes(selected)) : undefined;
  return (
    holding ??
    anchors.find((anchor) => !ideas.some((idea) => idea.passage.text === anchor.text)) ??
    anchors[0] ??
    null
  );
}

interface IdeaCardProps {
  idea: Idea;
  index: number;
  anchors: readonly Passage[];
  placed: { readonly start: number } | null;
  drawsIllustrations: boolean;
  /** A design model is ready, so the Design graphic kind is offered. */
  drawsDesign: boolean;
  promptRef: (element: HTMLTextAreaElement | null) => void;
  onEdit: (change: IdeaEdit) => void;
  onRemove: () => void;
}

/** Phase one: an idea the person can change before it is drawn. */
function IdeaCard({
  idea,
  index,
  anchors,
  placed,
  drawsIllustrations,
  drawsDesign,
  promptRef,
  onEdit,
  onRemove,
}: IdeaCardProps) {
  const anchor = placed ? anchors.find((passage) => passage.start === placed.start) : undefined;
  const locked = idea.inserted || idea.status === 'drawing';
  const outcome = idea.picture?.outcome;
  const state = idea.inserted
    ? 'Inserted'
    : idea.status === 'drawing'
      ? 'Drawing…'
      : idea.status === 'queued'
        ? 'Waiting to draw'
        : freshPicture(idea)
          ? 'Drawn'
          : outcome?.status === 'ready'
            ? 'Changed since drawn'
            : outcome?.status === 'failed'
              ? 'Could not draw'
              : null;
  return (
    <li className="db-ai-review-finding db-ai-idea-card" aria-label={`Idea ${String(index + 1)}`}>
      <div className="db-ai-review-finding-meta">
        <span className="db-ai-review-severity db-ai-illustrate-kind">Idea {index + 1}</span>
        <span>{idea.edited ? 'Yours' : 'Suggested'}</span>
        {state && <span className="db-ai-idea-state">{state}</span>}
      </div>
      <label className="db-ai-field">
        <span>What should it show?</span>
        <textarea
          ref={promptRef}
          rows={3}
          value={idea.prompt}
          maxLength={AI_DIAGRAM_DESCRIPTION_CHARACTERS}
          disabled={locked}
          placeholder="For example: The four release steps, from draft to announcement."
          onChange={(event) => onEdit({ prompt: event.currentTarget.value })}
        />
      </label>
      <div className="db-ai-idea-row">
        <label className="db-ai-field">
          <span>Kind</span>
          <select
            value={idea.kind}
            disabled={locked}
            onChange={(event) => onEdit({ kind: event.currentTarget.value as IdeaKind })}
          >
            <option value="auto">
              Auto ({kindLabel(inferKind(idea.prompt, idea.passage.plain))})
            </option>
            {DIAGRAM_KINDS.map((option) => (
              <option key={option} value={option}>
                {DIAGRAM_KIND_LABELS[option]}
              </option>
            ))}
            {(drawsIllustrations || idea.kind === 'illustration') && (
              <option value="illustration">Illustration (drawn by AI)</option>
            )}
            {(drawsDesign || idea.kind === 'design') && (
              <option value="design">Design graphic (image model)</option>
            )}
          </select>
        </label>
        <label className="db-ai-field">
          <span>Title</span>
          <input
            type="text"
            value={idea.title}
            maxLength={60}
            disabled={locked}
            placeholder="Optional"
            onChange={(event) => onEdit({ title: event.currentTarget.value })}
          />
        </label>
      </div>
      <label className="db-ai-field">
        <span>Goes after</span>
        <select
          value={anchor ? String(anchor.start) : ''}
          disabled={locked}
          onChange={(event) => {
            const value = event.currentTarget.value;
            const next = anchors.find((passage) => String(passage.start) === value);
            if (next) onEdit({ passage: next });
          }}
        >
          {!anchor && (
            <option value="" disabled>
              Choose a passage
            </option>
          )}
          {anchors.map((passage) => (
            <option key={passage.start} value={String(passage.start)}>
              {passageLabel(passage)}
            </option>
          ))}
        </select>
      </label>
      {!anchor && !idea.inserted && (
        <p className="db-ai-error" role="alert">
          This passage changed. Choose where the picture goes.
        </p>
      )}
      {idea.problem && (
        <p className="db-ai-error" role="alert">
          {idea.problem}
        </p>
      )}
      {!idea.inserted && (
        <div className="db-ai-idea-actions">
          <button type="button" disabled={idea.status === 'drawing'} onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

interface PictureCardProps {
  idea: Idea;
  placed: boolean;
  busy: boolean;
  sourceOpen: boolean;
  onToggleSource: () => void;
  onRemove: () => void;
  onEditIdea: () => void;
  onDraw: () => void;
  onInsert: () => void;
}

/** Phase two: an idea's picture, to check and insert. */
function PictureCard({
  idea,
  placed,
  busy,
  sourceOpen,
  onToggleSource,
  onRemove,
  onEditIdea,
  onDraw,
  onInsert,
}: PictureCardProps) {
  const kind = resolvedKind(idea);
  const compiled = freshPicture(idea);
  const outcome = idea.picture?.outcome ?? null;
  const prompt = idea.prompt.trim();
  return (
    <li className="db-ai-review-finding db-ai-illustrate-card">
      <div className="db-ai-review-finding-meta">
        <span className="db-ai-review-severity db-ai-illustrate-kind">{kindLabel(kind)}</span>
        {idea.passage.heading && <span>{clip(idea.passage.heading, 48)}</span>}
      </div>
      <h3>{compiled?.title || idea.title.trim() || kindLabel(kind)}</h3>
      {prompt && <p>{prompt}</p>}
      <div className="db-ai-review-excerpt">
        <span>After</span>
        <blockquote>{clip(idea.passage.plain, 180)}</blockquote>
      </div>

      {idea.status === 'queued' && <p className="db-ai-note">Waiting…</p>}
      {idea.status === 'drawing' && (
        <p className="db-ai-progress" role="status">
          <span className="db-ai-spinner" aria-hidden="true" /> Drawing…
        </p>
      )}
      {idea.inserted && <p className="db-ai-note">Inserted.</p>}
      {idea.status === 'idle' && !idea.inserted && (
        <>
          {!outcome && <p className="db-ai-note">Not drawn yet.</p>}
          {outcome?.status === 'ready' && (
            <>
              <DiagramPreview compiled={outcome.compiled} />
              {compiled ? (
                <>
                  {outcome.notes.map((note) => (
                    <p key={note} className="db-ai-note">
                      {note}
                    </p>
                  ))}
                  {placementNote(compiled) && (
                    <p className="db-ai-note">{placementNote(compiled)}</p>
                  )}
                  {checkNote(compiled.kind) && (
                    <p className="db-ai-note">{checkNote(compiled.kind)}</p>
                  )}
                </>
              ) : (
                <p className="db-ai-note">
                  You changed this idea after it was drawn. Redraw it to use your changes.
                </p>
              )}
              {sourceOpen && <DiagramSource compiled={outcome.compiled} />}
            </>
          )}
          {outcome?.status === 'failed' && (
            <p className="db-ai-error" role="alert">
              {outcome.message}
            </p>
          )}
        </>
      )}
      {!placed && !idea.inserted && (
        <p className="db-ai-error" role="alert">
          This passage changed. Edit the idea to choose where the picture goes.
        </p>
      )}
      {idea.problem && placed && (
        <p className="db-ai-error" role="alert">
          {idea.problem}
        </p>
      )}

      {!idea.inserted && idea.status === 'idle' && (
        <div className="db-ai-review-finding-actions db-ai-illustrate-actions">
          <button type="button" onClick={onRemove}>
            Remove
          </button>
          {outcome?.status === 'ready' && (
            <button type="button" aria-expanded={sourceOpen} onClick={onToggleSource}>
              {sourceOpen ? 'Hide source' : 'Source'}
            </button>
          )}
          <button type="button" onClick={onEditIdea}>
            Edit idea
          </button>
          <button type="button" disabled={busy || !placed} onClick={onDraw}>
            {outcome ? 'Redraw' : 'Draw'}
          </button>
          {compiled && (
            <button type="button" disabled={busy || !placed} onClick={onInsert}>
              Insert
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export interface AiIllustratePanelProps {
  ai: DocBlocksHostAiAPI;
  onClose: () => void;
}

/**
 * Illustrate document, in two steps. Ideas: the model suggests where a
 * picture would help and what each should show, and the person edits those
 * ideas or adds their own. Pictures: each idea is drawn, checked, and
 * inserted. Nothing is drawn until the person asks.
 */
export function AiIllustratePanel({ ai, onClose }: AiIllustratePanelProps) {
  const { markdownSource, applySourceEdits, getSelection, mediaProvider, bumpMediaRevision } =
    useEditorContext();
  const status = useAiStatus(ai);
  const contextWindow = contextWindowOf(status);
  const drawsIllustrations = canDrawIllustrations(contextWindow);
  const images = ai.images;
  const imageAccess = useImageAccess(images);
  // The model for design graphics: undefined while finding out, null when
  // none is ready. Ideas are found once this is known, so the plan can
  // offer design graphics.
  const [designModel, setDesignModel] = useState<string | null | undefined>(
    images ? undefined : null,
  );
  const drawsDesign = typeof designModel === 'string';
  const [designProgress, setDesignProgress] = useState<string | null>(null);
  const sourceRef = useRef(markdownSource);
  sourceRef.current = markdownSource;
  const ready = status?.kind === 'ready' && status.model !== null;
  const [chosenStep, setStep] = useState<IllustrateStep>('ideas');
  const [ideas, setIdeas] = useState<readonly Idea[]>([]);
  const [finding, setFinding] = useState(false);
  const [searched, setSearched] = useState(false);
  /** Said when a search adds no ideas. */
  const [findNote, setFindNote] = useState<string | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  // With every idea removed there are no pictures to show.
  const step: IllustrateStep = ideas.length === 0 ? 'ideas' : chosenStep;
  const [drawProgress, setDrawProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // The draw loop reads ideas through this ref, so edits to queued ideas count.
  const ideasRef = useRef<readonly Idea[]>(ideas);
  const findRef = useRef<AbortController | null>(null);
  const drawRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const nextKeyRef = useRef(0);
  const startedRef = useRef(false);
  const promptRefs = useRef(new Map<string, HTMLTextAreaElement>());
  // Finding ideas reads the whole document; each picture reads one passage.
  const { knowledge: findKnowledge, ai: findAi, reset: resetFindKnowledge } = useAiKnowledge(ai);
  const { knowledge: drawKnowledge, ai: drawAi } = useAiKnowledge(ai);

  useEffect(() => {
    ideasRef.current = ideas;
  }, [ideas]);

  useEffect(() => {
    if (!images) return;
    // An image provider that never answers must not hold back finding ideas.
    const timer = setTimeout(() => setDesignModel((current) => current ?? null), 3_000);
    if (imageAccess === null) return () => clearTimeout(timer);
    clearTimeout(timer);
    if (imageAccess.kind !== 'ready') {
      setDesignModel(null);
      return;
    }
    let live = true;
    void Promise.all([images.getPreferences(), images.models()])
      .then(([preferences, models]) => {
        if (!live) return;
        const id = preferences.designModel;
        const usable =
          models.ok &&
          models.value.some(
            (model) => model.id === id && model.state === 'installed' && model.rendersText,
          );
        setDesignModel(usable ? id : null);
      })
      .catch(() => {
        if (live) setDesignModel(null);
      });
    return () => {
      live = false;
    };
  }, [images, imageAccess]);

  const anchors = useMemo(
    () => segmentPassages(markdownSource, { everyBlock: true }),
    [markdownSource],
  );
  const placements = useMemo(
    () => new Map(ideas.map((idea) => [idea.key, locatePassage(markdownSource, idea.passage)])),
    [ideas, markdownSource],
  );

  const update = useCallback((key: string, change: (current: Idea) => Idea) => {
    setIdeas((current) => current.map((idea) => (idea.key === key ? change(idea) : idea)));
  }, []);

  const newKey = useCallback(() => `idea-${String(++nextKeyRef.current)}`, []);

  const find = useCallback(async () => {
    if (findRef.current || drawRef.current) return;
    const controller = new AbortController();
    findRef.current = controller;
    const generation = generationRef.current;
    setFinding(true);
    setFindError(null);
    setFindNote(null);
    resetFindKnowledge();
    const outcome = await findIdeas({
      ai: findAi,
      source: markdownSource,
      title: documentTitle(markdownSource),
      budget: promptBudget(contextWindow),
      design: drawsDesign,
      signal: controller.signal,
    });
    if (generationRef.current !== generation) return;
    findRef.current = null;
    setFinding(false);
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'failed') {
      setFindError(outcome.message);
      return;
    }
    // Keep what the person wrote, changed, drew or inserted; replace the rest.
    const kept = ideasRef.current.filter(
      (idea) => idea.edited || idea.picture !== null || idea.inserted || idea.status !== 'idle',
    );
    const found = outcome.picks
      .filter((pick) => !kept.some((idea) => idea.passage.text === pick.passage.text))
      .map(
        (pick): Idea => ({
          key: newKey(),
          passage: pick.passage,
          kind: pick.kind,
          title: pick.title,
          prompt: pick.prompt,
          personPrompt: false,
          edited: false,
          status: 'idle',
          picture: null,
          inserted: false,
          problem: null,
        }),
      );
    setSearched(true);
    if (found.length === 0) {
      setFindNote(
        kept.length === 0
          ? 'No passage here stood out as needing a picture. Add your own idea.'
          : 'No other passage stood out as needing a picture.',
      );
    }
    setIdeas((current) => {
      const keep = new Set(kept.map((idea) => idea.key));
      return [...current.filter((idea) => keep.has(idea.key)), ...found].sort(
        (a, b) => a.passage.start - b.passage.start,
      );
    });
  }, [findAi, resetFindKnowledge, contextWindow, markdownSource, newKey, drawsDesign]);

  const drawOne = useCallback(
    (idea: Idea, avoid: string | undefined, signal: AbortSignal): Promise<PictureOutcome> => {
      const kind = resolvedKind(idea);
      const title = idea.title.trim();
      const prompt = idea.prompt.trim();
      if (kind === 'design') {
        if (!images || typeof designModel !== 'string') {
          return Promise.resolve({
            status: 'failed',
            message:
              'Choose a model for design graphics under Settings, AI assistance, to draw this.',
          });
        }
        setDesignProgress(null);
        return realizeDesign({
          ai: drawAi,
          images,
          model: designModel,
          material: idea.passage.plain,
          title,
          prompt,
          personTitle: idea.edited && title.length > 0,
          signal,
          onProgress: (progress) =>
            setDesignProgress(imageProgressText(progress, 'the design model')),
        }).finally(() => setDesignProgress(null));
      }
      if (kind === 'illustration') {
        if (contextWindow === null || !canDrawIllustrations(contextWindow)) {
          return Promise.resolve({
            status: 'failed',
            message: 'This model cannot draw illustrations. Choose a diagram kind instead.',
          });
        }
        return realizeIllustration({
          ai: drawAi,
          material: idea.passage.plain,
          description: prompt,
          title,
          avoid,
          ground: true,
          descriptionFacts: idea.personPrompt,
          contextWindow,
          signal,
        });
      }
      return drawDiagram(
        { passage: idea.passage, kind, title, prompt },
        {
          ai: drawAi,
          budget: promptBudget(contextWindow),
          validateMermaid: validateMermaidSource,
          personPrompt: idea.personPrompt,
          avoid,
          signal,
        },
      );
    },
    [drawAi, contextWindow, images, designModel],
  );

  /** Phase two: draw `keys` one at a time, showing each picture as it lands. */
  const draw = useCallback(
    async (keys: readonly string[]) => {
      if (keys.length === 0 || findRef.current || drawRef.current) return;
      const controller = new AbortController();
      drawRef.current = controller;
      const generation = generationRef.current;
      const queued = new Set(keys);
      setNotice(null);
      setDrawProgress({ done: 0, total: keys.length });
      setIdeas((current) =>
        current.map((idea) =>
          queued.has(idea.key) ? { ...idea, status: 'queued', problem: null } : idea,
        ),
      );
      for (const [index, key] of keys.entries()) {
        if (controller.signal.aborted) break;
        const idea = ideasRef.current.find((entry) => entry.key === key);
        if (!idea || idea.inserted) continue;
        setDrawProgress({ done: index, total: keys.length });
        update(key, (current) => ({ ...current, status: 'drawing' }));
        // A redraw of an unchanged idea should give something different.
        const shown = freshPicture(idea);
        const outcome = await drawOne(
          idea,
          shown ? specSummaryForAvoid(shown) : undefined,
          controller.signal,
        );
        if (generationRef.current !== generation) return;
        if (outcome.status === 'cancelled') break;
        const picture: DrawnPicture = { outcome, drawnFrom: ideaSignature(idea) };
        update(key, (current) => ({ ...current, status: 'idle', picture }));
      }
      if (generationRef.current !== generation) return;
      drawRef.current = null;
      setDrawProgress(null);
      setIdeas((current) =>
        current.map((idea) => (idea.status === 'idle' ? idea : { ...idea, status: 'idle' })),
      );
    },
    [drawOne, update],
  );

  const stop = useCallback(() => {
    findRef.current?.abort();
    drawRef.current?.abort();
  }, []);

  useEffect(() => {
    if (startedRef.current || !ready || designModel === undefined) return;
    startedRef.current = true;
    void find();
  }, [ready, find, designModel]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      findRef.current?.abort();
      drawRef.current?.abort();
      findRef.current = null;
      drawRef.current = null;
      // StrictMode replays mount effects in development; let the replay start.
      startedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!focusKey || step !== 'ideas') return;
    promptRefs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, ideas, step]);

  const addIdea = useCallback(() => {
    const passage = defaultPassage(anchors, ideasRef.current, getSelection());
    if (!passage) return;
    const key = newKey();
    setIdeas((current) => [
      ...current,
      {
        key,
        passage,
        kind: 'auto',
        title: '',
        prompt: '',
        personPrompt: true,
        edited: true,
        status: 'idle',
        picture: null,
        inserted: false,
        problem: null,
      },
    ]);
    setStep('ideas');
    setFocusKey(key);
  }, [anchors, getSelection, newKey]);

  const edit = useCallback(
    (key: string, change: IdeaEdit) =>
      update(key, (idea) => ({
        ...idea,
        ...change,
        edited: true,
        personPrompt: idea.personPrompt || change.prompt !== undefined,
        problem: null,
      })),
    [update],
  );

  const remove = useCallback((key: string) => {
    setIdeas((current) => current.filter((idea) => idea.key !== key));
  }, []);

  const insert = useCallback(
    async (items: readonly Idea[]) => {
      const pending: PendingInsertion[] = [];
      for (const idea of items) {
        const compiled = freshPicture(idea);
        if (idea.inserted || !compiled) continue;
        pending.push({ key: idea.key, passage: idea.passage, compiled });
      }
      if (pending.length === 0) return;
      // A design graphic's Markdown points at its file, so save that first.
      const unsaved = pending.flatMap(({ compiled }) =>
        compiled.image && !compiled.image.mediaPath
          ? [{ image: compiled.image, title: compiled.title }]
          : [],
      );
      if (unsaved.length > 0) {
        if (!mediaProvider) {
          setNotice('Save the document in a folder to insert design graphics.');
          return;
        }
        try {
          for (const { image, title } of unsaved) {
            image.mediaPath = await saveGeneratedImage(mediaProvider, image, title);
          }
          bumpMediaRevision?.();
        } catch {
          setNotice('DocBlocks could not save the design graphic beside the document.');
          return;
        }
      }
      const source = sourceRef.current;
      const plan = planInsertions(source, pending);
      const stale = new Set(plan.stale);
      const unplaceable = new Set(plan.unplaceable);
      if (plan.edits.length > 0 && !applySourceEdits(plan.edits, { baseSource: source })) {
        setNotice('Switch to Write or Source view, in the Document layout, to insert pictures.');
        return;
      }
      setNotice(null);
      setIdeas((current) =>
        current.map((idea) => {
          if (!pending.some((entry) => entry.key === idea.key)) return idea;
          if (stale.has(idea.key)) {
            return {
              ...idea,
              problem: 'This passage changed. Edit the idea to choose where the picture goes.',
            };
          }
          if (unplaceable.has(idea.key)) {
            return {
              ...idea,
              problem:
                'No heading level fits at the end of this section without capturing the text after it.',
            };
          }
          return { ...idea, inserted: true, problem: null };
        }),
      );
    },
    [applySourceEdits, mediaProvider, bumpMediaRevision],
  );

  const drawing = drawProgress !== null;
  const busy = finding || drawing;
  const placed = (idea: Idea) => placements.get(idea.key) != null;
  const toDraw = ideas.filter(
    (idea) => !idea.inserted && freshPicture(idea) === null && placed(idea),
  );
  const insertable = ideas.filter(
    (idea) => !idea.inserted && freshPicture(idea) !== null && placed(idea),
  );
  const drawn = ideas.flatMap((idea) => {
    const compiled = freshPicture(idea);
    return compiled ? [compiled] : [];
  });
  const anyPicture = ideas.some((idea) => idea.picture !== null);

  const drawPictures = (keys: readonly string[]) => {
    setStep('pictures');
    // Design graphics take longest to render, so diagrams land first.
    const isDesign = (key: string) =>
      ideasRef.current.some((idea) => idea.key === key && resolvedKind(idea) === 'design');
    void draw([...keys.filter((key) => !isDesign(key)), ...keys.filter(isDesign)]);
  };

  return (
    <aside className="db-ai-review-panel db-ai-illustrate-panel" aria-label="AI illustrations">
      <div className="db-ai-review-header">
        <div>
          <h2>AI illustrations</h2>
          {ideas.length > 0 && (
            <span className="db-ai-review-count">
              {plural(ideas.length, 'idea')}
              {drawn.length > 0 && ` · ${String(drawn.length)} drawn`}
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

      <nav className="db-ai-illustrate-steps" aria-label="Steps">
        <ol>
          <li>
            <button
              type="button"
              aria-current={step === 'ideas' ? 'step' : undefined}
              onClick={() => setStep('ideas')}
            >
              <span className="db-ai-step-number" aria-hidden="true">
                1
              </span>
              Ideas
            </button>
          </li>
          <li>
            <button
              type="button"
              aria-current={step === 'pictures' ? 'step' : undefined}
              disabled={ideas.length === 0}
              onClick={() => setStep('pictures')}
            >
              <span className="db-ai-step-number" aria-hidden="true">
                2
              </span>
              Pictures
            </button>
          </li>
        </ol>
      </nav>

      {!ready && status && (
        <div className="db-ai-review-empty" role="status">
          {unavailableSentence(status)}
        </div>
      )}

      {step === 'ideas' ? (
        <section aria-label="Ideas">
          <p className="db-ai-illustrate-intro">
            Each idea says where a picture goes and what it should show. Edit the ideas or add your
            own, then draw them.
          </p>
          <div className="db-ai-illustrate-bar">
            {finding ? (
              <>
                <span className="db-ai-illustrate-progress" role="status">
                  <span className="db-ai-spinner" aria-hidden="true" /> Finding ideas…
                </span>
                <button type="button" onClick={stop}>
                  Stop
                </button>
              </>
            ) : (
              <button type="button" disabled={!ready || drawing} onClick={() => void find()}>
                {searched ? 'Find ideas again' : 'Find ideas'}
              </button>
            )}
          </div>
          {(finding || searched) && findKnowledge && (
            <div className="db-ai-review-knowledge">
              <AiKnowledgeIndicator knowledge={findKnowledge} />
            </div>
          )}
          {findError && (
            <div className="db-ai-review-empty db-ai-error" role="alert">
              {findError}
            </div>
          )}
          {!finding && findNote && (
            <div className="db-ai-review-empty" role="status">
              {findNote}
            </div>
          )}
          {ideas.length > 0 && (
            <ol className="db-ai-review-list">
              {ideas.map((idea, index) => (
                <IdeaCard
                  key={idea.key}
                  idea={idea}
                  index={index}
                  anchors={anchors}
                  placed={placements.get(idea.key) ?? null}
                  drawsIllustrations={drawsIllustrations}
                  drawsDesign={drawsDesign}
                  promptRef={(element) => {
                    if (element) promptRefs.current.set(idea.key, element);
                    else promptRefs.current.delete(idea.key);
                  }}
                  onEdit={(change) => edit(idea.key, change)}
                  onRemove={() => remove(idea.key)}
                />
              ))}
            </ol>
          )}
          <div className="db-ai-illustrate-bar">
            <button type="button" disabled={anchors.length === 0} onClick={addIdea}>
              Add idea
            </button>
          </div>
          {anchors.length === 0 && (
            <p className="db-ai-illustrate-intro">
              Write some text first: each picture goes after a paragraph, list or table.
            </p>
          )}
        </section>
      ) : (
        <section aria-label="Pictures">
          <p className="db-ai-illustrate-intro">
            Check each picture against your text, then insert the ones you want. To change a
            picture, edit its idea and redraw it.
          </p>
          {notice && (
            <div className="db-ai-review-stale" role="status">
              {notice}
            </div>
          )}
          {drawKnowledge && (
            <div className="db-ai-review-knowledge">
              <AiKnowledgeIndicator knowledge={drawKnowledge} />
            </div>
          )}
          <ol className="db-ai-review-list">
            {ideas.map((idea) => (
              <PictureCard
                key={idea.key}
                idea={idea}
                placed={placed(idea)}
                busy={busy}
                sourceOpen={sourceOpen.has(idea.key)}
                onToggleSource={() =>
                  setSourceOpen((current) => {
                    const next = new Set(current);
                    if (next.has(idea.key)) next.delete(idea.key);
                    else next.add(idea.key);
                    return next;
                  })
                }
                onRemove={() => remove(idea.key)}
                onEditIdea={() => {
                  setStep('ideas');
                  setFocusKey(idea.key);
                }}
                onDraw={() => void draw([idea.key])}
                onInsert={() => void insert([idea])}
              />
            ))}
          </ol>
        </section>
      )}

      <p className="db-ai-review-disclaimer">
        AI pictures can be wrong. Check each one before inserting it.
        {drawn.length > 0 && !busy && (
          <>
            {' '}
            <AiReportButton
              feature="Illustrate document"
              getOutput={() => drawn.map((compiled) => compiled.render(2, new Set())).join('\n\n')}
              model={status?.kind === 'ready' ? (status.model?.label ?? null) : null}
            />
          </>
        )}
      </p>

      {(drawing || step === 'ideas' || toDraw.length > 0 || insertable.length > 1) && (
        <div className="db-ai-illustrate-footer">
          {drawProgress ? (
            <>
              <div className="db-ai-illustrate-progress" role="status">
                <span className="db-ai-spinner" aria-hidden="true" />
                <span>
                  Drawing picture {Math.min(drawProgress.done + 1, drawProgress.total)} of{' '}
                  {drawProgress.total}…{designProgress ? ` ${designProgress}` : ''}
                </span>
                <progress
                  max={drawProgress.total}
                  value={drawProgress.done}
                  aria-label="Pictures drawn so far"
                />
              </div>
              <button
                type="button"
                title="Stop drawing. Pictures already drawn are kept."
                onClick={stop}
              >
                Stop
              </button>
            </>
          ) : step === 'ideas' ? (
            toDraw.length === 0 && anyPicture ? (
              <button
                type="button"
                className="db-ai-illustrate-primary"
                onClick={() => setStep('pictures')}
              >
                Show pictures
              </button>
            ) : (
              <button
                type="button"
                className="db-ai-illustrate-primary"
                disabled={!ready || finding || toDraw.length === 0}
                onClick={() => drawPictures(toDraw.map((idea) => idea.key))}
              >
                {toDraw.length === 0 ? 'Draw pictures' : `Draw ${plural(toDraw.length, 'picture')}`}
              </button>
            )
          ) : (
            <>
              {toDraw.length > 0 && (
                <button
                  type="button"
                  disabled={!ready || finding}
                  onClick={() => drawPictures(toDraw.map((idea) => idea.key))}
                >
                  Draw {plural(toDraw.length, 'picture')}
                </button>
              )}
              {insertable.length > 1 && (
                <button
                  type="button"
                  className="db-ai-illustrate-primary"
                  onClick={() => void insert(insertable)}
                >
                  Insert all ({insertable.length})
                </button>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
