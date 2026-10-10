/**
 * A stand-in for the narration utility process (`kokoro-utility.cjs`) that
 * speaks the same protocol but answers each sentence with a short tone, so the
 * desktop e2e exercises the real utilityProcess, IPC and renderer path without
 * downloading Kokoro.
 */
const SAMPLE_RATE = 24000;

function tone(seconds) {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  }
  return samples;
}

const port = process.parentPort;
port.on('message', ({ data }) => {
  if (data.type === 'cancel') return;
  if (data.type === 'prepare') {
    port.postMessage({ type: 'done', id: data.id, durationSec: 0, chunks: 0 });
    return;
  }
  let index = 0;
  let duration = 0;
  for (const match of data.text.matchAll(/[^.!?…]+[.!?…]*/gu)) {
    const text = match[0].trim();
    if (!text) continue;
    const start = match.index + match[0].indexOf(text);
    const seconds = Math.min(4, 0.15 + text.length * 0.04);
    const pcm = tone(seconds);
    port.postMessage({
      type: 'chunk',
      id: data.id,
      index,
      pcm,
      sampleRate: SAMPLE_RATE,
      durationSec: seconds,
      textStart: start,
      textEnd: start + text.length,
      wordTimings: [...text.matchAll(/\S+/gu)].map((word, wordIndex, words) => ({
        textStart: start + word.index,
        textEnd: start + word.index + word[0].length,
        startSec: 0.1 + ((seconds - 0.1) * wordIndex) / words.length,
        endSec: Math.min(seconds, 0.1 + ((seconds - 0.1) * (wordIndex + 1)) / words.length),
      })),
    });
    index += 1;
    duration += seconds;
  }
  port.postMessage({ type: 'done', id: data.id, durationSec: duration, chunks: index });
});
