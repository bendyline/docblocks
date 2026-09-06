/**
 * import-files — the drag-and-drop import pipeline.
 *
 * Extracted from `DocBlocksShell` so the collision and failure behaviour is
 * testable without standing up the whole shell.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **An import never destroys an existing document.** Dropping `report.docx`
 *     into a workspace that already holds `report.md` used to overwrite it
 *     outright -- no prompt, no undo. Every write here goes through
 *     `mode: 'create'`, and a collision moves the import aside to
 *     `report (2).md` instead of asking. A drop is a bulk, low-ceremony
 *     gesture: N modal confirmations would be worse than the disease, and the
 *     OS file managers and every browser's download flow already train users
 *     to expect the numbered-suffix behaviour. Nothing is lost either way, and
 *     an unwanted extra file is one delete away -- an overwritten document is
 *     gone for good.
 *  2. **Accepted files keep their bytes and names.** Rendered document formats
 *     become outside-in documents, DBK bundles keep their document-aware
 *     handling, and ordinary text/source/image files are copied byte-for-byte.
 *  3. **A failed or unsupported import is reported.** Failures used to be `console.error`-only,
 *     so a bad drop looked identical to no drop at all. Each file is isolated:
 *     one failure never aborts the rest of the batch, and the caller receives
 *     everything it needs to tell the user what happened.
 */

import type { DbkWorkspaceSnapshot, FileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  FsError,
  getFileSystemProviderV2,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';
import { decodeDbkWorkspace } from './dbk-import.js';
import { importOutsideInDocument, resolveOutsideInLayout } from './outside-in-contract.js';
import { providerEntryExists, removeProviderEntry, writeProviderText } from './provider-io.js';
import {
  BUNDLE_IMPORT_EXTENSIONS,
  extensionOfFileName,
  isSupportedImportFile,
  OUTSIDE_IN_IMPORT_EXTENSIONS,
} from './import-file-types.js';

export interface ImportedDocument {
  /** The dropped file's original name, e.g. `report.docx`. */
  source: string;
  /** The user-facing path actually written, e.g. `report (2).docx`. */
  path: string;
  /** True when a name collision moved this import aside. */
  renamed: boolean;
}

export interface ImportFailure {
  source: string;
  message: string;
}

export interface ImportFilesResult {
  imported: ImportedDocument[];
  failed: ImportFailure[];
  /** Dropped files with an extension the importer does not handle. */
  unsupported: string[];
}

/** Bounded so a pathological workspace cannot spin here forever. */
const MAX_NAME_ATTEMPTS = 100;

function withCopySuffix(path: string, n: number): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash + 1) return `${path} (${n})`;
  return `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof FsError && error.code === 'already-exists';
}

/**
 * Reserve a free path by *writing* an empty file with `mode: 'create'`, walking
 * `name.md` -> `name (2).md` -> ... until one sticks.
 *
 * Claiming rather than probing with `stat` is deliberate: the name has to be
 * final before the converters run (a `.dbk` snapshot and the `_files/` media
 * folder are both keyed off the document path), and `create` is the only check
 * that cannot lose a race with a concurrent import of the same filename.
 */
async function claimAvailablePath(
  provider: FileSystemProvider,
  desiredPath: string,
): Promise<{ path: string; renamed: boolean }> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? desiredPath : withCopySuffix(desiredPath, attempt);
    try {
      await writeProviderText(provider, candidate, '', 'create');
      return { path: candidate, renamed: attempt > 1 };
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error(`Too many documents are already named like “${desiredPath}”.`);
}

async function writeProviderBytes(
  provider: FileSystemProvider,
  path: string,
  data: ArrayBuffer | Uint8Array,
  mode: 'create' | 'upsert',
): Promise<void> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    await providerV2.writeFile(parseWorkspacePath(path), data, {
      mode,
      createParents: true,
      expectedVersion: mode === 'create' ? null : undefined,
    });
    return;
  }
  if (mode === 'create' && (await providerEntryExists(provider, path))) {
    throw new FsError('already-exists', 'File already exists.', { operation: 'write', path });
  }
  await provider.writeBinary(path, data);
}

async function claimOutsideInTarget(
  provider: FileSystemProvider,
  desiredPath: string,
): Promise<{ path: string; renamed: boolean }> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? desiredPath : withCopySuffix(desiredPath, attempt);
    const layout = resolveOutsideInLayout(candidate);
    if (!layout) throw new Error(`Outside-in editing does not support “${desiredPath}”.`);
    // A sidecar without its rendered file may contain recoverable user data.
    // Move the new import aside rather than claiming or deleting that folder.
    if (await providerEntryExists(provider, layout.companionDirectory)) continue;
    try {
      await writeProviderBytes(provider, candidate, new Uint8Array(), 'create');
      return { path: candidate, renamed: attempt > 1 };
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error(`Too many documents are already named like “${desiredPath}”.`);
}

async function importOutsideInFile(
  file: File,
  provider: FileSystemProvider,
): Promise<{ path: string; renamed: boolean }> {
  const claim = await claimOutsideInTarget(provider, file.name);
  const created: string[] = [claim.path];
  try {
    const sourceBytes = await file.arrayBuffer();
    const imported = await importOutsideInDocument({
      data: sourceBytes,
      targetPath: claim.path,
    });
    for (const entry of await imported.container.listFiles()) {
      if (/\.md$/i.test(entry.path)) continue;
      const data = await imported.container.readFile(entry.path);
      if (!data) continue;
      const destination = `${imported.layout.companionDirectory}/${entry.path.replace(/^\/+/, '')}`;
      await writeProviderBytes(provider, destination, data, 'create');
      created.push(destination);
    }
    await writeProviderText(provider, imported.layout.markdownPath, imported.markdown, 'create');
    created.push(imported.layout.markdownPath);
    await writeProviderBytes(provider, claim.path, sourceBytes, 'upsert');
    return claim;
  } catch (error: unknown) {
    // Remove only entries this import created; never recursively remove an
    // entire companion directory that another writer could now own.
    for (const path of created.reverse()) {
      await removeProviderEntry(provider, path).catch(() => undefined);
    }
    throw error;
  }
}

async function readImportedMarkdown(
  file: File,
  destPath: string,
  provider: FileSystemProvider,
): Promise<string> {
  const snapshot = await decodeDbkWorkspace(await file.arrayBuffer(), {
    targetDocumentPath: destPath,
  });
  await writeDbkCompanions(snapshot, provider);
  return snapshot.documentContent;
}

/**
 * Write a decoded DBK's *secondary* Markdown alongside the primary document.
 *
 * A `.dbk` is a workspace bundle, not a lone document: it can carry up to 255
 * further Markdown files. `decodeDbkWorkspace` has already rebased them beneath
 * `<document>_files/` -- the default `auto` layout resolves to `companion` here,
 * because a bundle's own primary path never matches the freshly claimed target
 * -- so the snapshot arrives ready to write. Returning only `documentContent`,
 * as this path used to, silently dropped every one of them while reporting the
 * drop as a complete success. (The OS-open path never had this bug: it hands
 * the whole snapshot to `replaceContents`.)
 *
 * `create` mode, like every other write here: a companion landing on a file the
 * user already has is a real conflict, and failing the import loudly beats
 * overwriting it.
 */
async function writeDbkCompanions(
  snapshot: DbkWorkspaceSnapshot,
  provider: FileSystemProvider,
): Promise<void> {
  for (const entry of snapshot.files) {
    // The caller writes the primary itself, onto the path it claimed.
    if (entry.path === snapshot.targetDocumentPath) continue;
    // Workspace DBKs are Markdown-only by contract: createDbkWorkspaceSnapshot
    // fails the whole snapshot on a binary member, so this never skips data.
    if (entry.kind !== 'text') continue;
    await writeProviderText(provider, entry.path, entry.content, 'create');
  }
}

/**
 * Import each supported dropped file without clobbering an existing entry.
 * Rendered formats become outside-in documents; DBK/ZIP bundles become
 * Markdown; ordinary text/source/image files retain their original bytes.
 * Always resolves: per-file failures are collected, not thrown.
 */
export async function importDroppedFiles(
  files: readonly File[],
  provider: FileSystemProvider,
): Promise<ImportFilesResult> {
  const result: ImportFilesResult = { imported: [], failed: [], unsupported: [] };

  for (const file of files) {
    const ext = extensionOfFileName(file.name);
    if (!isSupportedImportFile(file)) {
      result.unsupported.push(file.name);
      continue;
    }

    let claimed: string | null = null;
    try {
      if (OUTSIDE_IN_IMPORT_EXTENSIONS.has(ext)) {
        const imported = await importOutsideInFile(file, provider);
        result.imported.push({ source: file.name, ...imported });
        continue;
      }
      const isBundle = BUNDLE_IMPORT_EXTENSIONS.has(ext);
      const desiredPath = isBundle ? `${file.name.replace(/\.[^.]+$/, '')}.md` : file.name;
      const claim = await claimAvailablePath(provider, desiredPath);
      claimed = claim.path;
      if (isBundle) {
        const markdown = await readImportedMarkdown(file, claim.path, provider);
        await writeProviderText(provider, claim.path, markdown);
      } else {
        await writeProviderBytes(provider, claim.path, await file.arrayBuffer(), 'upsert');
      }
      result.imported.push({ source: file.name, path: claim.path, renamed: claim.renamed });
    } catch (error: unknown) {
      // The placeholder only ever exists to hold the name; a conversion that
      // fails afterwards must not leave an empty document behind.
      if (claimed) {
        await removeProviderEntry(provider, claimed).catch(() => undefined);
      }
      result.failed.push({
        source: file.name,
        message: error instanceof Error ? error.message : 'The file could not be imported.',
      });
    }
  }

  return result;
}

/** Human-readable summary of an import, or `null` when there is nothing to say. */
export function summariseImport(
  result: ImportFilesResult,
): { kind: 'success' | 'error'; message: string } | null {
  const { imported, failed, unsupported } = result;

  const rejectedCount = failed.length + unsupported.length;
  if (rejectedCount > 0) {
    const detail =
      failed.length === 1 && unsupported.length === 0
        ? `Could not import ${failed[0].source} — ${failed[0].message}`
        : unsupported.length === 1 && failed.length === 0
          ? `${unsupported[0]} is not a file type DocBlocks can import.`
          : `Could not import ${rejectedCount} of ${rejectedCount + imported.length} files.`;
    return { kind: 'error', message: detail };
  }

  if (imported.length === 0) {
    return null;
  }

  // Renames are the one success worth narrating: the user dropped `report.docx`
  // and got `report (2).docx`, and silence there looks like the import went
  // somewhere unexpected.
  const renamed = imported.filter((entry) => entry.renamed);
  if (renamed.length === 1) {
    return {
      kind: 'success',
      message: `Imported as ${renamed[0].path} — a document with that name or companion folder already exists.`,
    };
  }
  if (renamed.length > 1) {
    return {
      kind: 'success',
      message: `Imported ${imported.length} files. ${renamed.length} were renamed to avoid replacing existing documents.`,
    };
  }
  return null;
}
