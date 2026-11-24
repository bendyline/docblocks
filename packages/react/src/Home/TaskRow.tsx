import type { ReactNode } from 'react';
import type { LocalDate } from '@bendyline/docblocks/properties';
import { categoryHue, dueLabel, taskWhere, type TaskItem } from '../Tasks/task-model.js';
import { useOptimisticDone } from './useOptimisticDone.js';

const REPEAT_LABELS: Record<string, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};

export function TaskMeta({ item, today }: { item: TaskItem; today: LocalDate }) {
  const due = item.due && !item.done ? dueLabel(item.due, today) : null;
  return (
    <span className="db-task-meta">
      {item.repeat && <span className="db-task-meta-repeat">{REPEAT_LABELS[item.repeat]}</span>}
      {item.checklist && (
        <span
          className="db-task-meta-steps"
          title={`${item.checklist.done} of ${item.checklist.total} steps done`}
        >
          {item.checklist.done}/{item.checklist.total}
        </span>
      )}
      {item.category && (
        <span className="db-task-category" data-hue={categoryHue(item.category)}>
          {item.category}
        </span>
      )}
      {due && (
        <span className="db-task-due" data-status={due.status}>
          {due.text}
        </span>
      )}
    </span>
  );
}

export interface TaskRowProps {
  item: TaskItem;
  today: LocalDate;
  /** Show the folder it is in, for lists that gather tasks from several. */
  showWhere?: boolean;
  /** Where it lives, in place of its folder (another workspace's name, say). */
  where?: string;
  /** Null when the workspace cannot be changed from here. */
  onToggle: ((item: TaskItem) => Promise<void>) | null;
  onOpen: (item: TaskItem) => void;
  /** Extra controls at the end of the row. */
  children?: ReactNode;
}

export function TaskRow({
  item,
  today,
  showWhere,
  where,
  onToggle,
  onOpen,
  children,
}: TaskRowProps) {
  const done = useOptimisticDone(item.done);
  return (
    <li
      className="db-task-row"
      data-done={done.shown || undefined}
      aria-busy={done.pending || undefined}
    >
      <input
        type="checkbox"
        className="db-task-check"
        checked={done.shown}
        disabled={!onToggle || done.pending}
        aria-label={item.done ? `Mark “${item.title}” not done` : `Mark “${item.title}” done`}
        onChange={() => {
          if (!onToggle) return;
          done.begin();
          void onToggle(item).finally(done.end);
        }}
      />
      <span className="db-task-row-main">
        <button type="button" className="db-task-title" onClick={() => onOpen(item)}>
          {item.title}
        </button>
        {(showWhere || where) && <span className="db-task-where">{where ?? taskWhere(item)}</span>}
      </span>
      <TaskMeta item={item} today={today} />
      {children}
    </li>
  );
}
