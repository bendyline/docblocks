import { expect } from 'chai';
import {
  parseAiImageAccess,
  parseAiImageEvent,
  parseAiImageInstallEvent,
  parseAiImageModelList,
  parseAiImagePreferences,
  parseAiImagePreferencesPatch,
  parseAiImageRequest,
} from '../src/host/ai-images.js';
import { deriveHostCapabilities } from '../src/host/capabilities.js';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4,
  0,
]);

const ming = {
  id: 'sd-cpp:ming-image-0.1-design-bf16',
  label: 'Ming Image 0.1 Design (BF16)',
  description: 'Posters, infographics and text-rich designs.',
  state: 'download-required',
  downloadBytes: 49_243_658_314,
  shared: false,
  license: 'MIT',
  commercialUse: true,
  rendersText: true,
  promptStyle: 'sentences',
  hardwareTier: 'workstation',
  minRamGb: 96,
  fit: { verdict: 'wont-run', reason: 'This computer has too little memory.' },
};

describe('AI image wire policy', () => {
  it('accepts every access state and rejects unknown ones', () => {
    for (const access of [
      { kind: 'ready' },
      { kind: 'needs-approval' },
      { kind: 'awaiting-approval', verificationCode: 'ABC-123' },
      { kind: 'awaiting-approval', verificationCode: null },
      { kind: 'provider-outdated' },
      { kind: 'unavailable', reason: 'graphics-driver', message: 'Update your graphics driver.' },
    ])
      expect(parseAiImageAccess(access)).to.deep.equal(access);
    for (const access of [
      { kind: 'ready', token: 'secret' },
      { kind: 'unavailable', reason: 'quota', message: '' },
      { kind: 'awaiting-approval', verificationCode: 'X'.repeat(64) },
      null,
    ])
      expect(parseAiImageAccess(access)).to.equal(null);
  });

  it('accepts the exact model list and rejects duplicates, extra fields and bad verdicts', () => {
    expect(parseAiImageModelList([ming])).to.deep.equal([ming]);
    expect(parseAiImageModelList([ming, ming])).to.equal(null);
    expect(parseAiImageModelList([{ ...ming, path: 'C:/models' }])).to.equal(null);
    expect(parseAiImageModelList([{ ...ming, fit: { verdict: 'maybe', reason: '' } }])).to.equal(
      null,
    );
    expect(parseAiImageModelList([{ ...ming, hardwareTier: 'datacenter' }])).to.equal(null);
    expect(parseAiImageModelList(Array(257).fill(ming))).to.equal(null);
  });

  it('accepts preferences and patches, never extra keys', () => {
    const prefs = { model: 'sd-cpp:flux-2-klein-4b-q4', designModel: null, aspect: '16:9' };
    expect(parseAiImagePreferences(prefs)).to.deep.equal(prefs);
    expect(parseAiImagePreferences({ ...prefs, aspect: '5:1' })).to.equal(null);
    expect(parseAiImagePreferencesPatch({ designModel: ming.id })).to.deep.equal({
      designModel: ming.id,
    });
    expect(parseAiImagePreferencesPatch({ enabled: true })).to.equal(null);
  });

  it('bounds a render request', () => {
    expect(parseAiImageRequest({ prompt: 'A lighthouse', aspect: '4:3', seed: 7 })).to.deep.equal({
      prompt: 'A lighthouse',
      aspect: '4:3',
      seed: 7,
    });
    for (const request of [
      { prompt: '   ' },
      { prompt: 'x'.repeat(4001) },
      { prompt: 'ok', width: 4096 },
      { prompt: 'ok', seed: -1 },
      { prompt: 'ok', aspect: '2:1' },
    ])
      expect(parseAiImageRequest(request)).to.equal(null);
  });

  it('copies a finished PNG and refuses bytes that are not one', () => {
    const image = {
      mimeType: 'image/png',
      data: PNG,
      width: 1024,
      height: 1024,
      seed: 7,
      model: 'sd-cpp:flux-2-klein-4b-q4',
      durationMs: 12_100,
    };
    const parsed = parseAiImageEvent({ kind: 'done', image });
    if (parsed?.kind !== 'done') throw new Error('expected a done event');
    expect(parsed.image.data).to.be.instanceOf(ArrayBuffer);
    expect(new Uint8Array(parsed.image.data)).to.deep.equal(PNG);
    const notPng = Uint8Array.from(PNG);
    notPng[1] = 0;
    expect(parseAiImageEvent({ kind: 'done', image: { ...image, data: notPng } })).to.equal(null);
    expect(
      parseAiImageEvent({
        kind: 'progress',
        progress: { phase: 'sampling', step: 2, totalSteps: 4, secondsPerStep: 1.8 },
      }),
    ).to.deep.equal({
      kind: 'progress',
      progress: { phase: 'sampling', step: 2, totalSteps: 4, secondsPerStep: 1.8 },
    });
    expect(
      parseAiImageEvent({
        kind: 'progress',
        progress: { phase: 'thinking', step: 0, totalSteps: 0, secondsPerStep: null },
      }),
    ).to.equal(null);
    expect(
      parseAiImageEvent({ kind: 'error', error: { code: 'cancelled', message: 'Stopped' } }),
    ).to.deep.equal({ kind: 'error', error: { code: 'cancelled', message: 'Stopped' } });
  });

  it('parses install events carrying image models', () => {
    expect(parseAiImageInstallEvent({ kind: 'done', model: ming })).to.deep.equal({
      kind: 'done',
      model: ming,
    });
    expect(parseAiImageInstallEvent({ kind: 'done', model: { ...ming, id: '' } })).to.equal(null);
  });

  it('claims image generation only when the bridge offers generate', () => {
    const host = (images: unknown) => ({
      env: {
        surface: 'electron',
        surfaceLabel: 'Desktop',
        platform: 'win32',
        appVersion: '1.0.0',
        isDev: false,
      },
      ai: { images },
    });
    expect(deriveHostCapabilities(host({ generate: () => undefined })).aiImages).to.equal(true);
    expect(deriveHostCapabilities(host({ models: () => undefined })).aiImages).to.equal(false);
    expect(deriveHostCapabilities(host(undefined)).aiImages).to.equal(false);
  });
});
