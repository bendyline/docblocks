import { useEffect, useRef, useState, type DragEvent } from 'react';
import { CloseIcon } from '../icons.js';
import { contentFromDataTransfer, type PastedContent } from './pasted-document.js';

/**
 * The one-line promise every first-run surface leads with. The pre-React
 * shell in `packages/site/index.html` shows the same sentence, so the message
 * does not change when the app takes over.
 */
export const WELCOME_HEADLINE = 'The Markdown editor that turns one file into anything.';

/**
 * What a first-run screen greets the user with, unless the host has already
 * said it (see `DocBlocksShellProps.firstRunGreeting`).
 */
export const WELCOME_GREETING = 'Welcome to DocBlocks';

/** What that means, for someone who has never heard of Markdown. */
export const WELCOME_SUMMARY =
  'Write the way you normally would, then share the same file as a PDF, a Word document, a slide deck, or a video.';

/** The trust line, kept apart so it can sit on its own line beneath the summary. */
export const WELCOME_PRIVACY_NOTE = 'No account, and your documents stay on this device.';

/**
 * Where the browser build sends visitors who want another DocBlocks app: the
 * comparison of every app, since the link promises more than the desktop one.
 */
const DOCBLOCKS_APPS_URL = 'https://docblocks.com/docs/#apps';

/** The third first-run choice: start from something the visitor already has. */
export const WELCOME_BRING_CONTENT_LABEL = 'Paste or drop something';
/** The same choice where nothing can be dragged onto the screen. */
export const COMPACT_WELCOME_BRING_CONTENT_LABEL = 'Paste or choose a file';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

function carriesSomething(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes('Files') || types.includes('text/plain') || types.includes('text/html');
}

export interface WelcomeScreenProps {
  /** Opens the New Document dialog. */
  onCreateDocument: () => void;
  /** Shows the welcome document, already selected, in Write. */
  onTour: () => void;
  /** Closes the screen for good without choosing either. */
  onDismiss: () => void;
  /**
   * Opens the paste-or-drop dialog. The choice is left out without it, as are
   * pasting and dropping straight onto the screen.
   */
  onBringContent?: () => void;
  /** Text pasted while the screen is up, or dragged onto it. */
  onPasteContent?: (content: PastedContent) => void;
  /** Files dropped onto the screen. */
  onDropFiles?: (files: File[]) => void;
  /**
   * Adds a link to the native apps. Only the browser build sets it: a visitor
   * already running a native app has nothing to go and get.
   */
  offerApps?: boolean;
  /** The eyebrow over the headline. */
  greeting?: string;
}

/**
 * First-run screen over the editor area. A new visitor sees what DocBlocks is
 * and its choices -- start their own document, bring something they already
 * have, or read the welcome one -- instead of the full editor chrome. The
 * welcome document's editor mounts underneath (inert), so taking the tour is
 * instant. Bringing something is also a paste with nothing focused, or a drop
 * anywhere on the screen: the quickest way to see one's own words as slides.
 *
 * The class names predate this screen (it replaced a toast) and are what the
 * suites and the shell's other entry points look for.
 */
export function WelcomeScreen({
  onCreateDocument,
  onTour,
  onDismiss,
  onBringContent,
  onPasteContent,
  onDropFiles,
  offerApps = false,
  greeting = WELCOME_GREETING,
}: WelcomeScreenProps) {
  const [dragging, setDragging] = useState(false);
  // Nested children fire dragleave as the pointer crosses them.
  const dragDepth = useRef(0);
  const acceptsContent = onBringContent !== undefined;

  // The editor beneath is inert, so a paste with nothing focused would go
  // nowhere. While this screen is up it starts a document instead. A field
  // (or the paste dialog) that handles its own paste is left alone.
  const pasteRef = useRef(onPasteContent);
  pasteRef.current = onPasteContent;
  useEffect(() => {
    if (!acceptsContent) return;
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const content = contentFromDataTransfer(event.clipboardData);
      if (!content || !pasteRef.current) return;
      event.preventDefault();
      pasteRef.current(content);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [acceptsContent]);

  const dropHandlers = acceptsContent
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!carriesSomething(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!carriesSomething(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          dragDepth.current = 0;
          setDragging(false);
          if (!carriesSomething(event)) return;
          event.preventDefault();
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) {
            onDropFiles?.(files);
            return;
          }
          const content = contentFromDataTransfer(event.dataTransfer);
          if (content) onPasteContent?.(content);
        },
      }
    : {};

  return (
    <section
      className={`db-welcome-gateway${dragging ? ' db-welcome-gateway--dragging' : ''}`}
      aria-labelledby="db-welcome-gateway-title"
      {...dropHandlers}
    >
      <button
        type="button"
        className="db-close-button db-welcome-gateway-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss welcome"
        title="Dismiss"
      >
        <CloseIcon />
      </button>
      <div className="db-welcome-gateway-body">
        <div className="db-welcome-gateway-copy">
          <p className="db-welcome-gateway-eyebrow">{greeting}</p>
          <h1 id="db-welcome-gateway-title">{WELCOME_HEADLINE}</h1>
          <p>{WELCOME_SUMMARY}</p>
          <p className="db-welcome-gateway-note">{WELCOME_PRIVACY_NOTE}</p>
          <div className="db-welcome-gateway-actions">
            <button type="button" className="db-welcome-gateway-primary" onClick={onCreateDocument}>
              Create a document
            </button>
            {onBringContent && (
              <button type="button" className="db-welcome-gateway-bring" onClick={onBringContent}>
                {WELCOME_BRING_CONTENT_LABEL}
              </button>
            )}
            <button type="button" className="db-welcome-gateway-cta" onClick={onTour}>
              Tour the welcome document
            </button>
            {/* A link, not a button: it navigates, and a new tab leaves the
                visitor's open document where it was. */}
            {offerApps && (
              <a
                className="db-welcome-gateway-apps"
                href={DOCBLOCKS_APPS_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Check out the DocBlocks apps
              </a>
            )}
          </div>
        </div>
        <WelcomeLoop />
      </div>
    </section>
  );
}

export interface CompactWelcomeScreenProps {
  /** Opens the New Document dialog. */
  onCreateDocument: () => void;
  /** Shows the welcome document in the editor. */
  onTour: () => void;
  /** Closes the screen for good, leaving the file pane beneath. */
  onDismiss: () => void;
  /** Opens the paste-or-choose dialog; the choice is left out without it. */
  onBringContent?: () => void;
  /** The heading. */
  greeting?: string;
}

/**
 * First-run screen for the single-pane layout. It covers the whole app rather
 * than sharing the file drawer, which left a phone too little height for the
 * card. The shell makes the panes beneath it inert; the class names are what
 * the suites look for.
 */
export function CompactWelcomeScreen({
  onCreateDocument,
  onTour,
  onDismiss,
  onBringContent,
  greeting = WELCOME_GREETING,
}: CompactWelcomeScreenProps) {
  return (
    <section className="db-mobile-first-run" aria-labelledby="db-mobile-first-run-title">
      <button
        type="button"
        className="db-close-button db-mobile-first-run-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss welcome"
        title="Dismiss"
      >
        <CloseIcon />
      </button>
      <div className="db-mobile-first-run-body">
        <p className="db-mobile-first-run-eyebrow">Local-first Markdown editor</p>
        <h1 id="db-mobile-first-run-title">{greeting}</h1>
        <p>{WELCOME_SUMMARY}</p>
        <p className="db-mobile-first-run-note">{WELCOME_PRIVACY_NOTE}</p>
        <div className="db-mobile-first-run-actions">
          <button type="button" onClick={onCreateDocument}>
            Create a document
          </button>
          {onBringContent && (
            <button
              type="button"
              className="db-mobile-first-run-secondary"
              onClick={onBringContent}
            >
              {COMPACT_WELCOME_BRING_CONTENT_LABEL}
            </button>
          )}
          <button type="button" className="db-mobile-first-run-secondary" onClick={onTour}>
            Tour the welcome document
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * One file becoming a PDF page, a slide, and a video frame, on a 9 s CSS
 * loop. Purely illustrative: the copy beside it says the same thing, so it is
 * hidden from assistive technology, and reduced motion shows the three
 * results side by side instead.
 */
function WelcomeLoop() {
  return (
    <div className="db-welcome-loop" aria-hidden="true">
      <div className="db-welcome-loop-source">
        <span className="db-welcome-loop-file">Lisbon.md</span>
        <code>
          <span className="db-welcome-loop-mark"># </span>Lisbon in three days
          {'\n'}Trams, tiles, and pastries.
          {'\n\n'}
          <span className="db-welcome-loop-mark">## </span>Day one
          {'\n'}
          <span className="db-welcome-loop-mark">- </span>Ride Tram 28
          {'\n'}
          <span className="db-welcome-loop-mark">- </span>Sunset at Graça
        </code>
      </div>
      <div className="db-welcome-loop-arrow">&rarr;</div>
      <div className="db-welcome-loop-stage">
        <div className="db-welcome-loop-frame db-welcome-loop-frame--page">
          <strong>Lisbon in three days</strong>
          <span>Trams, tiles, and pastries.</span>
          <em>Day one</em>
          <span>&bull; Ride Tram 28</span>
          <span>&bull; Sunset at Graça</span>
        </div>
        <div className="db-welcome-loop-frame db-welcome-loop-frame--slide">
          <strong>Lisbon in three days</strong>
          <span>Trams, tiles, and pastries.</span>
        </div>
        <div className="db-welcome-loop-frame db-welcome-loop-frame--video">
          <em>Day one</em>
          <span>&bull; Ride Tram 28</span>
          <span>&bull; Sunset at Graça</span>
          <i className="db-welcome-loop-play">&#9654;</i>
          <i className="db-welcome-loop-progress" />
        </div>
      </div>
      <ol className="db-welcome-loop-labels">
        <li>PDF</li>
        <li>Slides</li>
        <li>Video</li>
      </ol>
    </div>
  );
}
