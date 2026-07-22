import { tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';

export const PINNED_DOCUMENTS_STORAGE_KEY = 'docblocks-pinned-documents-v1';

const MAX_PINNED_DOCUMENTS = 100;
const MAX_WORKSPACE_ID_LENGTH = 256;
const MAX_WORKSPACE_NAME_LENGTH = 256;
const MAX_DOCUMENT_PATH_LENGTH = 4096;

export interface PinnedDocument {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** Canonical, root-relative workspace path. */
  readonly path: string;
}

export type PinnedDocumentAvailability = 'unknown' | 'available' | 'missing';

export interface PinnedDocumentListItem extends PinnedDocument {
  readonly availability: PinnedDocumentAvailability;
}

export interface PinnedDocumentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolvePinnedDocumentStorage(): PinnedDocumentStorage | null {
  try {
    const candidate = Reflect.get(globalThis, 'localStorage') as unknown;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof Reflect.get(candidate, 'getItem') !== 'function' ||
      typeof Reflect.get(candidate, 'setItem') !== 'function'
    ) {
      return null;
    }
    return candidate as PinnedDocumentStorage;
  } catch {
    return null;
  }
}

export function pinnedDocumentKey(document: Pick<PinnedDocument, 'workspaceId' | 'path'>): string {
  const path = tryParseWorkspacePath(document.path);
  return `${document.workspaceId}\0${path ?? document.path}`;
}

export function pinnedDocumentName(document: Pick<PinnedDocument, 'path'>): string {
  const canonical = tryParseWorkspacePath(document.path);
  const path = canonical ?? document.path;
  return path.slice(path.lastIndexOf('/') + 1);
}

export function pinnedDocumentDisplayPath(document: PinnedDocument): string {
  return `${document.workspaceName}/${document.path}`;
}

export function missingPinnedDocumentMessage(document: PinnedDocument): string {
  return `${pinnedDocumentName(document)} is no longer at ${pinnedDocumentDisplayPath(document)}. Unpin this file?`;
}

function parsePinnedDocument(value: unknown): PinnedDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => key !== 'workspaceId' && key !== 'workspaceName' && key !== 'path') ||
    typeof record.workspaceId !== 'string' ||
    record.workspaceId.length === 0 ||
    record.workspaceId.length > MAX_WORKSPACE_ID_LENGTH ||
    typeof record.workspaceName !== 'string' ||
    record.workspaceName.length === 0 ||
    record.workspaceName.length > MAX_WORKSPACE_NAME_LENGTH ||
    typeof record.path !== 'string' ||
    record.path.length === 0 ||
    record.path.length > MAX_DOCUMENT_PATH_LENGTH
  ) {
    return null;
  }
  const path = tryParseWorkspacePath(record.path);
  if (!path) return null;
  return {
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    path,
  };
}

export function parsePinnedDocuments(value: unknown): PinnedDocument[] {
  if (!Array.isArray(value)) return [];
  const parsed: PinnedDocument[] = [];
  const seen = new Set<string>();
  for (const valueItem of value.slice(0, MAX_PINNED_DOCUMENTS)) {
    const document = parsePinnedDocument(valueItem);
    if (!document) continue;
    const key = pinnedDocumentKey(document);
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(document);
  }
  return parsed;
}

export function loadPinnedDocuments(
  storage: PinnedDocumentStorage | null = resolvePinnedDocumentStorage(),
): PinnedDocument[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINNED_DOCUMENTS_STORAGE_KEY);
    return raw === null ? [] : parsePinnedDocuments(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function savePinnedDocuments(
  documents: readonly PinnedDocument[],
  storage: PinnedDocumentStorage | null = resolvePinnedDocumentStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_DOCUMENTS_STORAGE_KEY, JSON.stringify(parsePinnedDocuments(documents)));
  } catch {
    // Pinning is a convenience. A storage quota or privacy restriction must
    // not interrupt document editing in the current session.
  }
}

export function togglePinnedDocument(
  documents: readonly PinnedDocument[],
  candidate: PinnedDocument,
): PinnedDocument[] {
  const parsed = parsePinnedDocument(candidate);
  if (!parsed) return [...documents];
  const key = pinnedDocumentKey(parsed);
  if (documents.some((document) => pinnedDocumentKey(document) === key)) {
    return documents.filter((document) => pinnedDocumentKey(document) !== key);
  }
  return [parsed, ...documents].slice(0, MAX_PINNED_DOCUMENTS);
}

export function removePinnedDocument(
  documents: readonly PinnedDocument[],
  target: Pick<PinnedDocument, 'workspaceId' | 'path'>,
): PinnedDocument[] {
  const key = pinnedDocumentKey(target);
  return documents.filter((document) => pinnedDocumentKey(document) !== key);
}

export function relocatePinnedDocuments(
  documents: readonly PinnedDocument[],
  workspaceId: string,
  oldPath: string,
  newPath: string,
): PinnedDocument[] {
  const oldCanonical = tryParseWorkspacePath(oldPath);
  const newCanonical = tryParseWorkspacePath(newPath);
  if (!oldCanonical || !newCanonical) return [...documents];
  return parsePinnedDocuments(
    documents.map((document) => {
      if (document.workspaceId !== workspaceId) return document;
      if (document.path === oldCanonical) return { ...document, path: newCanonical };
      if (!document.path.startsWith(`${oldCanonical}/`)) return document;
      return {
        ...document,
        path: `${newCanonical}${document.path.slice(oldCanonical.length)}`,
      };
    }),
  );
}

export function renamePinnedDocumentWorkspace(
  documents: readonly PinnedDocument[],
  workspaceId: string,
  workspaceName: string,
): PinnedDocument[] {
  return documents.map((document) =>
    document.workspaceId === workspaceId ? { ...document, workspaceName } : document,
  );
}

export function movePinnedDocumentsToWorkspace(
  documents: readonly PinnedDocument[],
  sourceWorkspaceId: string,
  destination: Pick<PinnedDocument, 'workspaceId' | 'workspaceName'>,
): PinnedDocument[] {
  return parsePinnedDocuments(
    documents.map((document) =>
      document.workspaceId === sourceWorkspaceId ? { ...document, ...destination } : document,
    ),
  );
}
