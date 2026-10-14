import { expect } from 'chai';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OwnerOnlyFileCredentialStore } from '../main/ai/ai-credentials.js';
import {
  aiPreferencesFromSettings,
  aiSettingsFromPreferences,
  createSettingsAiPreferenceStore,
} from '../main/ai/ai-preferences.js';
import { parseSettings, type Settings } from '../main/settings-schema.js';

describe('desktop AI credential store', () => {
  let directory = '';
  let filePath = '';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-ai-credential-'));
    filePath = path.join(directory, 'ai', 'gezel-credential.bin');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('round-trips a token across instances in an owner-only file', async () => {
    await new OwnerOnlyFileCredentialStore(filePath).save('gzt_abc123');
    expect(await readFile(filePath, 'utf8')).to.equal('gzt_abc123');
    expect(await new OwnerOnlyFileCredentialStore(filePath).load()).to.equal('gzt_abc123');
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).to.equal(0o600);
      expect((await stat(path.dirname(filePath))).mode & 0o777).to.equal(0o700);
    }
  });

  it('treats a missing, foreign, or legacy encrypted file as not connected', async () => {
    expect(await new OwnerOnlyFileCredentialStore(filePath).load()).to.equal(null);

    await new OwnerOnlyFileCredentialStore(filePath).save('gzt_abc123');
    for (const contents of [
      'written by something else',
      // safeStorage ciphertext from earlier development builds: never decrypted.
      Buffer.concat([Buffer.from('v10'), Buffer.from([0x00, 0x9f, 0xd2, 0x1b, 0x80, 0x7f])]),
      Buffer.alloc(0),
      'x'.repeat(64 * 1024 + 1),
    ]) {
      await writeFile(filePath, contents);
      expect(await new OwnerOnlyFileCredentialStore(filePath).load()).to.equal(null);
    }
  });

  it('replaces an unusable file on the next connection', async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from([0x76, 0x31, 0x30, 0x00, 0xff]));
    const store = new OwnerOnlyFileCredentialStore(filePath);
    expect(await store.load()).to.equal(null);
    await store.save('gzt_fresh456');
    expect(await new OwnerOnlyFileCredentialStore(filePath).load()).to.equal('gzt_fresh456');
  });

  it('refuses a malformed token and forgets on delete', async () => {
    const store = new OwnerOnlyFileCredentialStore(filePath);
    let refused = false;
    await store.save('has whitespace').catch(() => {
      refused = true;
    });
    expect(refused).to.equal(true);

    await store.save('gzt_abc123');
    await store.delete();
    expect(await store.load()).to.equal(null);
    expect(await new OwnerOnlyFileCredentialStore(filePath).load()).to.equal(null);
  });
});

describe('desktop AI preferences in settings', () => {
  it('parses the persisted block and rejects anything else', () => {
    expect(
      parseSettings({
        workspaces: [],
        ai: { enabled: true, model: 'llama-cpp:qwen3-4b', reviewMode: 'implicit' },
      }).ai,
    ).to.deep.equal({ enabled: true, model: 'llama-cpp:qwen3-4b', reviewMode: 'implicit' });
    expect(parseSettings({ workspaces: [], ai: { enabled: false } }).ai).to.deep.equal({
      enabled: false,
    });

    for (const ai of [
      {},
      { enabled: 'yes' },
      { enabled: true, model: '' },
      { enabled: true, reviewMode: 'always' },
      { enabled: true, token: 'never stored here' },
    ]) {
      expect(() => parseSettings({ workspaces: [], ai }), JSON.stringify(ai)).to.throw(
        /Invalid desktop settings/u,
      );
    }
  });

  it('maps between settings and preferences, defaulting to opted out', () => {
    expect(aiPreferencesFromSettings({})).to.deep.equal({
      enabled: false,
      model: null,
      reviewMode: 'explicit',
    });
    const preferences = { enabled: true, model: null, reviewMode: 'off' } as const;
    expect(aiSettingsFromPreferences(preferences)).to.deep.equal({
      enabled: true,
      reviewMode: 'off',
    });
    expect(aiPreferencesFromSettings({ ai: aiSettingsFromPreferences(preferences) })).to.deep.equal(
      preferences,
    );
  });

  it('writes through the settings file without disturbing other settings', async () => {
    let current: Settings = { workspaces: [], iCloudPromptShown: true };
    const store = createSettingsAiPreferenceStore({
      read: async () => current,
      update: async (update) => {
        const draft: Settings = { ...current, workspaces: [...current.workspaces] };
        current = update(draft) ?? draft;
        return current;
      },
    });
    await store.write({ enabled: true, model: 'gezel:writer', reviewMode: 'explicit' });
    expect(current).to.deep.equal({
      workspaces: [],
      iCloudPromptShown: true,
      ai: { enabled: true, model: 'gezel:writer', reviewMode: 'explicit' },
    });
    expect(parseSettings(current)).to.deep.equal(current);
    expect(await store.read()).to.deep.equal({
      enabled: true,
      model: 'gezel:writer',
      reviewMode: 'explicit',
    });
  });
});
