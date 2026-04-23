/**
 * createFileMediaProvider — per-file media storage following the pandoc /
 * Word convention: a markdown file `notes.md` gets a sibling folder
 * `notes_files/` that holds its images, audio, and video.
 *
 * Given:
 *   • `container` — a ContentContainer scoped to the markdown file's
 *     parent directory (so `readFile('notes_files/image.png')` maps to the
 *     parent-relative path)
 *   • `markdownBasename` — e.g. `"notes.md"`
 *
 * Returns a MediaProvider that:
 *   • Writes new media under `{basename}_files/{name}` in the parent dir
 *   • Returns the folder-qualified path (`notes_files/image.png`) from
 *     addMedia so the markdown stays portable outside DocBlocks
 *   • Resolves both bare (`image.png`) and folder-qualified
 *     (`notes_files/image.png`) references — so legacy markdown and
 *     exports from other tools both work
 */

import type { MediaProvider, MediaEntry } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function createFileMediaProvider(
  container: ContentContainer,
  markdownBasename: string,
): MediaProvider {
  const folder = stripExt(markdownBasename) + '_files';
  const prefix = folder + '/';
  const blobUrlCache = new Map<string, string>();

  function toKey(ref: string): string {
    const clean = ref.replace(/^\/+/, '');
    return clean.startsWith(prefix) ? clean : prefix + clean;
  }

  return {
    async resolveUrl(ref: string): Promise<string> {
      const key = toKey(ref);
      const cached = blobUrlCache.get(key);
      if (cached) return cached;

      const data = await container.readFile(key);
      if (!data) return ref;

      const entries = await container.listFiles();
      const entry = entries.find((e) => e.path === key);
      const mimeType = entry?.mimeType ?? 'application/octet-stream';

      const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
      blobUrlCache.set(key, url);
      return url;
    },

    async listMedia(): Promise<MediaEntry[]> {
      const entries = await container.listFiles(prefix);
      return entries
        .filter((e) => !e.path.toLowerCase().endsWith('.md'))
        .map((e) => ({
          name: e.path,
          mimeType: e.mimeType,
          size: e.size,
        }));
    },

    async addMedia(
      name: string,
      data: ArrayBuffer | Blob | Uint8Array,
      mimeType: string,
    ): Promise<string> {
      const key = toKey(name);
      const cached = blobUrlCache.get(key);
      if (cached) {
        URL.revokeObjectURL(cached);
        blobUrlCache.delete(key);
      }
      const buffer = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      await container.writeFile(key, buffer, mimeType);
      return key;
    },

    async removeMedia(ref: string): Promise<void> {
      const key = toKey(ref);
      const cached = blobUrlCache.get(key);
      if (cached) {
        URL.revokeObjectURL(cached);
        blobUrlCache.delete(key);
      }
      await container.removeFile(key);
    },

    dispose(): void {
      for (const url of blobUrlCache.values()) {
        URL.revokeObjectURL(url);
      }
      blobUrlCache.clear();
    },
  };
}
