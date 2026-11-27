/**
 * Conflict copies: versions of a document that lost a save race, kept in the
 * document's sidecar instead of beside it in the document list.
 *
 *   Notes/Unicorns.md
 *   Notes/Unicorns_files/conflicts/
 *     .gitignore                         (only in a git repository)
 *     20261120T103612Z-sync-3f9a1c2e77b04d15 (Mike's MacBook Pro).md
 *
 * Each copy is one immutable file and its name carries every fact about it,
 * so nothing shared has to be rewritten (a manifest would itself conflict
 * between devices). The native storage layers write `sync` copies with the
 * same grammar; `test/fixtures/conflict-copy-names.json` pins both sides.
 */

import { sha256Bytes } from '../workspace-settings/sha256.js';
import { documentCompanionPath } from './companion-path.js';
import type { FileSystemProvider } from './types.js';
import { isCompanionDirectoryName, isMarkdownFileName } from './workspace-entry-rules.js';

/** Folder inside a document's sidecar that holds its conflict copies. */
export const CONFLICT_COPIES_DIRECTORY_NAME = 'conflicts';
/** Copies of sidecar files that are not documents (media, history). Never shown. */
export const CONFLICT_COPIES_OTHER_DIRECTORY_NAME = 'other';
/** How long the text from before an automatic merge stays available to undo. */
export const PREMERGE_COPY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Undo copies kept per document. Two devices typing in one document for an
 * hour combine their edits many times, and each time leaves text behind.
 */
export const PREMERGE_COPY_LIMIT = 24;

const GITIGNORE_NAME = '.gitignore';
const GITIGNORE_CONTENT = '*\n';
const LABEL_MAX_SCALARS = 40;
const NAME_PATTERN =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(sync|local|draft|premerge)(-s)?-([0-9a-f]{16})(?: \((.+)\))?(\.[A-Za-z0-9]{1,16})?$/u;

/**
 * Where a copy came from:
 * - `sync`: a version a sync service (iCloud) set aside when two devices saved.
 * - `local`: this device's unsaved text, set aside so the user could move on.
 * - `draft`: a draft recovered from a previous session, set aside the same way.
 * - `premerge`: this device's text from just before an automatic merge.
 */
export type ConflictCopyOrigin = 'sync' | 'local' | 'draft' | 'premerge';

export interface ConflictCopyName {
  /** When the version was captured, to the second. */
  readonly capturedAt: number;
  readonly origin: ConflictCopyOrigin;
  /** The copy is the Markdown source of an outside-in document (`X.html` edited through `X_files/x.md`). */
  readonly source: boolean;
  /** First 16 hex digits of the content's SHA-256. */
  readonly hash: string;
  /** Who or what saved it, for display: a device name. */
  readonly label: string | null;
  /** The document's extension with its dot, or '' when it has none. */
  readonly extension: string;
}

export interface ConflictCopy extends ConflictCopyName {
  readonly name: string;
  readonly path: string;
}

/** Which copies a document owns and where they live. */
export interface ConflictCopyScope {
  /** `<stem>_files/conflicts`, in the same slash style as the document path. */
  readonly directory: string;
  readonly source: boolean;
  readonly extension: string;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = name.slice(dot);
  return /^\.[A-Za-z0-9]{1,16}$/u.test(extension) ? extension : '';
}

function join(parent: string, child: string): string {
  if (!parent) return child;
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

/**
 * Make a device name safe inside a file name on every platform a workspace
 * can sync to. Returns null when nothing usable is left.
 */
export function sanitizeConflictCopyLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const cleaned = Array.from(label)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      // No C0 or C1 control characters, and nothing a file name cannot hold on Windows.
      const control = codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
      return !control && !'/\\:*?"<>|'.includes(character);
    })
    .join('')
    .replace(/\s+/gu, ' ');
  const trimEdges = (value: string) => value.replace(/^[ .]+|[ .]+$/gu, '');
  const bounded = trimEdges(Array.from(trimEdges(cleaned)).slice(0, LABEL_MAX_SCALARS).join(''));
  return bounded || null;
}

/** First 16 hex digits of the SHA-256 of a copy's bytes. */
export function conflictCopyHash(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return Array.from(sha256Bytes(bytes).subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function formatConflictCopyName(name: ConflictCopyName): string {
  const at = new Date(name.capturedAt);
  if (!Number.isFinite(at.getTime())) throw new TypeError('A conflict copy needs a capture time.');
  if (!/^[0-9a-f]{16}$/u.test(name.hash)) throw new TypeError('A conflict copy needs its hash.');
  if (name.extension && !/^\.[A-Za-z0-9]{1,16}$/u.test(name.extension)) {
    throw new TypeError('A conflict copy extension must be a plain file extension.');
  }
  const stamp =
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  const label = sanitizeConflictCopyLabel(name.label);
  return (
    `${stamp}-${name.origin}${name.source ? '-s' : ''}-${name.hash}` +
    `${label ? ` (${label})` : ''}${name.extension}`
  );
}

/** Null for anything that is not a conflict copy (`.gitignore`, a stray file). */
export function parseConflictCopyName(fileName: string): ConflictCopyName | null {
  const match = NAME_PATTERN.exec(fileName);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, origin, source, hash, label, extension] = match;
  const capturedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  // Date.UTC rolls an impossible date over; a real stamp survives the round trip.
  const check = new Date(capturedAt);
  if (
    !Number.isFinite(capturedAt) ||
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) ||
    check.getUTCMinutes() !== Number(minute) ||
    check.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }
  return {
    capturedAt,
    origin: origin as ConflictCopyOrigin,
    source: source !== undefined,
    hash: hash!,
    label: label ?? null,
    extension: extension ?? '',
  };
}

/**
 * True for a sidecar's `conflicts` folder and everything in it. These are
 * versions of the document, not media it uses, so pickers and attachment
 * lists that walk a sidecar leave them out.
 */
export function isConflictCopyPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (
      isCompanionDirectoryName(segments[index]!) &&
      segments[index + 1] === CONFLICT_COPIES_DIRECTORY_NAME
    ) {
      return true;
    }
  }
  return false;
}

/** Copies the user is asked to review. A `premerge` copy only backs Undo. */
export function isReviewableConflictCopy(copy: ConflictCopyName): boolean {
  return copy.origin !== 'premerge';
}

/**
 * Where a document's conflict copies live. `sourcePath` is the Markdown source
 * of an outside-in document when that is what the session edits. Null when the
 * document keeps no sidecar: such a file has nowhere tidy to put a copy.
 */
export function conflictCopyScope(
  documentPath: string,
  sourcePath?: string | null,
): ConflictCopyScope | null {
  const display = documentPath.replace(/\\/g, '/');
  const source = sourcePath ? sourcePath.replace(/\\/g, '/') : null;
  if (source && source !== display) {
    return {
      directory: join(documentCompanionPath(display), CONFLICT_COPIES_DIRECTORY_NAME),
      source: true,
      extension: extensionOf(source),
    };
  }
  const name = display.slice(display.lastIndexOf('/') + 1);
  if (!isMarkdownFileName(name)) return null;
  // A Markdown file inside a sidecar is an outside-in source opened directly.
  const parent = display.slice(0, Math.max(0, display.lastIndexOf('/')));
  const parentName = parent.slice(parent.lastIndexOf('/') + 1);
  if (isCompanionDirectoryName(parentName)) {
    return {
      directory: join(parent, CONFLICT_COPIES_DIRECTORY_NAME),
      source: true,
      extension: extensionOf(display),
    };
  }
  return {
    directory: join(documentCompanionPath(display), CONFLICT_COPIES_DIRECTORY_NAME),
    source: false,
    extension: extensionOf(display),
  };
}

/** Newest first; a stable order for equal stamps. */
function byNewest(a: ConflictCopy, b: ConflictCopy): number {
  return b.capturedAt - a.capturedAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function directoryNames(
  provider: FileSystemProvider,
  directory: string,
): Promise<{ files: string[]; directories: string[] } | null> {
  if (!(await provider.exists(directory))) return null;
  const entries = await provider.readDirectory(directory);
  return {
    files: entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name),
    directories: entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.name),
  };
}

/** Every copy in a scope, newest first. A missing folder is simply no copies. */
export async function listConflictCopies(
  provider: FileSystemProvider,
  scope: ConflictCopyScope,
): Promise<ConflictCopy[]> {
  const names = await directoryNames(provider, scope.directory);
  if (!names) return [];
  const copies: ConflictCopy[] = [];
  for (const name of names.files) {
    const parsed = parseConflictCopyName(name);
    if (!parsed || parsed.source !== scope.source) continue;
    copies.push({ ...parsed, name, path: join(scope.directory, name) });
  }
  return copies.sort(byNewest);
}

/** The copy's text, or null when it is gone or is not text. */
export async function readConflictCopy(
  provider: FileSystemProvider,
  copy: Pick<ConflictCopy, 'path'>,
): Promise<string | null> {
  const data = await provider.readBinary(copy.path);
  if (data === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

export interface WriteConflictCopyOptions {
  readonly origin: ConflictCopyOrigin;
  readonly label?: string | null;
  readonly capturedAt?: number;
  /**
   * The document's current text. A copy identical to it is not written:
   * there would be nothing to choose between.
   */
  readonly currentContent?: string | null;
}

export type WriteConflictCopyResult =
  | { readonly status: 'written'; readonly copy: ConflictCopy }
  /** The same text was already kept; `copy` is the existing file. */
  | { readonly status: 'duplicate'; readonly copy: ConflictCopy }
  | { readonly status: 'same-as-document'; readonly copy: null };

/**
 * Keep one version as a conflict copy. Identical text is kept once: a copy is
 * never written twice, and never when it matches the document itself.
 */
export async function writeConflictCopy(
  provider: FileSystemProvider,
  scope: ConflictCopyScope,
  content: string,
  options: WriteConflictCopyOptions,
): Promise<WriteConflictCopyResult> {
  const hash = conflictCopyHash(content);
  const undo = options.origin === 'premerge';
  if (
    !undo &&
    options.currentContent != null &&
    conflictCopyHash(options.currentContent) === hash
  ) {
    return { status: 'same-as-document', copy: null };
  }
  const existing = (await listConflictCopies(provider, scope)).find(
    (copy) =>
      copy.hash === hash &&
      copy.extension.toLowerCase() === scope.extension.toLowerCase() &&
      // Undo material expires, so it never stands in for a copy awaiting review.
      (copy.origin === 'premerge') === undo,
  );
  if (existing) return { status: 'duplicate', copy: existing };

  const parsed: ConflictCopyName = {
    capturedAt: Math.floor((options.capturedAt ?? Date.now()) / 1000) * 1000,
    origin: options.origin,
    source: scope.source,
    hash,
    label: sanitizeConflictCopyLabel(options.label),
    extension: scope.extension,
  };
  const name = formatConflictCopyName(parsed);
  const path = join(scope.directory, name);
  if (!(await provider.exists(scope.directory))) await provider.createDirectory(scope.directory);
  // Git has no use for these, and committing them would hand one person's
  // conflict to a team. Outside a repository the file is left out: two devices
  // keeping a copy at the same moment would each create it, and that is one
  // more conflict for a sync service to settle.
  if (await provider.exists(scope.directory.startsWith('/') ? '/.git' : '.git')) {
    const ignore = join(scope.directory, GITIGNORE_NAME);
    if (!(await provider.exists(ignore))) await provider.writeFile(ignore, GITIGNORE_CONTENT);
  }
  await provider.writeBinary(path, new TextEncoder().encode(content));
  return { status: 'written', copy: { ...parsed, name, path } };
}

/**
 * Remove one copy, and the folder with it once nothing but housekeeping is
 * left. Removing a copy that is already gone is not an error: another device
 * may have resolved it first.
 */
export async function removeConflictCopy(
  provider: FileSystemProvider,
  scope: ConflictCopyScope,
  copy: Pick<ConflictCopy, 'path'>,
): Promise<void> {
  if (await provider.exists(copy.path)) await provider.delete(copy.path);
  const names = await directoryNames(provider, scope.directory);
  if (!names) return;
  if (names.files.some((name) => name !== GITIGNORE_NAME)) return;
  for (const directory of names.directories) {
    const inner = await directoryNames(provider, join(scope.directory, directory));
    if (inner && (inner.files.length > 0 || inner.directories.length > 0)) return;
  }
  await provider.delete(scope.directory);
}

/** Drop undo copies older than their lifetime. Returns how many were removed. */
export async function pruneConflictCopies(
  provider: FileSystemProvider,
  scope: ConflictCopyScope,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  let undoCopies = 0;
  // Newest first, so the ones past the limit are the oldest.
  for (const copy of await listConflictCopies(provider, scope)) {
    if (copy.origin !== 'premerge') continue;
    undoCopies += 1;
    if (now - copy.capturedAt < PREMERGE_COPY_LIFETIME_MS && undoCopies <= PREMERGE_COPY_LIMIT) {
      continue;
    }
    await removeConflictCopy(provider, scope, copy);
    removed += 1;
  }
  return removed;
}
