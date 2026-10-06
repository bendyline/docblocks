import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SPEECH_PREFERENCES,
  SpeechPreferenceStore,
} from '../main/speech/speech-preferences.js';

describe('SpeechPreferenceStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-speech-prefs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts from defaults and persists patches', async () => {
    const file = path.join(root, 'speech', 'preferences.json');
    const store = new SpeechPreferenceStore(file);
    expect(await store.get()).to.deep.equal(DEFAULT_SPEECH_PREFERENCES);
    await store.set({ voice: 'bf_emma' });
    await store.set({ speed: 1.25 });
    expect(JSON.parse(await readFile(file, 'utf8'))).to.deep.equal({
      sttModel: null,
      voice: 'bf_emma',
      speed: 1.25,
    });
    expect(await new SpeechPreferenceStore(file).get()).to.deep.equal({
      sttModel: null,
      voice: 'bf_emma',
      speed: 1.25,
    });
  });

  it('falls back to defaults for a corrupt or foreign file', async () => {
    const file = path.join(root, 'preferences.json');
    await writeFile(file, '{"speed": 9, "extra": true}');
    expect(await new SpeechPreferenceStore(file).get()).to.deep.equal(DEFAULT_SPEECH_PREFERENCES);
    await writeFile(file, 'not json');
    expect(await new SpeechPreferenceStore(file).get()).to.deep.equal(DEFAULT_SPEECH_PREFERENCES);
  });
});
