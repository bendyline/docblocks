/** The catalog id workspace passages report, and the name sources show for it. */
export const WORKSPACE_KNOWLEDGE_CATALOG_ID = 'workspace';
export const WORKSPACE_KNOWLEDGE_NAME = 'This workspace';

const LOCAL_PREFIX = 'knowledge://local/';
/** Gezel's id grammar for publishers and catalogs: a DNS label. */
const CATALOG_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const LINES = /^line=(\d{1,9})(?:-(\d{1,9}))?$/u;
/** Gezel's document-id bounds (UTF-16 units, as its schema counts them). */
const MAX_DOCUMENT_ID = 256;
const MAX_ENCODED_DOCUMENT_ID = 512;

/** True for C0 and C1 controls, which Gezel's document ids refuse. */
function hasControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** A note path as Gezel names documents, or null when its grammar cannot. */
function documentId(path: string): string | null {
  const id = path.replace(/^\/+/u, '').normalize('NFC');
  if (!id || id.length > MAX_DOCUMENT_ID || id !== id.trim() || hasControls(id)) return null;
  return id.split('/').every(Boolean) ? id : null;
}

/** Where a workspace passage came from: a note and its lines. */
export interface WorkspacePassageReference {
  readonly catalogId: string;
  /** The note's workspace path, without a leading slash, NFC. */
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/**
 * `knowledge://local/<catalog>/<path>#line=a-b`, the citation grammar Gezel
 * accepts for an app's own passages; null for a path it cannot express (over
 * 256 characters, a control character, an empty segment).
 */
export function workspacePassageUri(
  catalogId: string,
  path: string,
  lineStart: number,
  lineEnd: number,
): string | null {
  const id = documentId(path);
  if (!id || !CATALOG_ID.test(catalogId)) return null;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 0) {
    return null;
  }
  const encoded = id.split('/').map(encodeURIComponent).join('/');
  if (encoded.length > MAX_ENCODED_DOCUMENT_ID) return null;
  const lines = lineEnd > lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`;
  return `${LOCAL_PREFIX}${catalogId}/${encoded}#line=${lines}`;
}

/** The note and lines a `knowledge://local/` citation names; null for anything else. */
export function parseWorkspacePassageUri(uri: string): WorkspacePassageReference | null {
  if (!uri.startsWith(LOCAL_PREFIX)) return null;
  const hash = uri.indexOf('#');
  const body = uri.slice(LOCAL_PREFIX.length, hash === -1 ? undefined : hash);
  const slash = body.indexOf('/');
  const catalogId = body.slice(0, slash);
  const encoded = body.slice(slash + 1);
  if (slash < 1 || !CATALOG_ID.test(catalogId) || encoded.length > MAX_ENCODED_DOCUMENT_ID) {
    return null;
  }
  let path: string;
  try {
    path = encoded
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }
  if (documentId(path) !== path) return null;
  if (hash === -1) return { catalogId, path, lineStart: 1, lineEnd: 1 };
  const lines = LINES.exec(uri.slice(hash + 1));
  if (!lines) return null;
  const lineStart = Number(lines[1]);
  const lineEnd = lines[2] === undefined ? lineStart : Number(lines[2]);
  return { catalogId, path, lineStart, lineEnd: Math.max(lineStart, lineEnd) };
}

/**
 * Passages as a host reports them, with every workspace passage under
 * {@link WORKSPACE_KNOWLEDGE_CATALOG_ID}, so the person sees one source,
 * {@link WORKSPACE_KNOWLEDGE_NAME}.
 *
 * Hosts hand a request's {@link AiWorkspacePassage}s to Gezel as knowledge
 * `candidates`; Gezel ranks them with its catalogs' passages and returns a
 * chosen one under its collection, the reference's second segment (`ws-…`).
 * No catalog may publish under `knowledge://local/`, so the reference alone
 * says a passage is the workspace's.
 */
export function withWorkspaceCatalogId<
  P extends { readonly uri: string; readonly catalogId: string },
>(passages: readonly P[]): P[] {
  return passages.map((passage) =>
    passage.catalogId !== WORKSPACE_KNOWLEDGE_CATALOG_ID && parseWorkspacePassageUri(passage.uri)
      ? { ...passage, catalogId: WORKSPACE_KNOWLEDGE_CATALOG_ID }
      : passage,
  );
}
