/**
 * Speech fixtures for the desktop e2e: a catalog of tiny stand-in model files,
 * preinstalled into the app's speech store so no test downloads anything, and
 * a WAV for Chromium's fake microphone.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const FILES = {
  'whisper-base.en': { 'ggml-base.en.bin': Buffer.from('fake whisper weights') },
  'kokoro-82m-v1.0': {
    'onnx/model_quantized.onnx': Buffer.from('fake kokoro model'),
    'voices/af_heart.bin': Buffer.from('fake voice'),
  },
} as const;

/**
 * Write the catalog the app reads from DOCBLOCKS_SPEECH_CATALOG, and install
 * every model into `<userData>/speech/models` the way a finished download
 * leaves it. Returns the environment to launch with.
 */
export function installFakeSpeechModels(
  userDataDir: string,
  options: { installed?: boolean } = {},
): NodeJS.ProcessEnv {
  const catalog = Object.entries(FILES).map(([id, files]) => ({
    id,
    kind: id.startsWith('whisper') ? 'stt' : 'tts',
    label: id.startsWith('whisper') ? 'Whisper Base (English)' : 'Kokoro (English voices)',
    description: 'Stand-in model for tests.',
    recommended: true,
    license: 'MIT',
    licenseUrl: 'https://example.invalid/license',
    files: Object.entries(files).map(([name, data]) => ({
      name,
      url: `https://example.invalid/${name}`,
      sha256: sha256(data),
      size: data.length,
    })),
  }));
  const catalogFile = path.join(userDataDir, 'fake-speech-catalog.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  if (options.installed !== false) {
    for (const entry of catalog) {
      const dir = path.join(userDataDir, 'speech', 'models', entry.id);
      for (const [name, data] of Object.entries(FILES[entry.id as keyof typeof FILES])) {
        const file = path.join(dir, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
      }
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          id: entry.id,
          files: entry.files.map(({ name, sha256: hash }) => ({ name, sha256: hash })),
          installedAt: new Date().toISOString(),
        }),
      );
    }
  }
  return { DOCBLOCKS_SPEECH_CATALOG: catalogFile };
}

/**
 * A 16-bit mono WAV for --use-file-for-fake-audio-capture: bursts of a voiced
 * tone separated by silence, loud enough to open the dictation voice gate and
 * with pauses long enough to end each phrase.
 */
export function writeFakeMicrophoneWav(file: string): string {
  const rate = 16000;
  const pattern = [
    { seconds: 1.2, amplitude: 0.35 },
    { seconds: 0.8, amplitude: 0 },
  ];
  const samples: number[] = [];
  for (let repeat = 0; repeat < 4; repeat += 1) {
    for (const { seconds, amplitude } of pattern) {
      for (let i = 0; i < seconds * rate; i += 1) {
        const voiced =
          Math.sin((2 * Math.PI * 180 * i) / rate) + 0.5 * Math.sin((2 * Math.PI * 360 * i) / rate);
        samples.push(amplitude * voiced * 0.66);
      }
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) =>
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * 2),
  );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}
