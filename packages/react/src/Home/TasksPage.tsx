import { useMemo, useState } from 'react';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { sectionTasks, type TaskItem } from '../Tasks/task-model.js';
import { CaptureBox } from './CaptureBox.js';
import { PageFrame, PageSection } from './PageFrame.js';
import type { ShellPageContext } from './page-context.js';
import { TaskRow } from './TaskRow.js';
import { useWorkspaceTasks } from './useWorkspaceTasks.js';

type Show = 'now' | 'upcoming' | 'open' | 'done';
type GroupBy = 'folder' | 'category';

const DONE_LIMIT = 100;

function folderLabel(item: TaskItem): string {
  if (item.folder === null) return 'Documents with a due date';
  const folder = item.folder.split('/').join(' › ') || 'Tasks';
  return item.bucket ? `${folder} › ${item.bucket}` : folder;
}

export function TasksPage({ context }: { context: ShellPageContext }) {
  const { index, workspaceId, generation, today, actions } = context;
  const { items: localItems } = useWorkspaceTasks(index, workspaceId, generation);
  // Tasks in the person's other workspaces, from their last digests: shown,
  // opened and ticked off from here (on that workspace's storage).
  const { items, workspaceNames } = useMemo(() => {
    const names = new Map<string, string>([[workspaceId, context.workspaceName]]);
    const elsewhere: TaskItem[] = [];
    for (const summary of context.otherWorkspaces) {
      if (!summary.digest) continue;
      names.set(summary.workspaceId, summary.name);
      elsewhere.push(...summary.digest.items);
    }
    return { items: [...localItems, ...elsewhere], workspaceNames: names };
  }, [localItems, context.otherWorkspaces, workspaceId, context.workspaceName]);
  const sections = useMemo(() => sectionTasks(items, today), [items, today]);
  const several = workspaceNames.size > 1;
  const [show, setShow] = useState<Show>('now');
  const [groupBy, setGroupBy] = useState<GroupBy>('folder');

  const lists: Record<Show, readonly TaskItem[]> = {
    now: [...sections.overdue, ...sections.today],
    upcoming: sections.upcoming,
    open: [...sections.overdue, ...sections.today, ...sections.upcoming, ...sections.undated],
    done: sections.done.slice(0, DONE_LIMIT),
  };
  const shown = lists[show];

  const groups = useMemo(() => {
    const byKey = new Map<string, TaskItem[]>();
    for (const item of shown) {
      const place = groupBy === 'folder' ? folderLabel(item) : (item.category ?? 'No category');
      const key = several
        ? `${workspaceNames.get(item.workspaceId) ?? 'Workspace'} › ${place}`
        : place;
      const group = byKey.get(key);
      if (group) group.push(item);
      else byKey.set(key, [item]);
    }
    return [...byKey.entries()];
  }, [shown, groupBy, several, workspaceNames]);

  const toggle = actions
    ? (item: TaskItem) => (item.done ? actions.reopen(item) : actions.complete(item))
    : null;
  const here = (item: TaskItem) => item.workspaceId === workspaceId;
  const open = (item: TaskItem) =>
    here(item)
      ? context.openDocument(`/${item.path}`)
      : context.openInWorkspace(item.workspaceId, item.path);
  const empty: Record<Show, string> = {
    now: 'Nothing is due today or overdue.',
    upcoming: 'Nothing has a due date coming up.',
    open: 'No open tasks.',
    done: 'Nothing finished yet.',
  };

  return (
    <PageFrame
      title="Tasks"
      subtitle={context.workspaceName}
      singlePane={context.singlePane}
      onShowFiles={context.onShowFiles}
    >
      {actions && (
        <CaptureBox
          label="Add a task"
          placeholder="Pay rent friday"
          today={today}
          primary={{
            label: 'Add task',
            run: async (text) => (await actions.addTask(text)) !== null,
          }}
        />
      )}
      <div className="db-page-toolbar">
        <ChipRadioGroup<Show>
          name="Show"
          value={show}
          onChange={setShow}
          options={[
            { key: 'now', label: `Due now ${lists.now.length}` },
            { key: 'upcoming', label: `Upcoming ${sections.upcoming.length}` },
            { key: 'open', label: `All open ${lists.open.length}` },
            { key: 'done', label: 'Done' },
          ]}
        />
        <ChipRadioGroup<GroupBy>
          name="Group by"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { key: 'folder', label: 'By folder' },
            { key: 'category', label: 'By category' },
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <p className="db-page-empty">
          {context.listing ? 'Looking through your notes…' : empty[show]}
        </p>
      ) : (
        groups.map(([label, group]) => (
          <PageSection key={label} title={label} count={group.length}>
            <ul className="db-task-list">
              {group.map((item) => (
                <TaskRow
                  key={`${item.workspaceId}:${item.path}`}
                  item={item}
                  today={today}
                  onToggle={here(item) ? toggle : (context.toggleInWorkspace ?? null)}
                  onOpen={open}
                />
              ))}
            </ul>
          </PageSection>
        ))
      )}
    </PageFrame>
  );
}
