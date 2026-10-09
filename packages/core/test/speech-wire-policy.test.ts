import { expect } from 'chai';
import {
  SPEECH_WIRE_LIMITS,
  parseSpeechAudioChunk,
  parseSpeechCatalog,
  parseSpeechError,
  parseSpeechInstallEvent,
  parseSpeechNullResult,
  parseSpeechPreferences,
  parseSpeechPreferencesPatch,
  parseSpeechResult,
  parseSpeechStatus,
  parseSpeechSynthesizeEvent,
  parseSpeechSynthesizeRequest,
  parseSpeechTranscribeRequest,
  parseSpeechTranscript,
} from '../src/host/speech-wire-policy.js';

/** A minimal valid RIFF/WAVE header plus `extra` sample bytes. */
function wav(extra = 0): ArrayBuffer {
  const bytes = new Uint8Array(44 + extra);
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

const MODEL = Object.freeze({
  id: 'whisper-base.en',
  kind: 'stt',
  label: 'Whisper base (English)',
  description: 'Balanced accuracy and speed.',
  downloadBytes: 147_964_211,
  installed: true,
  source: 'app',
  recommended: true,
  license: 'MIT',
  licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
});

describe('parseSpeechTranscribeRequest', () => {
  it('accepts a WAV take with a prompt and returns an owned buffer', () => {
    const audio = wav(8);
    const parsed = parseSpeechTranscribeRequest({
      audio,
      mimeType: 'audio/wav',
      prompt: 'earlier words',
      language: 'en',
    });
    expect(parsed?.prompt).to.equal('earlier words');
    expect(parsed?.language).to.equal('en');
    expect(parsed?.audio.byteLength).to.equal(52);
    // The parser copies, so the sender's buffer is never aliased.
    expect(parsed?.audio).to.not.equal(audio);
  });

  it('accepts the Uint8Array a structured clone may deliver', () => {
    const parsed = parseSpeechTranscribeRequest({
      audio: new Uint8Array(wav(4)),
      mimeType: 'audio/wav',
    });
    expect(parsed?.audio).to.be.instanceOf(ArrayBuffer);
  });

  it('rejects non-WAV bytes, other mime types, oversize audio and stray keys', () => {
    expect(
      parseSpeechTranscribeRequest({ audio: new ArrayBuffer(64), mimeType: 'audio/wav' }),
    ).to.equal(null);
    expect(parseSpeechTranscribeRequest({ audio: wav(), mimeType: 'audio/webm' })).to.equal(null);
    expect(
      parseSpeechTranscribeRequest({
        audio: wav(SPEECH_WIRE_LIMITS.transcribeAudioBytes),
        mimeType: 'audio/wav',
      }),
    ).to.equal(null);
    expect(
      parseSpeechTranscribeRequest({ audio: wav(), mimeType: 'audio/wav', model: 'x' }),
    ).to.equal(null);
    expect(
      parseSpeechTranscribeRequest({
        audio: wav(),
        mimeType: 'audio/wav',
        prompt: 'x'.repeat(SPEECH_WIRE_LIMITS.promptCharacters + 1),
      }),
    ).to.equal(null);
    expect(
      parseSpeechTranscribeRequest({ audio: wav(), mimeType: 'audio/wav', language: 'en us' }),
    ).to.equal(null);
  });
});

describe('parseSpeechSynthesizeRequest', () => {
  it('accepts text with an optional voice and speed', () => {
    expect(
      parseSpeechSynthesizeRequest({ text: 'Hello.', voice: 'af_heart', speed: 1.25 }),
    ).to.deep.equal({
      text: 'Hello.',
      voice: 'af_heart',
      speed: 1.25,
    });
  });

  it('rejects empty or oversize text and out-of-range speed', () => {
    expect(parseSpeechSynthesizeRequest({ text: '' })).to.equal(null);
    expect(
      parseSpeechSynthesizeRequest({
        text: 'x'.repeat(SPEECH_WIRE_LIMITS.synthesizeTextCharacters + 1),
      }),
    ).to.equal(null);
    expect(parseSpeechSynthesizeRequest({ text: 'Hi', speed: 3 })).to.equal(null);
    expect(parseSpeechSynthesizeRequest({ text: 'Hi', voice: '../voice' })).to.equal(null);
  });
});

describe('speech preferences', () => {
  it('parses a patch that clears a choice back to the default', () => {
    expect(parseSpeechPreferencesPatch({ sttModel: null, speed: 1.5 })).to.deep.equal({
      sttModel: null,
      speed: 1.5,
    });
    expect(parseSpeechPreferencesPatch({ language: 'en' })).to.equal(null);
  });

  it('requires every field in the full preferences', () => {
    expect(parseSpeechPreferences({ sttModel: null, voice: 'af_heart', speed: 1 })).to.deep.equal({
      sttModel: null,
      voice: 'af_heart',
      speed: 1,
    });
    expect(parseSpeechPreferences({ sttModel: null, voice: null })).to.equal(null);
  });
});

describe('speech status and catalog', () => {
  it('parses readiness for both engines', () => {
    expect(
      parseSpeechStatus({
        stt: { state: 'download-required', model: 'whisper-base.en' },
        tts: { state: 'unavailable', reason: 'Requires macOS 14 or later.' },
      }),
    ).to.deep.equal({
      stt: { state: 'download-required', model: 'whisper-base.en' },
      tts: { state: 'unavailable', reason: 'Requires macOS 14 or later.' },
    });
    expect(parseSpeechStatus({ stt: { state: 'ready' } })).to.equal(null);
    expect(parseSpeechStatus({ stt: { state: 'warming' }, tts: { state: 'ready' } })).to.equal(
      null,
    );
  });

  it('parses a catalog and rejects inconsistent install state', () => {
    const catalog = {
      models: [{ ...MODEL }],
      voices: [
        {
          id: 'af_heart',
          label: 'Heart',
          language: 'en-US',
          gender: 'female',
          modelId: 'kokoro-82m-v1.0',
        },
      ],
    };
    expect(parseSpeechCatalog(catalog)).to.deep.equal(catalog);
    // Installed with no source, or a source while not installed, is a lie.
    expect(parseSpeechCatalog({ ...catalog, models: [{ ...MODEL, source: null }] })).to.equal(null);
    expect(parseSpeechCatalog({ ...catalog, models: [{ ...MODEL, installed: false }] })).to.equal(
      null,
    );
    expect(
      parseSpeechCatalog({ ...catalog, models: [{ ...MODEL, licenseUrl: 'http://x.test' }] }),
    ).to.equal(null);
  });

  it('parses install progress, completion and failure', () => {
    expect(
      parseSpeechInstallEvent({
        kind: 'progress',
        progress: { phase: 'downloading', receivedBytes: 10, totalBytes: null },
      }),
    ).to.deep.equal({
      kind: 'progress',
      progress: { phase: 'downloading', receivedBytes: 10, totalBytes: null },
    });
    expect(parseSpeechInstallEvent({ kind: 'done', model: { ...MODEL } })?.kind).to.equal('done');
    expect(
      parseSpeechInstallEvent({
        kind: 'error',
        error: { code: 'model-download-failed', message: 'Checksum mismatch.' },
      })?.kind,
    ).to.equal('error');
    expect(parseSpeechInstallEvent({ kind: 'progress', progress: { phase: 'x' } })).to.equal(null);
  });

  it('round-trips an explicit model update requirement and rejects inconsistent values', () => {
    const oldModel = { ...MODEL, installed: false, source: null, updateRequired: true };
    const catalog = { models: [oldModel], voices: [] };
    expect(parseSpeechCatalog(catalog)).to.deep.equal(catalog);
    for (const invalid of [
      { ...MODEL, updateRequired: true },
      { ...oldModel, updateRequired: 'yes' },
      { ...oldModel, updateRequired: null },
      { ...oldModel, unexpected: true },
    ]) {
      expect(parseSpeechCatalog({ models: [invalid], voices: [] })).to.equal(null);
    }
  });
});

describe('speech results', () => {
  it('parses success and failure envelopes', () => {
    const transcript = { text: 'Hello there.', language: 'en', segments: [], durationMs: 812 };
    expect(parseSpeechResult({ ok: true, value: transcript }, parseSpeechTranscript)).to.deep.equal(
      {
        ok: true,
        value: transcript,
      },
    );
    expect(
      parseSpeechResult(
        { ok: false, error: { code: 'model-missing', message: 'Download a model first.' } },
        parseSpeechTranscript,
      ),
    ).to.deep.equal({
      ok: false,
      error: { code: 'model-missing', message: 'Download a model first.' },
    });
    expect(parseSpeechResult({ ok: true, value: { text: 1 } }, parseSpeechTranscript)).to.equal(
      null,
    );
    expect(parseSpeechError({ code: 'exploded', message: 'x' })).to.equal(null);
  });

  it('treats null as the success payload of a null result', () => {
    expect(parseSpeechNullResult({ ok: true, value: null })).to.deep.equal({
      ok: true,
      value: null,
    });
    expect(parseSpeechNullResult({ ok: true, value: 0 })).to.equal(null);
    expect(
      parseSpeechNullResult({ ok: false, error: { code: 'cancelled', message: 'Stopped.' } }),
    ).to.deep.equal({ ok: false, error: { code: 'cancelled', message: 'Stopped.' } });
  });

  it('rejects transcript segments that run backwards', () => {
    expect(
      parseSpeechTranscript({
        text: 'x',
        language: null,
        segments: [{ start: 2, end: 1, text: 'x' }],
        durationMs: 10,
      }),
    ).to.equal(null);
  });
});

describe('parseSpeechSynthesizeEvent', () => {
  it('parses a chunk whose PCM arrives as a Float32Array', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    const event = parseSpeechSynthesizeEvent({
      kind: 'chunk',
      chunk: {
        index: 0,
        pcm: samples,
        sampleRate: 24_000,
        durationSec: 4 / 24_000,
        textStart: 0,
        textEnd: 6,
      },
    });
    expect(event?.kind).to.equal('chunk');
    if (event?.kind !== 'chunk') return;
    expect(Array.from(new Float32Array(event.chunk.pcm))).to.deep.equal([0, 0.5, -0.5, 0.25]);
  });

  it('rejects malformed chunks', () => {
    const chunk = {
      index: 0,
      pcm: new ArrayBuffer(8),
      sampleRate: 24_000,
      durationSec: 0.1,
      textStart: 0,
      textEnd: 4,
    };
    expect(parseSpeechAudioChunk(chunk)).to.not.equal(null);
    expect(parseSpeechAudioChunk({ ...chunk, pcm: new ArrayBuffer(6) })).to.equal(null);
    expect(parseSpeechAudioChunk({ ...chunk, sampleRate: 100 })).to.equal(null);
    expect(parseSpeechAudioChunk({ ...chunk, textStart: 5 })).to.equal(null);
  });

  it('copies bounded model timings and rejects malformed or unordered metadata', () => {
    const word = { textStart: 0, textEnd: 4, startSec: 0.1, endSec: 0.2 };
    const chunk = {
      index: 0,
      pcm: new Float32Array(24000),
      sampleRate: 24000,
      durationSec: 1,
      textStart: 0,
      textEnd: 10,
      wordTimings: [word, { ...word, startSec: 0.3, endSec: 0.5 }],
    };
    const parsed = parseSpeechAudioChunk(chunk)!;
    expect(parsed.wordTimings).to.deep.equal(chunk.wordTimings);
    expect(parsed.wordTimings![0]).not.to.equal(word);
    for (const invalid of [
      undefined,
      null,
      {},
      [{ ...word, textStart: -1 }],
      [{ ...word, textEnd: 11 }],
      [{ ...word, textEnd: 0 }],
      [{ ...word, startSec: NaN }],
      [{ ...word, endSec: 1.1 }],
      [{ ...word, extra: true }],
      [word, word],
      [
        { ...word, textStart: 5, textEnd: 6 },
        { ...word, startSec: 0.3, endSec: 0.5 },
      ],
      Array.from({ length: 1025 }, () => word),
    ]) {
      expect(parseSpeechAudioChunk({ ...chunk, wordTimings: invalid })).to.equal(null);
    }
  });

  it('parses progress, done and error events', () => {
    expect(
      parseSpeechSynthesizeEvent({
        kind: 'progress',
        phase: 'loading',
        completedCharacters: 0,
        totalCharacters: 12,
      })?.kind,
    ).to.equal('progress');
    expect(
      parseSpeechSynthesizeEvent({
        kind: 'progress',
        phase: 'synthesizing',
        completedCharacters: 13,
        totalCharacters: 12,
      }),
    ).to.equal(null);
    expect(
      parseSpeechSynthesizeEvent({
        kind: 'done',
        summary: {
          voice: 'af_heart',
          model: 'kokoro-82m-v1.0',
          sampleRate: 24_000,
          durationSec: 3.2,
          chunks: 2,
        },
      })?.kind,
    ).to.equal('done');
    expect(
      parseSpeechSynthesizeEvent({
        kind: 'error',
        error: { code: 'engine-failed', message: 'The voice engine stopped.' },
      })?.kind,
    ).to.equal('error');
  });
});
