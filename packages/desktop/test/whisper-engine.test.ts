import { parseSpeechTranscript } from '@bendyline/docblocks/host';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
// Node's own fetch: the root suite installs happy-dom, whose fetch applies
// browser CORS rules to the loopback server.
import { fetch as nodeFetch } from 'undici';
import {
  WhisperEngine,
  WhisperEngineError,
  multipartBody,
  normalizeWhisperTranscript,
  whisperLanguage,
  whisperSegments,
  whisperWords,
} from '../main/speech/whisper-engine.js';

const FAKE_SERVER = fileURLToPath(new URL('./helpers/fake-whisper-server.mjs', import.meta.url));

/** A WAV header plus a little silence; the fake only checks the magic. */
function wav(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [...'WAVE'].map((c) => c.charCodeAt(0)),
    8,
  );
  return bytes.buffer;
}

function engine(
  env: Record<string, string> = {},
  options: Partial<{ idleStopMs: number; readyTimeoutMs: number }> = {},
) {
  return new WhisperEngine({
    binary: process.execPath,
    leadingArgs: [FAKE_SERVER],
    fetchImpl: nodeFetch as unknown as typeof fetch,
    env: { ...process.env, ...env },
    healthIntervalMs: 20,
    readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
    ...(options.idleStopMs === undefined ? {} : { idleStopMs: options.idleStopMs }),
  });
}

async function failure(promise: Promise<unknown>): Promise<WhisperEngineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WhisperEngineError) return error;
    throw error;
  }
  throw new Error('expected the engine to fail');
}

describe('normalizeWhisperTranscript', () => {
  it('trims and turns the blank-audio sentinel into empty text', () => {
    expect(normalizeWhisperTranscript('  Hello.  ')).to.equal('Hello.');
    expect(normalizeWhisperTranscript(' [BLANK_AUDIO] ')).to.equal('');
    expect(normalizeWhisperTranscript('[ blank_audio ]')).to.equal('');
  });
});

describe('multipartBody', () => {
  it('encodes the take and fields without relying on a FormData realm', () => {
    const { boundary, body } = multipartBody({
      audio: wav(),
      prompt: 'line one\nline two',
      language: 'en',
    });
    const text = Buffer.from(body).toString('latin1');
    expect(text.startsWith(`--${boundary}\r\n`)).to.equal(true);
    expect(text).to.contain('name="file"; filename="audio.wav"\r\nContent-Type: audio/wav');
    expect(text).to.contain('RIFF');
    expect(text).to.contain('name="response_format"\r\n\r\njson');
    expect(text).to.contain('name="language"\r\n\r\nen');
    // A prompt never smuggles a line break into the form.
    expect(text).to.contain('name="prompt"\r\n\r\nline one line two');
    expect(text.endsWith(`--${boundary}--\r\n`)).to.equal(true);
  });

  it('asks for verbose output only when timestamps are wanted', () => {
    const verbose = Buffer.from(multipartBody({ audio: wav(), timestamps: true }).body);
    expect(verbose.toString('latin1')).to.contain('name="response_format"\r\n\r\nverbose_json');
  });
});

describe('whisperLanguage', () => {
  it('keeps a language tag and drops the full names verbose output reports', () => {
    expect(whisperLanguage('en')).to.equal('en');
    expect(whisperLanguage('english')).to.equal(null);
    expect(whisperLanguage(7)).to.equal(null);
    expect(whisperLanguage(undefined)).to.equal(null);
  });
});

describe('whisperSegments', () => {
  it('joins sub-word tokens into words and keeps segment times', () => {
    const segments = whisperSegments([
      {
        id: 0,
        text: ' So if you are building workflows.',
        start: 3.16,
        end: 5.36,
        words: [
          { word: ' So', start: 3.16, end: 3.24 },
          { word: ' you', start: 3.32, end: 3.44 },
          { word: "'re", start: 3.44, end: 3.49 },
          { word: ' work', start: 4.9, end: 5.03 },
          { word: 'flows', start: 5.18, end: 5.32 },
          { word: '.', start: 5.32, end: 5.36 },
        ],
      },
      { text: 'no times' },
      { start: 6, end: 7, text: ' Plain.' },
    ]);
    expect(segments).to.deep.equal([
      {
        start: 3.16,
        end: 5.36,
        text: 'So if you are building workflows.',
        words: [
          { start: 3.16, end: 3.24, text: 'So' },
          { start: 3.32, end: 3.49, text: "you're" },
          { start: 4.9, end: 5.36, text: 'workflows.' },
        ],
      },
      { start: 6, end: 7, text: 'Plain.' },
    ]);
  });

  it('drops malformed tokens and clamps negative times', () => {
    expect(
      whisperWords([
        { word: ' ok', start: -0.1, end: 0.2 },
        { word: 7, start: 0, end: 1 },
        { word: ' late', start: Number.NaN, end: 1 },
        null,
      ]),
    ).to.deep.equal([{ start: 0, end: 0.2, text: 'ok' }]);
  });
});

describe('WhisperEngine', function () {
  this.timeout(20_000);
  const engines: WhisperEngine[] = [];
  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.stop()));
  });
  const make = (...args: Parameters<typeof engine>) => {
    const created = engine(...args);
    engines.push(created);
    return created;
  };

  it('starts lazily, waits for readiness, and transcribes a take', async () => {
    const whisper = make({
      FAKE_WHISPER_READY_DELAY_MS: '150',
      FAKE_WHISPER_TEXT: 'Dictated words.',
    });
    const result = await whisper.transcribe('/models/base.bin', { audio: wav() });
    expect(result.text).to.equal('Dictated words.');
    expect(result.language).to.equal(null);
    expect(result.durationMs).to.be.at.least(0);
  });

  it('returns timed words when asked, and text only otherwise', async () => {
    const whisper = make({ FAKE_WHISPER_TEXT: 'Timing narration works.' });
    const timed = await whisper.transcribe('/m.bin', { audio: wav(), timestamps: true });
    expect(timed.segments).to.have.length(1);
    expect(timed.segments[0]!.words!.map((word) => word.text)).to.deep.equal([
      'Timing',
      'narration',
      'works.',
    ]);
    expect(timed.segments[0]!.words![1]!.start).to.equal(0.6);
    // The preload bridge rejects any transcript the wire policy cannot read.
    expect(parseSpeechTranscript(timed)).to.deep.equal(timed);
    const plain = await whisper.transcribe('/m.bin', { audio: wav() });
    expect(plain.text).to.equal('Timing narration works.');
    expect(plain.segments).to.deep.equal([]);
  });

  it('forwards the continuity prompt', async () => {
    const whisper = make({ FAKE_WHISPER_MODE: 'echo-prompt' });
    const result = await whisper.transcribe('/m.bin', { audio: wav(), prompt: 'earlier words' });
    expect(result.text).to.equal('prompt was: earlier words');
  });

  it('returns empty text for silence', async () => {
    const whisper = make({ FAKE_WHISPER_MODE: 'blank' });
    expect((await whisper.transcribe('/m.bin', { audio: wav() })).text).to.equal('');
  });

  it('reports a server that dies while loading, with its output', async () => {
    const whisper = make({ FAKE_WHISPER_MODE: 'crash-on-start' });
    const error = await failure(whisper.prepare('/m.bin'));
    expect(error.failure).to.equal('engine-failed');
    expect(error.detail).to.contain('failed to load model');
  });

  it('reports a missing binary as unavailable', async () => {
    const whisper = new WhisperEngine({
      binary: '/nonexistent/gezel-whisper-server',
      fetchImpl: nodeFetch as unknown as typeof fetch,
    });
    engines.push(whisper);
    expect((await failure(whisper.prepare('/m.bin'))).failure).to.equal('engine-unavailable');
  });

  it('times out a server that never becomes ready', async () => {
    const whisper = make({ FAKE_WHISPER_MODE: 'never-ready' }, { readyTimeoutMs: 200 });
    expect((await failure(whisper.prepare('/m.bin'))).failure).to.equal('timeout');
  });

  it('restarts after a crash and stops retrying a crash loop', async () => {
    const whisper = make({ FAKE_WHISPER_MODE: 'exit-on-request' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await failure(whisper.transcribe('/m.bin', { audio: wav() }))).failure).to.equal(
        'engine-failed',
      );
    }
    const error = await failure(whisper.transcribe('/m.bin', { audio: wav() }));
    expect(error.message).to.contain('keeps stopping');
  });

  it('restarts the server when the model changes', async () => {
    const whisper = make();
    await whisper.prepare('/a.bin');
    await whisper.prepare('/b.bin');
    expect((await whisper.transcribe('/b.bin', { audio: wav() })).text).to.equal(
      'Hello from dictation.',
    );
  });

  it('honours cancellation while the model loads', async () => {
    const whisper = make({ FAKE_WHISPER_READY_DELAY_MS: '2000' });
    const controller = new AbortController();
    const pending = whisper.prepare('/m.bin', controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect((await failure(pending)).failure).to.equal('cancelled');
  });

  it('stops an idle server', async () => {
    const whisper = make({}, { idleStopMs: 100 });
    await whisper.transcribe('/m.bin', { audio: wav() });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A fresh request transparently starts it again.
    expect((await whisper.transcribe('/m.bin', { audio: wav() })).text).to.equal(
      'Hello from dictation.',
    );
  });
});
