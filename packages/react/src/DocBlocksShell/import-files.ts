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
 *  2. **A failed import is reported.** Failures used to be `console.error`-only,
 *     so a bad drop looked identical to no drop at all. Each file is isolated:
 *     one failure never aborts the rest of the batch, and the caller receives
 *     everything it needs to tell the user what happened.
 */

import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FsError } from '@bendyline/docblocks/filesystem';
import { decodeDbkWorkspace } from './dbk-import.js';
import { removeProviderEntry, writeProviderText } from './provider-io.js';

/** The shape `docxToContainer` / `pdfToContainer` results expose to the shell. */
export interface ImportedMediaSource {
  listFiles(): Promise<Array<{ path: string; mimeType: string }>>;
  readFile(path: string): Promise<ArrayBuffer | null>;
}

export interface ImportFilesDeps {
  /** Copy a converted container's media into `<path minus ext>_files/`. */
  persistMedia: (source: ImportedMediaSource, path: string) => Promise<void>;
}

export interface ImportedDocument {
  /** The dropped file's original name, e.g. `report.docx`. */
  source: string;
  /** The path actually written, e.g. `report (2).md`. */
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

async function readImportedMarkdown(
  file: File,
  ext: string,
  destPath: string,
  provider: FileSystemProvider,
  deps: ImportFilesDeps,
): Promise<string> {
  if (ext === '.md' || ext === '.txt') {
    return file.text();
  }
  if (ext === '.docx') {
    const { docxToContainer } = await import('@bendyline/squisq-formats/docx');
    const container = await docxToContainer(await file.arrayBuffer());
    const markdown = (await container.readDocument()) ?? '';
    await deps.persistMedia(container, destPath);
    return markdown;
  }
  if (ext === '.pdf') {
    const { pdfToContainer } = await import('@bendyline/squisq-formats/pdf');
    const container = await pdfToContainer(await file.arrayBuffer());
    const markdown = (await container.readDocument()) ?? '';
    await deps.persistMedia(container, destPath);
    return markdown;
  }
  const snapshot = await decodeDbkWorkspace(await file.arrayBuffer(), {
    targetDocumentPath: destPath,
  });
  return snapshot.documentContent;
}

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.docx', '.pdf', '.dbk', '.zip']);

/**
 * Import each dropped file as a markdown document, never clobbering an
 * existing one. Always resolves: per-file failures are collected, not thrown.
 */
export async function importDroppedFiles(
  files: readonly File[],
  provider: FileSystemProvider,
  deps: ImportFilesDeps,
): Promise<ImportFilesResult> {
  const result: ImportFilesResult = { imported: [], failed: [], unsupported: [] };

  for (const file of files) {
    // Matches the historical extension sniff, including its treatment of a
    // name with no dot at all (which lands on an unsupported extension).
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      result.unsupported.push(file.name);
      continue;
    }

    const baseName = file.name.replace(/\.[^.]+$/, '');
    let claimed: string | null = null;
    try {
      const claim = await claimAvailablePath(provider, `${baseName}.md`);
      claimed = claim.path;
      const markdown = await readImportedMarkdown(file, ext, claim.path, provider, deps);
      await writeProviderText(provider, claim.path, markdown);
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

  if (failed.length > 0) {
    const detail =
      failed.length === 1
        ? `Could not import ${failed[0].source} — ${failed[0].message}`
        : `Could not import ${failed.length} of ${failed.length + imported.length} files.`;
    return { kind: 'error', message: detail };
  }

  if (imported.length === 0) {
    if (unsupported.length === 0) return null;
    return {
      kind: 'error',
      message:
        unsupported.length === 1
          ? `${unsupported[0]} is not a file type DocBlocks can import.`
          : `${unsupported.length} dropped files are not file types DocBlocks can import.`,
    };
  }

  // Renames are the one success worth narrating: the user dropped `report.docx`
  // and got `report (2).md`, and silence there looks like the import went
  // somewhere unexpected.
  const renamed = imported.filter((entry) => entry.renamed);
  if (renamed.length === 1) {
    return {
      kind: 'success',
      message: `Imported as ${renamed[0].path} — a document named ${renamed[0].source.replace(/\.[^.]+$/, '')}.md already exists.`,
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
