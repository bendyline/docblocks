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
  const pending = new Map<string, { ref: string; promise: Promise<string> }>();
  const generations = new Map<string, number>();
  let disposed = false;

  function toKey(ref: string): string {
    const clean = ref.replace(/^\/+/, '');
    return clean.startsWith(prefix) ? clean : prefix + clean;
  }

  function invalidate(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1);
    pending.delete(key);
    const cached = blobUrlCache.get(key);
    if (cached) URL.revokeObjectURL(cached);
    blobUrlCache.delete(key);
  }

  function resolveUrl(ref: string): Promise<string> {
    if (disposed) return Promise.resolve(ref);
    const key = toKey(ref);
    const cached = blobUrlCache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = pending.get(key);
    if (existing) {
      // Equivalent paths share I/O, but absence must return each caller's
      // original reference rather than the spelling used by the first caller.
      return existing.promise.then((url) => (url === existing.ref ? ref : url));
    }
    const generation = generations.get(key) ?? 0;
    const work = (async () => {
      const data = await container.readFile(key);
      if (disposed) return ref;
      if ((generations.get(key) ?? 0) !== generation) return resolveUrl(ref);
      const entries = data ? await container.listFiles() : [];
      if (disposed) return ref;
      if ((generations.get(key) ?? 0) !== generation) return resolveUrl(ref);
      if (!data) return ref;
      const entry = entries.find((e) => e.path === key);
      const mimeType = entry?.mimeType ?? 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
      blobUrlCache.set(key, url);
      return url;
    })().finally(() => {
      if (pending.get(key)?.promise === work) pending.delete(key);
    });
    pending.set(key, { ref, promise: work });
    return work;
  }

  return {
    resolveUrl,

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
      invalidate(key);
      const generation = generations.get(key);
      const buffer = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
      await container.writeFile(key, buffer, mimeType);
      const canCacheUpload = generations.get(key) === generation;
      invalidate(key);
      // The bytes and MIME are already in hand. Display the durable upload
      // directly, without reading it back and recursively listing the workspace.
      if (!disposed && canCacheUpload) {
        const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer).slice().buffer : buffer;
        blobUrlCache.set(key, URL.createObjectURL(new Blob([bytes], { type: mimeType })));
      }
      return key;
    },

    async removeMedia(ref: string): Promise<void> {
      const key = toKey(ref);
      invalidate(key);
      await container.removeFile(key);
      invalidate(key);
    },

    dispose(): void {
      disposed = true;
      pending.clear();
      for (const url of blobUrlCache.values()) {
        URL.revokeObjectURL(url);
      }
      blobUrlCache.clear();
    },
  };
}
