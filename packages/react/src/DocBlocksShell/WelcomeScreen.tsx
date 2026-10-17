/**
 * The one-line promise every first-run surface leads with. The pre-React
 * shell in `packages/site/index.html` shows the same sentence, so the message
 * does not change when the app takes over.
 */
export const WELCOME_HEADLINE = 'The Markdown editor that turns one file into anything.';

/** What that means, for someone who has never heard of Markdown. */
export const WELCOME_SUMMARY =
  'Write the way you normally would, then share the same file as a PDF, a Word document, a slide deck, or a video.';

/** The trust line, kept apart so the compact phone card can reuse it. */
export const WELCOME_PRIVACY_NOTE = 'No account, and your documents stay on this device.';

export interface WelcomeScreenProps {
  /** Opens the New Document dialog. */
  onCreateDocument: () => void;
  /** Shows the welcome document, already selected, in Write. */
  onTour: () => void;
  /** Closes the screen for good without choosing either. */
  onDismiss: () => void;
}

/**
 * First-run screen over the editor area. A new visitor sees what DocBlocks is
 * and two choices -- start their own document, or read the welcome one --
 * instead of the full editor chrome. The welcome document's editor mounts
 * underneath (inert), so taking the tour is instant.
 *
 * The class names predate this screen (it replaced a toast) and are what the
 * suites and the shell's other entry points look for.
 */
export function WelcomeScreen({ onCreateDocument, onTour, onDismiss }: WelcomeScreenProps) {
  return (
    <section className="db-welcome-gateway" aria-labelledby="db-welcome-gateway-title">
      <button
        type="button"
        className="db-welcome-gateway-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss welcome"
        title="Dismiss"
      >
        &times;
      </button>
      <div className="db-welcome-gateway-body">
        <div className="db-welcome-gateway-copy">
          <p className="db-welcome-gateway-eyebrow">Welcome to DocBlocks</p>
          <h1 id="db-welcome-gateway-title">{WELCOME_HEADLINE}</h1>
          <p>{WELCOME_SUMMARY}</p>
          <p className="db-welcome-gateway-note">{WELCOME_PRIVACY_NOTE}</p>
          <div className="db-welcome-gateway-actions">
            <button type="button" className="db-welcome-gateway-primary" onClick={onCreateDocument}>
              Create a document
            </button>
            <button type="button" className="db-welcome-gateway-cta" onClick={onTour}>
              Tour the welcome document
            </button>
          </div>
        </div>
        <WelcomeLoop />
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
