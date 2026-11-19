import { expect } from 'chai';
import type {
  DocBlocksHostSpeechAPI,
  SpeechAudioChunk,
  SpeechResult,
  SpeechSynthesisSummary,
} from '@bendyline/docblocks/host';
import {
  remainingText,
  shiftChunk,
  synthesizeResumably,
  watchPageInterruptions,
} from '../src/Speech/resumable-synthesis.js';

type Synthesize = NonNullable<DocBlocksHostSpeechAPI['synthesize']>;

/** A document whose visibility the test controls. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const SUMMARY: SpeechSynthesisSummary = {
  voice: 'af_heart',
  model: 'kokoro',
  sampleRate: 24_000,
  durationSec: 1,
  chunks: 1,
};

/** One chunk per sentence, offsets in the request text, word times on each word. */
function sentenceChunks(text: string): SpeechAudioChunk[] {
  const chunks: SpeechAudioChunk[] = [];
  for (const match of text.matchAll(/[^.!?]+[.!?]?/gu)) {
    const start = match.index + (match[0].length - match[0].trimStart().length);
    const end = match.index + match[0].trimEnd().length;
    if (end <= start) continue;
    chunks.push({
      index: chunks.length,
      pcm: new ArrayBuffer(8),
      sampleRate: 24_000,
      durationSec: 1,
      textStart: start,
      textEnd: end,
      wordTimings: [{ textStart: start, textEnd: end, startSec: 0, endSec: 1 }],
    });
  }
  return chunks;
}

/**
 * An engine that speaks a sentence at a time. `stopAfter` scripts an
 * interruption per request: after that many chunks the page is hidden and the
 * request ends as a phone's host ends it, cancelled.
 */
function engine(doc: FakeDocument, stopAfter: Array<number | null>) {
  const requests: string[] = [];
  const synthesize: Synthesize = (request, onEvent) => {
    const stop = stopAfter[requests.length] ?? null;
    requests.push(request.text);
    let cancelled = false;
    const done = (async (): Promise<SpeechResult<SpeechSynthesisSummary>> => {
      await Promise.resolve();
      for (const [index, chunk] of sentenceChunks(request.text).entries()) {
        if (cancelled) break;
        if (stop !== null && index >= stop) {
          doc.setVisibility('hidden');
          return { ok: false, error: { code: 'cancelled', message: 'Speech stopped.' } };
        }
        onEvent({ kind: 'chunk', chunk });
      }
      if (cancelled) return { ok: false, error: { code: 'cancelled', message: 'Speech stopped.' } };
      return { ok: true, value: SUMMARY };
    })();
    return {
      done,
      cancel: () => {
        cancelled = true;
      },
    };
  };
  return { synthesize, requests };
}

const TEXT = 'One fish. Two fish. Red fish. Blue fish.';

describe('resumable synthesis', () => {
  it('finds the text still to speak, skipping spaces and bare punctuation', () => {
    expect(remainingText(TEXT, 9)).to.deep.equal({
      offset: 10,
      text: 'Two fish. Red fish. Blue fish.',
    });
    expect(remainingText(TEXT, TEXT.length)).to.equal(null);
    expect(remainingText('A heading.', 9)).to.equal(null);
  });

  it('moves a resumed chunk and its word times back into the original text', () => {
    const [chunk] = sentenceChunks('Red fish.');
    const moved = shiftChunk(chunk!, 20);
    expect([moved.textStart, moved.textEnd]).to.deep.equal([20, 29]);
    expect(moved.wordTimings?.map((word) => [word.textStart, word.textEnd])).to.deep.equal([
      [20, 29],
    ]);
    expect(shiftChunk(chunk!, 0)).to.equal(chunk);
  });

  it('speaks straight through when nothing interrupts it', async () => {
    const doc = new FakeDocument();
    const { synthesize, requests } = engine(doc, []);
    const page = watchPageInterruptions(doc as unknown as Document);
    const spoken: string[] = [];
    await synthesizeResumably({
      text: TEXT,
      synthesize,
      page,
      signal: new AbortController().signal,
      onChunk: (chunk) => spoken.push(TEXT.slice(chunk.textStart, chunk.textEnd)),
    });
    expect(requests).to.deep.equal([TEXT]);
    expect(spoken).to.deep.equal(['One fish.', 'Two fish.', 'Red fish.', 'Blue fish.']);
  });

  it('waits off screen, then picks up after the last sentence it heard', async () => {
    const doc = new FakeDocument();
    const { synthesize, requests } = engine(doc, [2, null]);
    const page = watchPageInterruptions(doc as unknown as Document);
    const spoken: string[] = [];
    let interruptions = 0;
    const finished = synthesizeResumably({
      text: TEXT,
      synthesize,
      page,
      signal: new AbortController().signal,
      onChunk: (chunk) => spoken.push(TEXT.slice(chunk.textStart, chunk.textEnd)),
      onInterrupted: () => (interruptions += 1),
    });
    let settled = false;
    void finished.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Off screen: nothing more is requested until the page is back.
    expect(settled).to.equal(false);
    expect(requests).to.have.length(1);
    expect(interruptions).to.equal(1);

    doc.setVisibility('visible');
    await finished;
    expect(requests).to.deep.equal([TEXT, 'Red fish. Blue fish.']);
    expect(spoken).to.deep.equal(['One fish.', 'Two fish.', 'Red fish.', 'Blue fish.']);
    page.dispose();
  });

  it('starts over from the beginning when stopped before any audio', async () => {
    const doc = new FakeDocument();
    const { synthesize, requests } = engine(doc, [0, null]);
    const page = watchPageInterruptions(doc as unknown as Document);
    const finished = synthesizeResumably({
      text: TEXT,
      synthesize,
      page,
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    doc.setVisibility('visible');
    await finished;
    expect(requests).to.deep.equal([TEXT, TEXT]);
    page.dispose();
  });

  it('fails as before when the engine fails on screen', async () => {
    const doc = new FakeDocument();
    const page = watchPageInterruptions(doc as unknown as Document);
    const synthesize: Synthesize = () => ({
      done: Promise.resolve({
        ok: false,
        error: { code: 'engine-failed', message: 'Speech failed on this device. Try again.' },
      }),
      cancel: () => {},
    });
    let error: unknown;
    await synthesizeResumably({
      text: TEXT,
      synthesize,
      page,
      signal: new AbortController().signal,
      onChunk: () => {},
    }).catch((cause: unknown) => (error = cause));
    expect((error as Error).message).to.equal('Speech failed on this device. Try again.');
  });

  it('ends quietly when cancelled while waiting for the page', async () => {
    const doc = new FakeDocument();
    const { synthesize, requests } = engine(doc, [1]);
    const page = watchPageInterruptions(doc as unknown as Document);
    const controller = new AbortController();
    const finished = synthesizeResumably({
      text: TEXT,
      synthesize,
      page,
      signal: controller.signal,
      onChunk: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await finished;
    expect(requests).to.have.length(1);
  });

  it('counts a request started off screen as interrupted', () => {
    const doc = new FakeDocument();
    const page = watchPageInterruptions(doc as unknown as Document);
    page.begin();
    expect(page.interrupted).to.equal(false);
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    expect(page.interrupted).to.equal(true);
    page.begin();
    expect(page.interrupted).to.equal(false);
    doc.dispatchEvent(new Event('freeze'));
    expect(page.interrupted).to.equal(true);
    page.dispose();
  });
});
