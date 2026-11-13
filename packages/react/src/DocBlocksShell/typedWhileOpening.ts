/**
 * Holds what a person types while a just-created document is still opening.
 *
 * After **Create** in the New document dialog, the dialog closes at once but
 * the document's editor takes from half a second to several seconds to mount
 * and take focus. Keystrokes in that window went to the page body and were
 * lost, so the first words of a new document routinely vanished. Focus also
 * returns briefly to the button that opened the dialog, where Enter or Space
 * would open it again.
 *
 * While a buffer is running it takes printable keys, Enter and Backspace,
 * keeps them, and stops them from reaching the page.
 * {@link TypedWhileOpening.take} hands the text over once the editor has the
 * caret. That includes keys that arrive while some editor already has focus:
 * the shell focuses the outgoing document's editor as the welcome screen
 * closes, before the new document has mounted, and a key let through then
 * landed in the wrong document.
 *
 * It stops holding keys (keeping what it has) when the person takes over —
 * clicks or taps anywhere, or focus reaches a form field such as a search
 * box — and forgets everything after `timeoutMs`.
 */

export interface TypedWhileOpening {
  /** Stop listening and return what was typed, with `\n` for Enter. */
  take(): string;
  /** Stop listening and forget what was typed. */
  cancel(): void;
}

/** Long enough for a slow first load; short enough that stale keys never replay. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** A form field: typing there is meant for it, not for the new document. */
function isFormField(element: Element | null): boolean {
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function startTypedWhileOpening(
  target: Document = document,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): TypedWhileOpening {
  let text = '';
  let listening = true;
  const view = target.defaultView;

  /** Stop holding keys; what was typed stays for `take`. */
  const release = (): void => {
    if (!listening) return;
    listening = false;
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('pointerdown', release, true);
  };
  const stop = (): void => {
    release();
    if (timer !== undefined) view?.clearTimeout(timer);
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    // Shortcuts are commands, not text.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isFormField(target.activeElement)) {
      // Typing has somewhere real to go (a search box, a dialog field).
      release();
      return;
    }
    if (event.key === 'Enter') text += '\n';
    else if (event.key === 'Backspace') text = text.slice(0, -1);
    else if (event.key.length === 1) text += event.key;
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  target.addEventListener('keydown', onKeyDown, true);
  // A click or tap means the person is choosing where to type themselves.
  target.addEventListener('pointerdown', release, true);
  // Read by `stop`, which only ever runs after this line.
  const timer = view?.setTimeout(() => {
    stop();
    text = '';
  }, timeoutMs);

  return {
    take() {
      stop();
      const typed = text;
      text = '';
      return typed;
    },
    cancel() {
      stop();
      text = '';
    },
  };
}
