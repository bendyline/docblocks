import { expect } from 'chai';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APPLE_MODEL_ID,
  appleModelEntry,
  parseAppleModelHello,
} from '../main/ai/gezel-apple-model.js';
import { selectModel, toAiModelList } from '../main/ai/ai-models.js';
import { parseAiModelInfoList } from '@bendyline/docblocks/host';

const hello = {
  type: 'hello',
  version: '2',
  os: 'macOS 27',
  available: true,
  contextTokens: 4096,
  maxOutputTokens: 1024,
};

describe('Apple native AI readiness', () => {
  it('offers the system model as local without installing weights', () => {
    const models = toAiModelList([parseAppleModelHello(hello)]);
    expect(models[0]).to.deep.include({
      id: APPLE_MODEL_ID,
      label: 'Apple Intelligence',
      local: true,
      availability: 'available',
      contextWindow: 4096,
      isDefault: true,
    });
    expect(parseAiModelInfoList(models)).to.deep.equal(models);
  });

  it('shows system readiness failures without selecting an unavailable model', () => {
    const models = toAiModelList([
      parseAppleModelHello({
        ...hello,
        available: false,
        reason: 'Enable Apple Intelligence in System Settings.',
      }),
      { id: 'llama-cpp:writer' },
    ]);
    expect(models[0].unavailableReason).to.equal('Enable Apple Intelligence in System Settings.');
    expect(models[0].isDefault).to.equal(false);
    expect(selectModel(models, APPLE_MODEL_ID)?.id).to.equal('llama-cpp:writer');
    expect(selectModel(models.slice(0, 1), APPLE_MODEL_ID)).to.equal(null);
    expect(parseAiModelInfoList(models)).to.deep.equal(models);
  });

  it('rejects malformed, oversized and unexpected readiness payloads', () => {
    for (const value of [
      null,
      { ...hello, available: 'true' },
      { ...hello, contextTokens: -1 },
      { ...hello, reason: 'x'.repeat(2001) },
      { ...hello, unexpected: true },
      { ...hello, modelCapabilities: { arbitrary: true } },
    ]) {
      expect(() => parseAppleModelHello(value)).to.throw();
    }
  });

  it('bounds helper output, closes stdin after hello and kills a cancelled probe', async function () {
    if (process.platform === 'win32') this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-apple-probe-'));
    try {
      await mkdir(path.join(root, 'darwin-arm64'));
      const helper = path.join(root, 'darwin-arm64', 'gezel-apple-fm');
      await writeFile(
        helper,
        `#!/bin/sh\nread request\nprintf '%s\\n' '${JSON.stringify(hello)}'\ncat >/dev/null\n`,
        { mode: 0o755 },
      );
      expect((await appleModelEntry(root)).availability).to.equal('available');
      await writeFile(
        helper,
        '#!/bin/sh\nwhile true; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done\n',
      );
      expect((await appleModelEntry(root)).unavailable_reason).to.contain('limit');
      await writeFile(helper, '#!/bin/sh\nread request\nread next\n');
      const controller = new AbortController();
      const probe = appleModelEntry(root, controller.signal);
      controller.abort();
      expect((await probe).availability).to.equal('unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
