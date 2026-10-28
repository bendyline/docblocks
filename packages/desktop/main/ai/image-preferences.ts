import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiImagePreferences, AiImagePreferencesPatch } from '@bendyline/docblocks/host';
import { parseAiImagePreferences } from '@bendyline/docblocks/host';

/**
 * Image preferences live in their own file rather than in `settings.json`.
 * The settings parser rejects unknown keys, so an older or downgraded build
 * would quarantine the whole settings file — losing the person's workspaces —
 * the moment an image key appeared in it. Speech keeps its own file for the
 * same reason.
 */

export const DEFAULT_IMAGE_PREFERENCES: AiImagePreferences = Object.freeze({
  model: null,
  designModel: null,
  aspect: '1:1',
});

export class ImagePreferenceStore {
  private current: AiImagePreferences | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async get(): Promise<AiImagePreferences> {
    if (this.current) return this.current;
    try {
      this.current =
        parseAiImagePreferences(JSON.parse(await readFile(this.file, 'utf8'))) ??
        DEFAULT_IMAGE_PREFERENCES;
    } catch {
      // Missing or unreadable: defaults. A corrupt file is rewritten on the next set.
      this.current = DEFAULT_IMAGE_PREFERENCES;
    }
    return this.current;
  }

  /** Apply an already-validated patch; writes are serialized and atomic. */
  async set(patch: AiImagePreferencesPatch): Promise<AiImagePreferences> {
    const next: AiImagePreferences = { ...(await this.get()), ...patch };
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
