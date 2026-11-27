/**
 * What the phones take in from other apps (a share, or "Open with") lands in
 * the device workspace at `Inbox/<id>/<name>`: the native side writes it
 * there before the page runs. When there is an Unfiled drawer to put it in,
 * the document is filed into the drawer instead, so it lands beside the rest
 * of the person's loose notes rather than in a device-only folder.
 *
 * Which drawer: the open workspace's, when it has one; otherwise the only
 * drawer among the device's other workspaces. With two or more elsewhere the
 * document stays in the Inbox: picking between workspaces is the person's
 * call, and the drawer's page offers what waits in the Inbox later.
 *
 * The drawer gets its copy first, through the same create-only import as a
 * drop (a taken name gets a numbered suffix); the Inbox copy is removed only
 * after that. Any failure leaves the document in the Inbox, where it opens
 * as before.
 */

import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { importDroppedFiles } from './import-files.js';

/** An Unfiled drawer: a workspace and the folder in it. */
export interface UnfiledDrawer {
  readonly workspaceId: string;
  /** The folder's workspace path, with no leading slash. */
  readonly folder: string;
}

/**
 * The drawer a taken-in document goes to, or null to leave it in the Inbox.
 * `openDrawer` is the open workspace's drawer as its index sees it now;
 * `savedDrawers` are the drawers the device's workspaces had when their
 * digests were made, including the open one's (which matters before its
 * index has looked).
 */
export function chooseUnfiledDrawer(input: {
  readonly openWorkspaceId: string | null;
  readonly openDrawer: string | undefined;
  readonly savedDrawers: ReadonlyMap<string, string>;
}): UnfiledDrawer | null {
  const { openWorkspaceId, openDrawer, savedDrawers } = input;
  if (openWorkspaceId !== null) {
    const folder = openDrawer ?? savedDrawers.get(openWorkspaceId);
    if (folder !== undefined) return { workspaceId: openWorkspaceId, folder };
  }
  const elsewhere = [...savedDrawers].filter(([workspaceId]) => workspaceId !== openWorkspaceId);
  if (elsewhere.length !== 1) return null;
  const [workspaceId, folder] = elsewhere[0]!;
  return { workspaceId, folder };
}

/** The phones' device-only workspace, where native intake writes. */
export const DEVICE_WORKSPACE_ID = 'local';

/** The marker that makes a folder the Unfiled drawer (docs/home-and-folders.md). */
const FOLDER_MARKER = '.docblocks/folder.json';

const INBOX_PATH = /^\/?Inbox\/([0-9a-fA-F-]{36})\/([^/]+)$/;

/** Whether an open request names a document the phone has just taken in. */
export function isPhoneInboxPath(workspaceId: string, path: string): boolean {
  return workspaceId === DEVICE_WORKSPACE_ID && INBOX_PATH.test(path);
}

/**
 * Files a taken-in document into the drawer at `folder` (a workspace path)
 * and removes its Inbox copy. Resolves to the document's new path, with no
 * leading slash, or null when it stays where it is.
 */
export async function fileIncomingDocument(input: {
  readonly source: FileSystemProvider;
  readonly path: string;
  readonly target: FileSystemProvider;
  readonly folder: string;
}): Promise<string | null> {
  const match = INBOX_PATH.exec(input.path);
  if (!match) return null;
  const [, id, name] = match;
  const folder = input.folder.replace(/^\/+|\/+$/g, '');
  try {
    // A drawer known only from an older digest may have been unmarked or
    // removed since; never recreate it as a plain folder.
    if (!(await input.target.exists(folder ? `${folder}/${FOLDER_MARKER}` : FOLDER_MARKER))) {
      return null;
    }
    const bytes = await input.source.readBinary(`Inbox/${id}/${name}`);
    if (!bytes) return null;
    const result = await importDroppedFiles([new File([bytes], name)], input.target, { folder });
    const filed = result.imported[0];
    if (!filed) return null;
    // The drawer has its copy; the Inbox folder was only a landing place.
    await input.source.delete(`Inbox/${id}`).catch(() => undefined);
    return filed.path.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

/** A document waiting in the phone's Inbox from an earlier share. */
export interface PhoneInboxItem {
  /** The Inbox folder it landed in; stable for as long as it waits. */
  readonly id: string;
  readonly name: string;
  /** Its path in the device workspace, with no leading slash. */
  readonly path: string;
}

/** Bounded: an Inbox that size is offered in batches, a batch per visit. */
const INBOX_LISTING_LIMIT = 100;
const INBOX_ID = /^[0-9a-fA-F-]{36}$/;

/**
 * What waits in the phone's Inbox, oldest share folders first as storage
 * lists them. A folder that cannot be read is left out rather than failing
 * the whole listing.
 */
export async function listPhoneInbox(
  source: FileSystemProvider,
  limit = INBOX_LISTING_LIMIT,
): Promise<PhoneInboxItem[]> {
  let folders;
  try {
    if (!(await source.exists('Inbox'))) return [];
    folders = await source.readDirectory('Inbox');
  } catch {
    return [];
  }
  const items: PhoneInboxItem[] = [];
  for (const folder of folders) {
    if (items.length >= limit) break;
    if (folder.kind !== 'directory' || !INBOX_ID.test(folder.name)) continue;
    let entries;
    try {
      entries = await source.readDirectory(`Inbox/${folder.name}`);
    } catch {
      continue;
    }
    // Native intake writes one document per share folder.
    const file = entries.find((entry) => entry.kind === 'file' && !entry.name.startsWith('.'));
    if (file) {
      items.push({ id: folder.name, name: file.name, path: `Inbox/${folder.name}/${file.name}` });
    }
  }
  return items;
}

const DECLINED_KEY = 'docblocks.phoneInbox.declined';
const DECLINED_LIMIT = 500;

/**
 * Inbox documents already offered for the drawer and left where they are
 * ("Not now", or a move that failed). Each is offered once. Kept on this
 * device only; lost storage just offers them again.
 */
export function loadDeclinedInboxIds(): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(DECLINED_KEY) ?? '[]');
    return new Set(
      Array.isArray(raw)
        ? raw.filter((id): id is string => typeof id === 'string' && INBOX_ID.test(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

export function declineInboxIds(ids: Iterable<string>): void {
  try {
    const next = [...new Set([...loadDeclinedInboxIds(), ...ids])].slice(-DECLINED_LIMIT);
    globalThis.localStorage?.setItem(DECLINED_KEY, JSON.stringify(next));
  } catch {
    // Without storage the offer simply comes back next time.
  }
}
