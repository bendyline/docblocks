import type { LocalDate } from '@bendyline/docblocks/properties';
import type { WorkspaceIndex } from '@bendyline/docblocks/workspace-index';
import type { ReminderPreferences } from '../preferences/reminders.js';
import type { TaskItem } from '../Tasks/task-model.js';
import type { PageActions } from './page-actions.js';
import type { WorkspaceSummary } from './useHomeDigests.js';
import type { ShellRoute } from './shell-routes.js';

/** What the shell hands every page: the active workspace, its index, and how to act. */
export interface ShellPageContext {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly index: WorkspaceIndex | null;
  /** Advances whenever the index publishes; pages recompute on it. */
  readonly generation: number;
  /** The workspace has not been listed yet, so absent things may simply be unseen. */
  readonly listing: boolean;
  readonly today: LocalDate;
  /** Null for a workspace that cannot be changed from here. */
  readonly actions: PageActions | null;
  /** One pane at a time (phones): pages show a way back to the files. */
  readonly singlePane: boolean;
  readonly onShowFiles: () => void;
  readonly openDocument: (path: string) => void;
  readonly openFolder: (path: string) => void;
  readonly openRoute: (route: ShellRoute) => void;
  /** The person's other workspaces, as their last digests describe them. */
  readonly otherWorkspaces: readonly WorkspaceSummary[];
  /** Open a document in another workspace. */
  readonly openInWorkspace: (workspaceId: string, path: string) => void;
  /**
   * Finish, or reopen, a task in another workspace, from its digest's row.
   * Absent where other workspaces cannot be changed from here. Reports its
   * own outcome.
   */
  readonly toggleInWorkspace?: (item: TaskItem) => Promise<void>;
  /**
   * Documents shared to this phone earlier that wait in its Inbox, offered
   * for the open workspace's Unfiled drawer. Absent when there are none, or
   * none not already offered.
   */
  readonly phoneInbox?: {
    readonly count: number;
    /** The drawer's folder name. */
    readonly drawerName: string;
    /** Move them into the drawer; reports its own outcome. */
    readonly fileAll: () => Promise<void>;
    /** Leave them in the Inbox; they are not offered again. */
    readonly decline: () => void;
  };
  /** Bring dropped or pasted files into the Unfiled drawer; absent where that cannot work. */
  readonly importToUnfiled?: (files: readonly File[]) => Promise<void>;
  /** Reminders when tasks come due; null where this device cannot show them. */
  readonly reminders: {
    readonly preferences: ReminderPreferences;
    /** Resolves a plain-language problem when the change could not be made, else null. */
    readonly change: (next: ReminderPreferences) => Promise<string | null>;
  } | null;
}
