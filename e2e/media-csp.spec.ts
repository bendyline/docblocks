import { expect, test } from '@playwright/test';

test('loads locally generated Blob media under the site CSP', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const sampleCount = 800;
    const sampleRate = 8_000;
    const wav = new ArrayBuffer(44 + sampleCount);
    const view = new DataView(wav);
    const writeAscii = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + sampleCount, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeAscii(36, 'data');
    view.setUint32(40, sampleCount, true);
    new Uint8Array(wav, 44).fill(128);

    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio = new Audio();
    audio.preload = 'metadata';
    try {
      const fetchedBytes = (await (await fetch(url)).arrayBuffer()).byteLength;
      return await new Promise<{ duration: number; error: string | null; fetchedBytes: number }>(
        (resolve) => {
          let settled = false;
          const finish = (value: { duration: number; error: string | null }) => {
            if (settled) return;
            settled = true;
            resolve({ ...value, fetchedBytes });
          };
          audio.addEventListener(
            'loadedmetadata',
            () => finish({ duration: audio.duration, error: null }),
            { once: true },
          );
          audio.addEventListener(
            'error',
            () =>
              finish({
                duration: 0,
                error: audio.error ? `${audio.error.code}:${audio.error.message}` : 'media error',
              }),
            { once: true },
          );
          setTimeout(() => finish({ duration: 0, error: 'metadata timeout' }), 5_000);
          audio.src = url;
          audio.load();
        },
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  expect(result.error).toBeNull();
  expect(result.duration).toBeGreaterThan(0);
  expect(result.fetchedBytes).toBe(844);
});
