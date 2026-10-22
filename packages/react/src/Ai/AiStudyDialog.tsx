/**
 * Summarize document, Create quiz, and Create flashcards.
 *
 * One dialog for all three. It opens on a start screen that offers the
 * study aid saved with this document, when there is one, beside a button to
 * generate a new one; a finished study aid is saved to the document's
 * sidecar folder before it is shown, so the viewer always shows what will
 * be there next time. See `study-pipeline.ts` for the model calls and
 * `study-aids.ts` for where and how the result is saved.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePreviewSettingsOptional } from '@bendyline/squisq-editor-react';
import { FlashcardView } from '@bendyline/squisq-react';
import { LinearDocView } from '@bendyline/squisq-react/page';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { AiChatEvent, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

import { Dialog } from '../components/Dialog.js';
import { AiGenerationStatus, type AiGenerationState } from './AiGenerationStatus.js';
import { AiKnowledgeIndicator } from './AiKnowledgeIndicator.js';
import { useAiKnowledge } from './ai-knowledge.js';
import { AiReportButton } from './AiOutputReport.js';
import { unavailableSentence, useAiStatus } from './ai-status.js';
import {
  STUDY_AID_LABELS,
  readStudyAid,
  readStudyAidProvenance,
  studyAidBody,
  studyAidIsStale,
  writeStudyAid,
  type SavedStudyAid,
  type StudyAidKind,
  type StudyAidProvenance,
} from './study-aids.js';
import { generateStudyAid, type StudyStage } from './study-pipeline.js';
import { chunkStudySections, segmentStudySections, studyBudget } from './study-sections.js';

export interface AiStudyDialogProps {
  ai: DocBlocksHostAiAPI;
  kind: StudyAidKind;
  documentSource: string;
  /** The document's file name, recorded in the saved study aid. */
  documentName: string;
  /** The document's sidecar folder, where study aids are saved. */
  container: ContentContainer;
  onClose: () => void;
}

type SavedState =
  | { readonly status: 'loading' }
  | { readonly status: 'none' }
  | { readonly status: 'found'; readonly aid: SavedStudyAid }
  | { readonly status: 'error'; readonly message: string };

const INTRO: Readonly<Record<StudyAidKind, string>> = {
  summary: 'Write a short summary of this document: an overview, then its key points.',
  quiz: 'Write a multiple-choice quiz that checks understanding of this document.',
  flashcards:
    'Write a deck of flashcards for studying the terms, facts and ideas in this document.',
};

function stageLabel(kind: StudyAidKind, stage: StudyStage | null): string {
  if (!stage) return 'Starting…';
  switch (stage.kind) {
    case 'notes':
      return `Reading part ${String(stage.part)} of ${String(stage.parts)}…`;
    case 'condensing':
      return 'Condensing notes…';
    case 'writing':
      return 'Writing the summary…';
    case 'items':
      // Counts what was asked for, never the calls it takes to ask.
      return (
        `Writing ${String(stage.planned)} ${kind === 'quiz' ? 'questions' : 'flashcards'}…` +
        (stage.written > 0 ? ` ${String(stage.written)} so far.` : '')
      );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** "Generated Oct 12, 2026, 3:04 PM with Llama 3.2" */
function describeProvenance(provenance: StudyAidProvenance | null): string {
  if (!provenance) return 'Saved earlier.';
  const date = new Date(provenance.generatedAt);
  const when = Number.isNaN(date.getTime())
    ? provenance.generatedAt
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `Generated ${when}${provenance.model ? ` with ${provenance.model}` : ''}.`;
}

const STALE_NOTE = 'The document has changed since this was generated.';

/** The study aid as a reader sees it: a page for a summary, a study deck otherwise. */
function StudyAidViewer({ kind, markdown }: { kind: StudyAidKind; markdown: string }) {
  const theme = usePreviewSettingsOptional()?.activeTheme;
  const body = useMemo(() => studyAidBody(markdown), [markdown]);
  const doc = useMemo(() => {
    if (kind === 'summary') return null;
    try {
      return markdownToDoc(parseMarkdown(markdown));
    } catch {
      return null;
    }
  }, [kind, markdown]);
  if (kind === 'summary') {
    return (
      <div className="db-ai-study-summary">
        {/* Page margins, unlike a diagram preview: this is prose to read. */}
        <LinearDocView markdown={body} showCover={false} theme={theme} />
      </div>
    );
  }
  if (!doc) {
    return <p className="db-ai-error">This file could not be read as a study deck.</p>;
  }
  return (
    <div className="db-ai-study-deck">
      <FlashcardView doc={doc} source="explicit" theme={theme} density="compact" />
    </div>
  );
}

export function AiStudyDialog({
  ai,
  kind,
  documentSource,
  documentName,
  container,
  onClose,
}: AiStudyDialogProps) {
  const labels = STUDY_AID_LABELS[kind];
  const status = useAiStatus(ai);
  const model = status?.kind === 'ready' ? status.model : null;
  const ready = model !== null;
  const contextWindow = model?.contextWindow ?? null;
  const budget = useMemo(() => studyBudget(contextWindow), [contextWindow]);
  const parts = useMemo(
    () => chunkStudySections(segmentStudySections(documentSource), budget).chunks.length,
    [documentSource, budget],
  );

  const [saved, setSaved] = useState<SavedState>({ status: 'loading' });
  /** The study aid in the viewer; null on the start screen. */
  const [shown, setShown] = useState<SavedStudyAid | null>(null);
  const [stale, setStale] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<StudyStage | null>(null);
  const [generation, setGeneration] = useState<AiGenerationState | null>(null);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    let live = true;
    readStudyAid(container, kind).then(
      (aid) => {
        if (live) setSaved(aid ? { status: 'found', aid } : { status: 'none' });
      },
      (cause: unknown) => {
        if (live) setSaved({ status: 'error', message: messageOf(cause) });
      },
    );
    return () => {
      live = false;
    };
  }, [container, kind]);

  // The study aid on screen: the one in the viewer, else the saved one offered.
  const subject = shown ?? (saved.status === 'found' ? saved.aid : null);
  useEffect(() => {
    let live = true;
    setStale(null);
    if (!subject) return;
    studyAidIsStale(subject.provenance, documentSource).then(
      (value) => {
        if (live) setStale(value);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [subject, documentSource]);

  const onEvent = useCallback((requestId: number, event: AiChatEvent) => {
    if (requestRef.current !== requestId) return;
    if (event.kind === 'progress') {
      setGeneration(
        (current) =>
          current && { ...current, progress: event.progress, lastActivityAt: Date.now() },
      );
    } else if (event.kind === 'delta') {
      setGeneration(
        (current) =>
          current && {
            ...current,
            lastActivityAt: Date.now(),
            progress: {
              phase: 'generating',
              percent: null,
              outputTokens: current.progress?.outputTokens ?? null,
              tokensPerSecond: current.progress?.tokensPerSecond ?? null,
            },
          },
      );
    }
  }, []);

  const generate = useCallback(async () => {
    if (running || !ready) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestRef.current;
    const startedAt = Date.now();
    setRunning(true);
    setStage(null);
    setError(null);
    setNotes([]);
    setShowSource(false);
    setGeneration({ progress: null, startedAt, lastActivityAt: startedAt });
    resetKnowledge();
    const outcome = await generateStudyAid({
      ai: knowledgeAi,
      kind,
      source: documentSource,
      sourceName: documentName,
      model,
      budget,
      signal: controller.signal,
      onStage: (next) => {
        if (requestRef.current === requestId) setStage(next);
      },
      onEvent: (event) => onEvent(requestId, event),
    });
    if (requestRef.current !== requestId) return;
    if (outcome.status !== 'ready') {
      setRunning(false);
      if (outcome.status === 'failed') setError(outcome.message);
      return;
    }
    // Saved before it is shown. A save that fails still shows the result,
    // with the reason, rather than throwing away the model's work.
    let saveError: string | null = null;
    try {
      await writeStudyAid(container, kind, outcome.markdown);
    } catch (cause: unknown) {
      saveError = messageOf(cause);
    }
    if (requestRef.current !== requestId) return;
    const aid: SavedStudyAid = {
      markdown: outcome.markdown,
      provenance: readStudyAidProvenance(outcome.markdown),
    };
    setRunning(false);
    setShown(aid);
    setNotes(outcome.notes);
    if (saveError === null) setSaved({ status: 'found', aid });
    else setError(`The ${labels.noun} could not be saved: ${saveError}`);
  }, [
    knowledgeAi,
    budget,
    container,
    documentName,
    documentSource,
    kind,
    labels,
    model,
    onEvent,
    ready,
    resetKnowledge,
    running,
  ]);

  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const savedAid = saved.status === 'found' ? saved.aid : null;
  const hasStudyAid = Boolean(shown ?? savedAid);

  const startScreen = (
    <div className="db-ai-study-start">
      <p className="db-ai-study-intro">{INTRO[kind]}</p>
      <p className="db-ai-note">It is saved with this document, so you can open it again later.</p>
      {saved.status === 'loading' && (
        <p className="db-ai-note" role="status">
          Looking for a saved {labels.noun}…
        </p>
      )}
      {savedAid && (
        <div className="db-ai-study-saved">
          <div className="db-ai-study-saved-text">
            <p className="db-ai-study-saved-title">Saved {labels.noun}</p>
            <p className="db-ai-note">{describeProvenance(savedAid.provenance)}</p>
            {stale && <p className="db-ai-study-stale">{STALE_NOTE}</p>}
          </div>
          <button
            type="button"
            onClick={() => {
              setShown(savedAid);
              setNotes([]);
              setError(null);
            }}
          >
            View {labels.noun}
          </button>
        </div>
      )}
      {saved.status === 'error' && (
        <p className="db-ai-error" role="alert">
          The saved {labels.noun} could not be read. {saved.message}
        </p>
      )}
      {parts > 1 && (
        <p className="db-ai-note">
          This document is long for the selected model, so it is read in {parts} parts. That takes
          longer.
        </p>
      )}
      {status && !ready && <p className="db-ai-note">{unavailableSentence(status)}</p>}
    </div>
  );

  const viewer = shown && (
    <div className="db-ai-study-result">
      <StudyAidViewer kind={kind} markdown={shown.markdown} />
      {notes.map((note) => (
        <p key={note} className="db-ai-note">
          {note}
        </p>
      ))}
      <AiKnowledgeIndicator knowledge={knowledge} />
      {/* One line under the viewer, so the deck keeps the height. */}
      <div className="db-ai-study-meta">
        <p className="db-ai-disclaimer">
          {describeProvenance(shown.provenance)}
          {stale && <span className="db-ai-study-stale"> {STALE_NOTE}</span>} Check AI-generated{' '}
          {labels.noun} against your document.
        </p>
        <button
          type="button"
          className="db-ai-link-button"
          aria-expanded={showSource}
          onClick={() => setShowSource((open) => !open)}
        >
          {showSource ? 'Hide source' : 'Show source'}
        </button>
        <AiReportButton
          feature={labels.feature}
          getOutput={() => shown.markdown}
          // A saved study aid may come from a model other than today's.
          model={shown.provenance?.model ?? model?.label ?? null}
        />
      </div>
      {showSource && <pre className="db-ai-diagram-source">{shown.markdown}</pre>}
    </div>
  );

  const progress = running && (
    <div className="db-ai-study-running">
      <p className="db-ai-study-stage" aria-live="polite">
        {stageLabel(kind, stage)}
      </p>
      {generation && <AiGenerationStatus state={generation} characters={0} />}
      <AiKnowledgeIndicator knowledge={knowledge} />
    </div>
  );

  const dialog = (
    <Dialog
      title={labels.dialogTitle}
      onClose={onClose}
      // A deck needs the room; the start screen and progress do not.
      size={kind !== 'summary' && shown && !running ? 'full' : 'wide'}
      closeOnBackdrop={!running}
      initialFocusRef={primaryRef as RefObject<HTMLElement | null>}
      className={`db-ai-study-dialog db-ai-study-dialog--${kind}`}
      bodyClassName="db-ai-study-body"
      footerClassName="db-ai-study-footer"
      footer={
        <>
          {error && (
            <div className="db-ai-footer-status">
              <p className="db-ai-error" role="alert">
                {error}
              </p>
            </div>
          )}
          <div className="db-ai-draft-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
            {running ? (
              <button type="button" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                ref={primaryRef}
                type="button"
                disabled={!ready}
                onClick={() => void generate()}
              >
                {hasStudyAid ? 'Regenerate' : 'Generate'} {labels.noun}
              </button>
            )}
          </div>
        </>
      }
    >
      {progress || viewer || startScreen}
    </Dialog>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
