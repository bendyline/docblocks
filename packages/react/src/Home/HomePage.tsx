import { useEffect, useMemo, useState } from 'react';
import { findJournalEntry, kindFoldersOf, type FolderKind } from '@bendyline/docblocks/folders';
import { daysBetween, dueDate } from '@bendyline/docblocks/properties';
import { sectionTasks, type TaskItem } from '../Tasks/task-model.js';
import { loadLaunchView, saveLaunchView } from '../preferences/launch-view.js';
import { loadRecentDocuments } from '../WorkspaceIndex/recent-documents.js';
import { PageFrame, PageSection } from './PageFrame.js';
import type { ShellPageContext } from './page-context.js';
import { PhoneInboxOffer } from './PhoneInboxOffer.js';
import { TaskRow } from './TaskRow.js';
import type { WorkspaceSummary } from './useHomeDigests.js';
import { useWorkspaceTasks } from './useWorkspaceTasks.js';

function madeAgo(madeAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(madeAt)) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** What is due now in the other workspaces, from their last digests. */
function dueElsewhere(summaries: readonly WorkspaceSummary[], today: string) {
  return summaries
    .map((summary) => {
      const items = summary.digest
        ? sectionTasks(summary.digest.items, today)
        : { overdue: [], today: [] };
      return { summary, due: [...items.overdue, ...items.today] };
    })
    .filter((entry) => entry.due.length > 0 || !entry.summary.digest);
}

function RemindersControl({
  reminders,
}: {
  reminders: NonNullable<ShellPageContext['reminders']>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const { preferences, change } = reminders;
  return (
    <div className="db-home-reminders">
      <label className="db-home-launch">
        <input
          type="checkbox"
          checked={preferences.enabled}
          onChange={(event) => {
            setProblem(null);
            void change({ ...preferences, enabled: event.target.checked }).then(setProblem);
          }}
        />
        Remind me when tasks are due
      </label>
      {preferences.enabled && (
        <label className="db-home-launch">
          For tasks due on a day, remind me at
          <input
            type="time"
            className="db-properties-input"
            value={preferences.allDayTime}
            onChange={(event) => {
              if (event.target.value)
                void change({ ...preferences, allDayTime: event.target.value });
            }}
          />
        </label>
      )}
      {problem && (
        <p className="db-properties-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
      null
  );
}

const TODAY_LIMIT = 12;
const SOON_DAYS = 7;
const SOON_LIMIT = 8;
const RECENT_LIMIT = 6;

/** Ask sets up its chats folder itself, on the first answer. */
const START_CARDS: Record<
  Exclude<FolderKind, 'chats'>,
  { title: string; text: string; action: string }
> = {
  tasks: {
    title: 'Keep a task list',
    text: 'Each task is a note in a folder, with a due date. Finished tasks move to Done.',
    action: 'Add a tasks folder',
  },
  journal: {
    title: 'Keep a journal',
    text: 'One note for each day, filed by year, with the tasks you finished beside it.',
    action: 'Start a journal',
  },
  unfiled: {
    title: 'Catch everything',
    text: 'Notes from Quick Jot and things you drop here wait in one place until you file them.',
    action: 'Add your Unfiled drawer',
  },
};

function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function HomePage({ context }: { context: ShellPageContext }) {
  const { index, workspaceId, generation, today, actions } = context;
  const { kindFolders, documents, items } = useWorkspaceTasks(index, workspaceId, generation);
  const sections = useMemo(() => sectionTasks(items, today), [items, today]);
  const tasksFolder = kindFoldersOf(kindFolders, 'tasks')[0] ?? null;
  const journal = kindFoldersOf(kindFolders, 'journal')[0] ?? null;
  const unfiled = kindFoldersOf(kindFolders, 'unfiled')[0] ?? null;

  const dueNow = [...sections.overdue, ...sections.today];
  const soon = sections.upcoming.filter(
    (item) => item.due && daysBetween(today, dueDate(item.due)) <= SOON_DAYS,
  );
  const openCount = items.filter((item) => !item.done).length;
  const unfiledCount = unfiled
    ? documents.filter((document) => document.path.startsWith(`${unfiled.path}/`)).length
    : 0;
  const todaysEntry = journal
    ? findJournalEntry(
        journal.path,
        documents.map((document) => document.path),
        today,
      )
    : null;
  // Read once each time Home is shown: recent documents change only as documents open.
  const recentPaths = useMemo(() => loadRecentDocuments(workspaceId), [workspaceId]);
  const recent = useMemo(() => {
    const byPath = new Map(documents.map((document) => [document.path, document]));
    return recentPaths
      .map((path) => byPath.get(path.replace(/^\/+/, '') as never))
      .filter((document) => document !== undefined)
      .slice(0, RECENT_LIMIT);
  }, [recentPaths, documents]);

  const toggle = actions
    ? (item: TaskItem) => (item.done ? actions.reopen(item) : actions.complete(item))
    : null;
  const open = (item: TaskItem) => context.openDocument(`/${item.path}`);
  const missing = (['tasks', 'journal', 'unfiled'] as const).filter(
    (kind) => !kindFoldersOf(kindFolders, kind).length,
  );

  const [openHomeAtLaunch, setOpenHomeAtLaunch] = useState(() => loadLaunchView() === 'home');
  const elsewhere = useMemo(
    () => dueElsewhere(context.otherWorkspaces, today),
    [context.otherWorkspaces, today],
  );
  const [dropping, setDropping] = useState(false);
  const importToUnfiled = context.importToUnfiled;

  // Pasting with nothing focused keeps what was pasted in the Unfiled drawer.
  useEffect(() => {
    if (!actions) return;
    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target) || !event.clipboardData) return;
      const files = [...event.clipboardData.files];
      if (files.length > 0 && importToUnfiled) {
        event.preventDefault();
        void importToUnfiled(files);
        return;
      }
      const text = event.clipboardData.getData('text/plain');
      if (text.trim()) {
        event.preventDefault();
        void actions.saveNote(text);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [actions, importToUnfiled]);

  return (
    <PageFrame
      dropping={dropping}
      onDragOver={
        importToUnfiled
          ? (event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              setDropping(true);
            }
          : undefined
      }
      onDragLeave={() => setDropping(false)}
      onDrop={
        importToUnfiled
          ? (event) => {
              setDropping(false);
              const files = [...event.dataTransfer.files];
              if (files.length === 0) return;
              event.preventDefault();
              void importToUnfiled(files);
            }
          : undefined
      }
      eyebrow={longDate(today)}
      title="Home"
      subtitle={context.workspaceName}
      singlePane={context.singlePane}
      onShowFiles={context.onShowFiles}
    >
      {context.phoneInbox && <PhoneInboxOffer offer={context.phoneInbox} />}

      <PageSection
        title="Today"
        count={dueNow.length}
        action={
          tasksFolder || items.length > 0 ? (
            <button
              type="button"
              className="db-page-link"
              onClick={() => context.openRoute({ kind: 'tasks' })}
            >
              All tasks
            </button>
          ) : undefined
        }
      >
        {dueNow.length === 0 ? (
          <p className="db-page-empty">
            {context.listing ? 'Looking through your notes…' : 'Nothing is due today.'}
          </p>
        ) : (
          <ul className="db-task-list">
            {dueNow.slice(0, TODAY_LIMIT).map((item) => (
              <TaskRow
                key={item.path}
                item={item}
                today={today}
                showWhere
                onToggle={toggle}
                onOpen={open}
              />
            ))}
          </ul>
        )}
        {dueNow.length > TODAY_LIMIT && (
          <button
            type="button"
            className="db-page-link"
            onClick={() => context.openRoute({ kind: 'tasks' })}
          >
            {dueNow.length - TODAY_LIMIT} more
          </button>
        )}
      </PageSection>

      {soon.length > 0 && (
        <PageSection title="This week" count={soon.length}>
          <ul className="db-task-list">
            {soon.slice(0, SOON_LIMIT).map((item) => (
              <TaskRow
                key={item.path}
                item={item}
                today={today}
                showWhere
                onToggle={toggle}
                onOpen={open}
              />
            ))}
          </ul>
        </PageSection>
      )}

      {(tasksFolder || journal || unfiled) && (
        <div className="db-home-tiles">
          {tasksFolder && (
            <button
              type="button"
              className="db-home-tile"
              onClick={() => context.openRoute({ kind: 'tasks' })}
            >
              <span className="db-home-tile-title">Tasks</span>
              <span className="db-home-tile-text">
                {openCount === 1 ? '1 open' : `${openCount} open`}
                {dueNow.length > 0 ? `, ${dueNow.length} due now` : ''}
              </span>
            </button>
          )}
          {journal && (
            <button
              type="button"
              className="db-home-tile"
              onClick={() =>
                todaysEntry
                  ? context.openDocument(`/${todaysEntry}`)
                  : void actions?.openJournalDay(`/${journal.path}`, today)
              }
              disabled={!todaysEntry && !actions}
            >
              <span className="db-home-tile-title">Journal</span>
              <span className="db-home-tile-text">
                {todaysEntry ? "Open today's entry" : "Write today's entry"}
              </span>
            </button>
          )}
          {unfiled && (
            <button
              type="button"
              className="db-home-tile"
              onClick={() => context.openFolder(`/${unfiled.path}`)}
            >
              <span className="db-home-tile-title">Unfiled</span>
              <span className="db-home-tile-text">
                {unfiledCount === 0
                  ? 'Nothing waiting'
                  : unfiledCount === 1
                    ? '1 waiting to be filed'
                    : `${unfiledCount} waiting to be filed`}
              </span>
            </button>
          )}
        </div>
      )}

      {actions && missing.length > 0 && !context.listing && (
        <PageSection title="Get started">
          <div className="db-home-starts">
            {missing.map((kind) => (
              <div key={kind} className="db-home-start">
                <h3 className="db-home-start-title">{START_CARDS[kind].title}</h3>
                <p className="db-home-start-text">{START_CARDS[kind].text}</p>
                <button
                  type="button"
                  className="db-page-secondary"
                  onClick={() => void actions.setUp(kind)}
                >
                  {START_CARDS[kind].action}
                </button>
              </div>
            ))}
          </div>
        </PageSection>
      )}

      {elsewhere.length > 0 && (
        <PageSection title="Other workspaces">
          {elsewhere.map(({ summary, due }) => (
            <div key={summary.workspaceId} className="db-home-elsewhere">
              <h3 className="db-home-elsewhere-title">
                <span>{summary.name}</span>
                <span className="db-page-count">
                  {summary.refreshing
                    ? 'Reading…'
                    : summary.digest
                      ? `As of ${madeAgo(summary.digest.madeAt, Date.now())}`
                      : 'Not read yet. Open it once to see its tasks here.'}
                </span>
              </h3>
              {due.length > 0 && (
                <ul className="db-task-list">
                  {due.slice(0, TODAY_LIMIT).map((item) => (
                    <TaskRow
                      key={item.path}
                      item={item}
                      today={today}
                      where={`${summary.name} › ${item.path.split('/').slice(0, -1).join(' › ') || 'Top'}`}
                      onToggle={context.toggleInWorkspace ?? null}
                      onOpen={() => context.openInWorkspace(summary.workspaceId, item.path)}
                    />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </PageSection>
      )}

      {recent.length > 0 && (
        <PageSection title="Recent documents">
          <ul className="db-home-recent">
            {recent.map((document) => (
              <li key={document.path}>
                <button
                  type="button"
                  className="db-task-title"
                  onClick={() => context.openDocument(`/${document.path}`)}
                >
                  {document.title}
                </button>
              </li>
            ))}
          </ul>
        </PageSection>
      )}
      <label className="db-home-launch">
        <input
          type="checkbox"
          checked={openHomeAtLaunch}
          onChange={(event) => {
            setOpenHomeAtLaunch(event.target.checked);
            saveLaunchView(event.target.checked ? 'home' : 'last-document');
          }}
        />
        Show Home when DocBlocks opens
      </label>
      {context.reminders && <RemindersControl reminders={context.reminders} />}
      {importToUnfiled && (
        <p className="db-page-empty">
          Drop files here, or paste with nothing selected, to keep them in Unfiled.
        </p>
      )}
    </PageFrame>
  );
}
