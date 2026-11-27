import { useMemo } from 'react';
import type { KindFolder } from '@bendyline/docblocks/folders';
import type {
  IndexedDocument,
  IndexedFolderMarker,
  WorkspaceIndex,
} from '@bendyline/docblocks/workspace-index';
import {
  kindFoldersFromMarkers,
  taskItemsFromDocuments,
  type TaskItem,
} from '../Tasks/task-model.js';

export interface WorkspaceTasks {
  readonly markers: readonly IndexedFolderMarker[];
  readonly kindFolders: readonly KindFolder[];
  readonly documents: readonly IndexedDocument[];
  readonly items: readonly TaskItem[];
}

const EMPTY: WorkspaceTasks = Object.freeze({
  markers: [],
  kindFolders: [],
  documents: [],
  items: [],
});

/** The workspace's kind folders and tasks, recomputed when the index publishes. */
export function useWorkspaceTasks(
  index: WorkspaceIndex | null,
  workspaceId: string,
  generation: number,
): WorkspaceTasks {
  return useMemo(() => {
    if (!index) return EMPTY;
    const markers = index.getFolderMarkers();
    const kindFolders = kindFoldersFromMarkers(markers);
    const documents = index.getDocuments();
    return {
      markers,
      kindFolders,
      documents,
      items: taskItemsFromDocuments(workspaceId, documents, kindFolders),
    };
    // `generation` is the index's own change signal; the getters are stable within one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, workspaceId, generation]);
}
