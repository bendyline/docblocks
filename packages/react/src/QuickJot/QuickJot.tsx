/**
 * Quick Jot — a small box at the bottom of the left pane, under the files and
 * above the footer, for getting something down without leaving the document
 * you are in. It grows upward as lines are added. Type, paste, dictate or drop
 * files in, then make it a document, a task, or a line in today's journal.
 *
 * A plain text area on purpose: it loads nothing heavy at startup and works
 * the same on every surface. Pictures and files wait as chips under it until
 * the jot is used, and are then kept beside whatever it became.
 */

import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import { parseCapture, type LocalDate } from '@bendyline/docblocks/properties';
import type { SpeechInputProvider } from '@bendyline/squisq-editor-react/speech';
import { dueLabel } from '../Tasks/task-model.js';
import {
  contentFromDataTransfer,
  markdownForFieldPaste,
  readClipboardWithImages,
  type PastedContent,
} from '../DocBlocksShell/pasted-document.js';
import { isApplePlatform } from '../DocBlocksShell/keyboard-shortcuts.js';
import {
  AttachmentIcon,
  CloseIcon,
  JournalIcon,
  NewFileIcon,
  NewFromClipboardIcon,
  TasksIcon,
} from '../icons.js';
import type { QuickJotActions } from './quick-jot-actions.js';
import {
  dragCarriesFiles,
  spliceText,
  splitJotTask,
  withAttachments,
  withDictatedPhrase,
  type JotAttachment,
  type JotDraft,
  type JotOutcome,
} from './quick-jot-model.js';

const QuickJotDictation = lazy(() => import('./QuickJotDictation.js'));

/** Where dictation comes from, when the host offers it. */
export interface QuickJotDictationSource {
  readonly provider: SpeechInputProvider;
  readonly speech: DocBlocksHostSpeechAPI;
  readonly onOpenSettings: () => void;
}

export interface QuickJotProps {
  readonly actions: QuickJotActions;
  readonly today: LocalDate;
  readonly dictation?: QuickJotDictationSource | null;
  /** Told as dictation into the box starts and stops, so nothing else records meanwhile. */
  readonly onDictatingChange?: (active: boolean) => void;
}

/** What the text's own plain paste cannot keep: structured HTML, as Markdown. */
async function pastedText(content: PastedContent): Promise<string> {
  const conversion = markdownForFieldPaste(content);
  if (!conversion) return content.text;
  return (await conversion.catch(() => null)) ?? content.text;
}

/**
 * The make buttons say what they make ("Doc", "Task", "Journal") when the
 * toolbar's one row has room for that, and fall back to icons when it does
 * not. Tried and measured on the element itself (React never renders the
 * attribute), so a re-fit costs one layout and no render. The groups are
 * summed rather than the toolbar's scrollWidth read, because the buttons'
 * touch-sized hit areas always reach past its edges.
 */
function fitToolbarLabels(toolbar: HTMLElement): void {
  toolbar.removeAttribute('data-labels');
  const groups = Array.from(toolbar.children);
  const gap = Number.parseFloat(getComputedStyle(toolbar).columnGap) || 0;
  const needed =
    groups.reduce((sum, group) => sum + group.getBoundingClientRect().width, 0) +
    gap * Math.max(0, groups.length - 1);
  if (needed > toolbar.clientWidth + 0.5) toolbar.setAttribute('data-labels', 'off');
}

function AttachmentPreview({ attachment }: { attachment: JotAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (attachment.kind !== 'image') return undefined;
    const objectUrl = URL.createObjectURL(attachment.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [attachment]);
  return url ? (
    <img className="db-quick-jot-thumb" src={url} alt="" />
  ) : (
    <span className="db-quick-jot-thumb" aria-hidden="true">
      <AttachmentIcon />
    </span>
  );
}

export function QuickJot({ actions, today, dictation, onDictatingChange }: QuickJotProps) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const makeGroup = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const pendingOverlay = useRef<HTMLDivElement>(null);
  const [text, setTextState] = useState('');
  const textRef = useRef('');
  const [attachments, setAttachmentsState] = useState<readonly JotAttachment[]>([]);
  const attachmentsRef = useRef<readonly JotAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [converting, setConverting] = useState(false);
  /** A scrollbar's width, so the "still converting" dots wrap with the text. */
  const [gutter, setGutter] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Nested children fire dragleave as the pointer crosses them.
  const dragDepth = useRef(0);
  const pendingCaret = useRef<number | null>(null);
  const latestDictatingChange = useRef(onDictatingChange);
  latestDictatingChange.current = onDictatingChange;

  const setText = (value: string) => {
    textRef.current = value;
    setTextState(value);
  };
  const setAttachments = (value: readonly JotAttachment[]) => {
    attachmentsRef.current = value;
    setAttachmentsState(value);
  };

  // The box grows with its text up to the CSS max-height, then scrolls.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    const borders = element.offsetHeight - element.clientHeight;
    if (element.scrollHeight > 0) element.style.height = `${element.scrollHeight + borders}px`;
    if (pendingCaret.current !== null && document.activeElement === element) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
    if (dictating) element.scrollTop = element.scrollHeight;
    if (converting) {
      setGutter(element.offsetWidth - element.clientWidth - 2 * element.clientLeft);
      if (pendingOverlay.current) pendingOverlay.current.scrollTop = element.scrollTop;
    }
  }, [text, dictating, converting]);

  // Recording stops with the box; whoever was told it started must hear it stopped.
  useEffect(() => () => latestDictatingChange.current?.(false), []);

  const hint = useMemo(() => {
    if (!actions.toTask) return null;
    const { title } = splitJotTask(text);
    if (!title) return null;
    const capture = parseCapture(title, today);
    return capture.due ? `As a task: due ${dueLabel(capture.due, today).text.toLowerCase()}` : null;
  }, [actions.toTask, text, today]);

  const insertText = (inserted: string, range?: readonly [number, number]) => {
    const element = field.current;
    const start = range?.[0] ?? element?.selectionStart ?? textRef.current.length;
    const end = range?.[1] ?? element?.selectionEnd ?? start;
    const next = spliceText(textRef.current, start, end, inserted);
    pendingCaret.current = next.caret;
    setText(next.text);
  };

  const addFiles = (files: readonly File[]) => {
    if (files.length === 0) return;
    const next = withAttachments(attachmentsRef.current, files);
    setAttachments(next.attachments);
    setNotice(next.refused);
  };

  const selection = (): readonly [number, number] => {
    const element = field.current;
    const end = textRef.current.length;
    return [element?.selectionStart ?? end, element?.selectionEnd ?? end];
  };

  const pasteFromClipboard = async () => {
    setNotice(null);
    const range = selection();
    const read = await readClipboardWithImages();
    if (read.kind === 'unavailable') {
      field.current?.focus();
      const hasKeyboard = globalThis.matchMedia?.('(any-pointer: fine)').matches ?? true;
      setNotice(
        hasKeyboard
          ? `DocBlocks can’t read the clipboard here. Press ${isApplePlatform() ? '⌘V' : 'Ctrl+V'} to paste.`
          : 'DocBlocks can’t read the clipboard here. Paste into the box instead.',
      );
      return;
    }
    if (read.kind === 'empty') {
      setNotice('The clipboard is empty.');
      return;
    }
    addFiles(read.images);
    if (read.content) insertText(await pastedText(read.content), range);
    field.current?.focus();
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    const files = Array.from(data?.files ?? []);
    if (files.length > 0) {
      // A copied picture often comes with HTML for it too; the picture is what was meant.
      event.preventDefault();
      addFiles(files);
      return;
    }
    const content = contentFromDataTransfer(data);
    const conversion = content ? markdownForFieldPaste(content) : null;
    if (!content || !conversion) return;
    event.preventDefault();
    const range = selection();
    void conversion
      .catch(() => null)
      .then((markdown) => insertText(markdown ?? content.text, range));
  };

  /** Whether a make button holds keyboard focus (not a click or tap's). */
  const makeButtonHasKeyboardFocus = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !makeGroup.current?.contains(active)) return false;
    try {
      return active.matches(':focus-visible');
    } catch {
      return true;
    }
  };

  const run = async (action: ((draft: JotDraft) => Promise<JotOutcome>) | undefined) => {
    if (!action || busy || dictating) return;
    const draft: JotDraft = { text: textRef.current, attachments: attachmentsRef.current };
    const returnFocus = makeButtonHasKeyboardFocus();
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await action(draft);
      if (outcome !== 'kept') setText('');
      if (outcome === 'used') {
        setAttachments([]);
        // The make buttons leave with the jot. Unless what it became took focus
        // (an opened document), a keyboard user goes back to the box, not the page top.
        const active = document.activeElement;
        const unclaimed =
          !active || active === document.body || makeGroup.current?.contains(active) === true;
        if (returnFocus && unclaimed) field.current?.focus();
      } else if (outcome === 'text-used') {
        setNotice('The text was saved. The files are still here: try again or remove them.');
      }
    } catch {
      setNotice('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void run(actions.toDocument);
    }
  };

  const locked = busy || dictating;
  const hasText = text.trim() !== '';
  // Nothing to make anything from yet: the box offers only ways to fill it.
  const hasContent = hasText || attachments.length > 0;
  const documentShortcut = isApplePlatform() ? '⌘↵' : 'Ctrl+Enter';
  const status = notice ?? hint;
  // Nothing in it and nothing going on: the jot recedes until pointed at or focused.
  const resting =
    text === '' &&
    attachments.length === 0 &&
    !status &&
    !busy &&
    !dragging &&
    !dictating &&
    !converting;
  const makeCount = hasContent ? 1 + (actions.toTask ? 1 : 0) + (actions.toJournal ? 1 : 0) : 0;

  // Re-fit the labels when what is on the row changes: make buttons come, go, or multiply...
  useLayoutEffect(() => {
    if (toolbar.current) fitToolbarLabels(toolbar.current);
  }, [makeCount, dictating]);

  // ...or when the room does: the pane resizes, or the mic loads or widens to record.
  useEffect(() => {
    const element = toolbar.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => fitToolbarLabels(element));
    observer.observe(element);
    // Not the make group: its own labels resize it, so watching it would loop.
    const addGroup = element.firstElementChild;
    if (addGroup) observer.observe(addGroup);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      className={`db-quick-jot${resting ? ' db-quick-jot--resting' : ''}${dragging ? ' db-quick-jot--dragging' : ''}${dictating ? ' db-quick-jot--dictating' : ''}`}
      aria-label="Quick Jot"
      onDragEnter={(event) => {
        if (!dragCarriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!dragCarriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setDragging(false);
        if (!dragCarriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="db-quick-jot-field">
        <textarea
          ref={field}
          id={`${id}-text`}
          className="db-quick-jot-input"
          aria-label="Jot something down"
          aria-describedby={status ? `${id}-status` : undefined}
          placeholder={converting ? '' : 'Type, drag, or paste here to jot something down'}
          rows={2}
          value={text}
          readOnly={locked}
          autoComplete="off"
          onChange={(event) => {
            setText(event.currentTarget.value);
            if (notice) setNotice(null);
          }}
          onScroll={(event) => {
            if (pendingOverlay.current) {
              pendingOverlay.current.scrollTop = event.currentTarget.scrollTop;
            }
          }}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
        {converting && (
          // The text again, unseen, so the dots land just after its last word.
          <div
            ref={pendingOverlay}
            className="db-quick-jot-pending"
            aria-hidden="true"
            style={{ '--db-quick-jot-gutter': `${gutter}px` } as CSSProperties}
          >
            <span className="db-quick-jot-pending-text">
              {/* The space the next phrase joins with: the dots may wrap at it. */}
              {withDictatedPhrase(text, '\u2026').slice(0, -1)}
            </span>
            <span className="db-quick-jot-dots" data-testid="quick-jot-converting">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
        )}
      </div>
      {attachments.length > 0 && (
        <ul className="db-quick-jot-attachments" aria-label="Attached files">
          {attachments.map((attachment) => {
            const name = attachment.file.name || 'Pasted file';
            return (
              <li key={attachment.id} className="db-quick-jot-attachment">
                <AttachmentPreview attachment={attachment} />
                <span className="db-quick-jot-attachment-name" title={name}>
                  {name}
                </span>
                <button
                  type="button"
                  className="db-quick-jot-remove"
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                  disabled={busy}
                  onClick={() =>
                    setAttachments(attachmentsRef.current.filter((item) => item !== attachment))
                  }
                >
                  <CloseIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="db-quick-jot-status" id={`${id}-status`} role="status" aria-live="polite">
        {status ?? ''}
      </p>
      <div ref={toolbar} className="db-quick-jot-toolbar">
        <div className="db-quick-jot-group" role="group" aria-label="Add to the jot">
          <button
            type="button"
            className="db-quick-jot-btn"
            aria-label="Paste from clipboard"
            title="Paste from clipboard"
            disabled={locked}
            onClick={() => void pasteFromClipboard()}
          >
            <NewFromClipboardIcon />
          </button>
          {dictation && (
            <Suspense fallback={null}>
              <QuickJotDictation
                provider={dictation.provider}
                speech={dictation.speech}
                onOpenSettings={dictation.onOpenSettings}
                disabled={busy}
                onText={(phrase) => setText(withDictatedPhrase(textRef.current, phrase))}
                onActiveChange={(active) => {
                  setDictating(active);
                  latestDictatingChange.current?.(active);
                }}
                onConvertingChange={setConverting}
                onError={setNotice}
              />
            </Suspense>
          )}
        </div>
        {hasContent && (
          <div
            ref={makeGroup}
            className="db-quick-jot-group db-quick-jot-make"
            role="group"
            aria-label="Make the jot into"
          >
            <button
              type="button"
              className="db-quick-jot-btn db-quick-jot-btn--labeled"
              aria-label="New document from jot"
              title={`New document from jot (${documentShortcut})`}
              disabled={locked}
              onClick={() => void run(actions.toDocument)}
            >
              <NewFileIcon />
              <span className="db-quick-jot-btn-label">Doc</span>
            </button>
            {actions.toTask && (
              <button
                type="button"
                className="db-quick-jot-btn db-quick-jot-btn--labeled"
                aria-label="New task from jot"
                title="New task from jot"
                disabled={locked || !hasText}
                onClick={() => void run(actions.toTask)}
              >
                <TasksIcon />
                <span className="db-quick-jot-btn-label">Task</span>
              </button>
            )}
            {actions.toJournal && (
              <button
                type="button"
                className="db-quick-jot-btn db-quick-jot-btn--labeled"
                aria-label="Add jot to journal"
                title="Add jot to journal"
                disabled={locked || !hasText}
                onClick={() => void run(actions.toJournal)}
              >
                <JournalIcon />
                <span className="db-quick-jot-btn-label">Journal</span>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
