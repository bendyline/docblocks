/**
 * Synthesis that survives the app leaving the screen.
 *
 * A phone stops speech when DocBlocks leaves the foreground: the screen
 * locks, or the user switches apps. A long job such as generating narration
 * then failed partway. Every chunk the engine delivers is a finished piece of
 * the request text, so an interrupted request can carry on instead. Once the
 * page is visible again, only the text after the last delivered chunk is
 * requested, and its chunks are placed back at their offsets in the original
 * text. Nothing already heard is synthesized twice.
 *
 * A failure counts as an interruption only when the page was hidden or
 * suspended while that request ran. Any other failure ends the job as before.
 */

import type {
  DocBlocksHostSpeechAPI,
  SpeechAudioChunk,
  SpeechSynthesisHandle,
} from '@bendyline/docblocks/host';

export interface PageInterruptions {
  /** Start watching a new request. It counts as interrupted if the page is hidden now. */
  begin(): void;
  /** The page has been hidden or suspended since `begin`, or is hidden now. */
  readonly interrupted: boolean;
  /** Resolves once the page is visible: immediately when it is, or when `signal` aborts. */
  whenVisible(signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

/**
 * Hidden visibility is the standard signal that the app left the screen. The
 * Page Lifecycle `freeze` event and Capacitor's `pause` event also count, for
 * web views that suspend a page without changing its visibility.
 */
export function watchPageInterruptions(doc: Document): PageInterruptions {
  const hidden = () => doc.visibilityState !== 'visible';
  let interrupted = hidden();
  const waiters = new Set<() => void>();
  const interrupt = (): void => {
    interrupted = true;
  };
  const handleVisibilityChange = (): void => {
    if (hidden()) {
      interrupted = true;
      return;
    }
    for (const wake of [...waiters]) wake();
  };
  doc.addEventListener('visibilitychange', handleVisibilityChange);
  doc.addEventListener('freeze', interrupt);
  doc.addEventListener('pause', interrupt);

  return {
    begin() {
      interrupted = hidden();
    },
    get interrupted() {
      return interrupted || hidden();
    },
    whenVisible(signal) {
      if (!hidden() || signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wake = (): void => {
          waiters.delete(wake);
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        waiters.add(wake);
        signal?.addEventListener('abort', wake);
      });
    },
    dispose() {
      doc.removeEventListener('visibilitychange', handleVisibilityChange);
      doc.removeEventListener('freeze', interrupt);
      doc.removeEventListener('pause', interrupt);
      for (const wake of [...waiters]) wake();
    },
  };
}

/**
 * The text still to speak after `spoken` characters, and where it starts.
 * Null once nothing but spaces and punctuation remains.
 */
export function remainingText(
  text: string,
  spoken: number,
): { readonly offset: number; readonly text: string } | null {
  const rest = text.slice(spoken);
  const trimmed = rest.trimStart();
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  return { offset: spoken + rest.length - trimmed.length, text: trimmed };
}

/** A chunk of a resumed request, moved to its offsets in the original text. */
export function shiftChunk(chunk: SpeechAudioChunk, offset: number): SpeechAudioChunk {
  if (offset === 0) return chunk;
  return {
    ...chunk,
    textStart: chunk.textStart + offset,
    textEnd: chunk.textEnd + offset,
    ...(chunk.wordTimings
      ? {
          wordTimings: chunk.wordTimings.map((word) => ({
            ...word,
            textStart: word.textStart + offset,
            textEnd: word.textEnd + offset,
          })),
        }
      : {}),
  };
}

export interface ResumableSynthesisOptions {
  readonly text: string;
  readonly synthesize: NonNullable<DocBlocksHostSpeechAPI['synthesize']>;
  readonly page: PageInterruptions;
  /** Aborting cancels the request in flight and ends the synthesis quietly. */
  readonly signal: AbortSignal;
  /** Each delivered chunk, in order, with offsets in `text`. */
  onChunk(chunk: SpeechAudioChunk): void;
  /** The page left the screen partway. Synthesis carries on once it is back. */
  onInterrupted?(): void;
}

/**
 * Speak all of `text`, picking up after the last delivered chunk whenever the
 * page leaves the screen partway. Resolves when the text is spoken or the
 * signal aborts. Throws when the engine fails for any other reason.
 */
export async function synthesizeResumably(options: ResumableSynthesisOptions): Promise<void> {
  const { text, synthesize, page, signal } = options;
  let spoken = 0;
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) return;
    // The first request is the text as given. A resumed one skips what was said.
    const rest = attempt === 0 ? { offset: 0, text } : remainingText(text, spoken);
    if (!rest) return;
    page.begin();
    const handle: SpeechSynthesisHandle = synthesize({ text: rest.text }, (event) => {
      if (event.kind !== 'chunk' || signal.aborted) return;
      const chunk = shiftChunk(event.chunk, rest.offset);
      spoken = Math.max(spoken, chunk.textEnd);
      options.onChunk(chunk);
    });
    const cancel = () => handle.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    let failure: unknown;
    try {
      const result = await handle.done;
      if (result.ok || signal.aborted) return;
      failure = new Error(result.error.message);
    } catch (error) {
      if (signal.aborted) return;
      failure = error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (!page.interrupted) throw failure;
    options.onInterrupted?.();
    await page.whenVisible(signal);
  }
}
