import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechPreferences, SpeechPreferencesPatch } from '@bendyline/docblocks/host';
import { parseSpeechPreferences } from '@bendyline/docblocks/host';

/**
 * Speech preferences live in their own file rather than in `settings.json`.
 * The settings parser rejects unknown top-level keys, so an older or
 * downgraded build would quarantine the whole settings file the moment a
 * `speech` key appeared in it. A separate file keeps that failure mode away
 * from everything else the user has configured.
 */

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = Object.freeze({
  sttModel: null,
  voice: null,
  speed: 1,
});

export class SpeechPreferenceStore {
  private current: SpeechPreferences | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async get(): Promise<SpeechPreferences> {
    if (this.current) return this.current;
    try {
      this.current =
        parseSpeechPreferences(JSON.parse(await readFile(this.file, 'utf8'))) ??
        DEFAULT_SPEECH_PREFERENCES;
    } catch {
      // Missing or unreadable: defaults. A corrupt file is rewritten on the next set.
      this.current = DEFAULT_SPEECH_PREFERENCES;
    }
    return this.current;
  }

  /** Apply an already-validated patch; writes are serialized and atomic. */
  async set(patch: SpeechPreferencesPatch): Promise<SpeechPreferences> {
    const next: SpeechPreferences = { ...(await this.get()), ...patch };
    this.current = next;
    const write = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
      await rename(`${this.file}.tmp`, this.file);
    });
    this.writes = write.catch(() => undefined);
    await write;
    return next;
  }
}
