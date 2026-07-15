import type { EditorView } from '@bendyline/squisq-editor-react';
import { tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';

export const LAST_STATE_KEY = 'docblocks:lastState';

const MAX_WORKSPACE_ID_CHARACTERS = 256;
const MAX_WORKSPACE_PATH_CHARACTERS = 4_096;
const EDITOR_VIEWS = new Set<EditorView>(['raw', 'wysiwyg', 'preview']);

export interface LastState {
  workspaceId: string;
  filePath: string;
  view: EditorView;
}

type LastStateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

export function parseLastState(value: unknown): LastState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ['workspaceId', 'filePath', 'view'])) return null;
  if (!isBoundedText(record.workspaceId, MAX_WORKSPACE_ID_CHARACTERS)) return null;
  if (!isBoundedText(record.filePath, MAX_WORKSPACE_PATH_CHARACTERS)) return null;
  const parsedPath = tryParseWorkspacePath(record.filePath);
  if (!parsedPath) return null;
  if (typeof record.view !== 'string' || !EDITOR_VIEWS.has(record.view as EditorView)) return null;
  return {
    workspaceId: record.workspaceId,
    filePath: record.filePath,
    view: record.view as EditorView,
  };
}

export function saveLastState(state: LastState, storage: LastStateStorage = localStorage): void {
  try {
    storage.setItem(LAST_STATE_KEY, JSON.stringify(state));
  } catch {
    // Navigation persistence is best-effort; quota or disabled storage must
    // not make an otherwise-open document unusable.
  }
}

export function loadLastState(storage: LastStateStorage = localStorage): LastState | null {
  try {
    const raw = storage.getItem(LAST_STATE_KEY);
    if (!raw) return null;
    const state = parseLastState(JSON.parse(raw) as unknown);
    if (state) return state;
    try {
      storage.removeItem(LAST_STATE_KEY);
    } catch {
      // The invalid record is ignored even when storage is read-only.
    }
    return null;
  } catch {
    return null;
  }
}
