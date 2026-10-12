/**
 * Opt-in: both real speech engines inside the packaged app.
 *
 * Seeds the app's speech store with real Kokoro and Whisper weights, then has
 * the packaged build narrate a paragraph and transcribe its own audio back.
 * This is the only check that exercises the narration utility process loading
 * ONNX Runtime from app.asar.unpacked and the bundled whisper-server together,
 * end to end, under production fuses.
 *
 *   DOCBLOCKS_E2E_REAL_SPEECH=1
 *   DOCBLOCKS_E2E_WHISPER_MODEL=~/.gezel/engines/whisper-cpp/models/whisper-base.en/ggml-base.en.bin
 *   DOCBLOCKS_E2E_KOKORO_MODEL=<…>/Kokoro-82M-v1.0-ONNX-timestamped/onnx/model_quantized.onnx
 *   DOCBLOCKS_E2E_KOKORO_VOICES=<a directory holding af_heart.bin and the other curated voices>
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './packaged-fixtures.js';

const real = process.env.DOCBLOCKS_E2E_REAL_SPEECH === '1';
const VOICES = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'am_adam',
  'am_michael',
  'bf_emma',
  'bm_george',
  'bm_lewis',
];
const PARAGRAPH =
  'DocBlocks can read your documents aloud. It can also take dictation, so you can write by speaking.';

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Clone where the filesystem allows it, so seeding 240 MB is instant on APFS. */
function seed(userDataDir: string, model: string, files: Record<string, string>): void {
  const dir = path.join(userDataDir, 'speech', 'models', model);
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: model,
      files: Object.entries(files).map(([name, source]) => ({ name, sha256: sha256(source) })),
      installedAt: new Date().toISOString(),
    }),
  );
}

/** Lowercased words without punctuation, for a word error rate. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = words(reference);
  const hyp = words(hypothesis);
  const distance = Array.from({ length: ref.length + 1 }, (_, i) =>
    Array.from({ length: hyp.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= ref.length; i += 1) {
    for (let j = 1; j <= hyp.length; j += 1) {
      distance[i]![j] = Math.min(
        distance[i - 1]![j]! + 1,
        distance[i]![j - 1]! + 1,
        distance[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
  }
  return distance[ref.length]![hyp.length]! / Math.max(1, ref.length);
}

test.describe('real speech engines in the packaged app', () => {
  test.skip(!real, 'Set DOCBLOCKS_E2E_REAL_SPEECH=1 and the model paths to run.');

  test('narrates a paragraph and transcribes it back', async ({
    launchPackagedApp,
    userDataDir,
  }) => {
    const whisper = process.env.DOCBLOCKS_E2E_WHISPER_MODEL ?? '';
    const kokoro = process.env.DOCBLOCKS_E2E_KOKORO_MODEL ?? '';
    const voices = process.env.DOCBLOCKS_E2E_KOKORO_VOICES ?? '';
    seed(userDataDir, 'whisper-base.en', { 'ggml-base.en.bin': whisper });
    seed(userDataDir, 'kokoro-82m-v1.0', {
      'onnx/model_quantized.onnx': kokoro,
      ...Object.fromEntries(
        VOICES.map((voice) => [`voices/${voice}.bin`, path.join(voices, `${voice}.bin`)]),
      ),
    });

    const packaged = await launchPackagedApp();
    await packaged.window.waitForSelector('.db-shell', { timeout: 60_000 });

    const result = await packaged.window.evaluate(async (text) => {
      type Speech = import('@bendyline/docblocks/host').DocBlocksHostSpeechAPI;
      const speech = (globalThis as { docBlocksHost?: { speech?: Speech } }).docBlocksHost?.speech;
      if (!speech?.synthesize || !speech.transcribe) throw new Error('Speech engines missing');
      const status = await speech.status();

      const started = performance.now();
      const chunks: Float32Array[] = [];
      let sampleRate = 24_000;
      const synthesis = await speech.synthesize({ text }, (event) => {
        if (event.kind === 'chunk') {
          chunks.push(new Float32Array(event.chunk.pcm));
          sampleRate = event.chunk.sampleRate;
        }
      }).done;
      if (!synthesis.ok) throw new Error(synthesis.error.message);
      const synthesisMs = performance.now() - started;

      // Resample to 16 kHz mono PCM16 WAV, the format dictation sends.
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const joined = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      const ratio = sampleRate / 16_000;
      const length = Math.floor(joined.length / ratio);
      const wav = new DataView(new ArrayBuffer(44 + length * 2));
      const ascii = (at: number, value: string) =>
        [...value].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
      ascii(0, 'RIFF');
      wav.setUint32(4, 36 + length * 2, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      wav.setUint32(16, 16, true);
      wav.setUint16(20, 1, true);
      wav.setUint16(22, 1, true);
      wav.setUint32(24, 16_000, true);
      wav.setUint32(28, 32_000, true);
      wav.setUint16(32, 2, true);
      wav.setUint16(34, 16, true);
      ascii(36, 'data');
      wav.setUint32(40, length * 2, true);
      for (let i = 0; i < length; i += 1) {
        const sample = Math.max(-1, Math.min(1, joined[Math.floor(i * ratio)] ?? 0));
        wav.setInt16(44 + i * 2, Math.round(sample * 32_767), true);
      }

      const transcribeStarted = performance.now();
      const transcript = await speech.transcribe({ audio: wav.buffer, mimeType: 'audio/wav' });
      if (!transcript.ok) throw new Error(transcript.error.message);
      return {
        status,
        audioSeconds: total / sampleRate,
        synthesisMs,
        transcribeMs: performance.now() - transcribeStarted,
        transcript: transcript.value.text,
      };
    }, PARAGRAPH);

    expect(result.status).toMatchObject({ stt: { state: 'ready' }, tts: { state: 'ready' } });
    expect(result.audioSeconds).toBeGreaterThan(3);
    const wer = wordErrorRate(PARAGRAPH, result.transcript);
    test.info().annotations.push({
      type: 'speech',
      description: `${result.audioSeconds.toFixed(1)} s audio · synth ${Math.round(result.synthesisMs)} ms · transcribe ${Math.round(result.transcribeMs)} ms · WER ${wer.toFixed(2)} · "${result.transcript}"`,
    });
    expect(wer).toBeLessThan(0.25);
    await packaged.close();
  });
});
