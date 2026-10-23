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
 *   • Types resolved URLs by file extension, as the workspace containers do
 *   • Optionally falls back, read-only, to a reference as Markdown written
 *     elsewhere spells it (`shots/a.png` beside the document) when the
 *     sidecar holds no such file
 */

import type { MediaProvider, MediaEntry } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { guessMimeType } from './internal/mime.js';

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export interface FileMediaProviderOptions {
  /**
   * Read a reference the sidecar does not hold, relative to the document
   * rather than to its sidecar. Receives the reference as written and
   * resolves null when nothing is there. Never consulted for writes, and a
   * failure counts as absence: the fallback can only add resolutions.
   */
  readonly readDocumentRelative?: (ref: string) => Promise<ArrayBuffer | null>;
}

export function createFileMediaProvider(
  container: ContentContainer,
  markdownBasename: string,
  options: FileMediaProviderOptions = {},
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

  /**
   * Where a reference's document-relative resolution is cached: apart from
   * the sidecar file it shares a key with, so `notes_files/a.png` never
   * displays what `a.png` found beside the document.
   */
  function fallbackSlot(key: string): string {
    return '\0' + key;
  }

  function invalidate(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1);
    // A sidecar write supersedes whatever the document-relative read found.
    for (const slot of [key, fallbackSlot(key)]) {
      pending.delete(slot);
      const cached = blobUrlCache.get(slot);
      if (cached) URL.revokeObjectURL(cached);
      blobUrlCache.delete(slot);
    }
  }

  function resolveUrl(ref: string): Promise<string> {
    if (disposed) return Promise.resolve(ref);
    const key = toKey(ref);
    const readDocumentRelative = options.readDocumentRelative;
    // A rooted reference, or one that already names the sidecar, has no other
    // home. Every caller sharing a fallback slot therefore spells it alike.
    if (!readDocumentRelative || ref.startsWith('/') || ref.startsWith(prefix)) {
      return resolveSlot(ref, key, key, () => container.readFile(key));
    }
    const found = blobUrlCache.get(key) ?? blobUrlCache.get(fallbackSlot(key));
    if (found) return Promise.resolve(found);
    const resolveFallback = () =>
      resolveSlot(ref, key, fallbackSlot(key), () =>
        // The fallback can only add resolutions, never new failures.
        readDocumentRelative(ref).catch(() => null),
      );
    // `./shots/a.png` or `../shared/a.png` cannot name a file in the sidecar.
    if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
      return resolveFallback();
    }
    return resolveSlot(ref, key, key, () => container.readFile(key)).then((url) =>
      url !== ref || disposed ? url : resolveFallback(),
    );
  }

  function resolveSlot(
    ref: string,
    key: string,
    slot: string,
    read: () => Promise<ArrayBuffer | null>,
  ): Promise<string> {
    const cached = blobUrlCache.get(slot);
    if (cached) return Promise.resolve(cached);
    const existing = pending.get(slot);
    if (existing) {
      // Equivalent paths share I/O, but absence must return each caller's
      // original reference rather than the spelling used by the first caller.
      return existing.promise.then((url) => (url === existing.ref ? ref : url));
    }
    const generation = generations.get(key) ?? 0;
    const work = (async () => {
      const data = await read();
      if (disposed) return ref;
      if ((generations.get(key) ?? 0) !== generation) return resolveUrl(ref);
      if (!data) return ref;
      // Derive the MIME from the path. Listing the container for it walked
      // the whole workspace once per media reference.
      const url = URL.createObjectURL(new Blob([data], { type: guessMimeType(key) }));
      blobUrlCache.set(slot, url);
      return url;
    })().finally(() => {
      if (pending.get(slot)?.promise === work) pending.delete(slot);
    });
    pending.set(slot, { ref, promise: work });
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
