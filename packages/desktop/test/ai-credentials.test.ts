import { expect } from 'chai';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EncryptedFileCredentialStore,
  type CredentialEncryption,
} from '../main/ai/ai-credentials.js';
import {
  aiPreferencesFromSettings,
  aiSettingsFromPreferences,
  createSettingsAiPreferenceStore,
} from '../main/ai/ai-preferences.js';
import { parseSettings, type Settings } from '../main/settings-schema.js';

/** Reversible stand-in for safeStorage: the file must never hold the token as-is. */
function fakeEncryption(available = true): CredentialEncryption {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString('base64')}`),
    decryptString: (sealed) => {
      const text = sealed.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('Cannot decrypt');
      return Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

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

  it('round-trips an encrypted token across instances', async () => {
    await new EncryptedFileCredentialStore(filePath, fakeEncryption()).save('gzt_abc123');
    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk).to.not.include('gzt_abc123');
    expect(await new EncryptedFileCredentialStore(filePath, fakeEncryption()).load()).to.equal(
      'gzt_abc123',
    );
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).to.equal(0o600);
    }
  });

  it('keeps the token in memory only when encryption is unavailable', async () => {
    const store = new EncryptedFileCredentialStore(filePath, fakeEncryption(false));
    await store.save('gzt_abc123');
    expect(await store.load()).to.equal('gzt_abc123');
    let written = true;
    await stat(filePath).catch(() => {
      written = false;
    });
    expect(written).to.equal(false);
    expect(await new EncryptedFileCredentialStore(filePath, fakeEncryption(false)).load()).to.equal(
      null,
    );
  });

  it('treats an unreadable or foreign file as not connected', async () => {
    const store = new EncryptedFileCredentialStore(filePath, fakeEncryption());
    expect(await store.load()).to.equal(null);

    await new EncryptedFileCredentialStore(filePath, fakeEncryption()).save('gzt_abc123');
    await writeFile(filePath, 'written by something else');
    expect(await new EncryptedFileCredentialStore(filePath, fakeEncryption()).load()).to.equal(
      null,
    );
  });

  it('refuses a malformed token and forgets on delete', async () => {
    const store = new EncryptedFileCredentialStore(filePath, fakeEncryption());
    let refused = false;
    await store.save('has whitespace').catch(() => {
      refused = true;
    });
    expect(refused).to.equal(true);

    await store.save('gzt_abc123');
    await store.delete();
    expect(await store.load()).to.equal(null);
    expect(await new EncryptedFileCredentialStore(filePath, fakeEncryption()).load()).to.equal(
      null,
    );
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
