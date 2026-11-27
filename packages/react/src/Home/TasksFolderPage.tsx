import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import type { KindFolder } from '@bendyline/docblocks/folders';
import { buildTaskBoard, type BoardColumn, type TaskItem } from '../Tasks/task-model.js';
import { PageFrame } from './PageFrame.js';
import type { ShellPageContext } from './page-context.js';
import { TaskMeta } from './TaskRow.js';
import { useOptimisticDone } from './useOptimisticDone.js';
import { useWorkspaceTasks } from './useWorkspaceTasks.js';

const DRAG_TYPE = 'application/x-docblocks-task';
const DONE_SHOWN = 12;

function columnName(column: BoardColumn): string {
  return column.bucket ?? 'Not in a list';
}

function TaskCard({
  item,
  columns,
  context,
  onMove,
}: {
  item: TaskItem;
  columns: readonly BoardColumn[];
  context: ShellPageContext;
  onMove: (item: TaskItem, bucket: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const done = useOptimisticDone(item.done);
  const actions = context.actions;
  const act = (work: Promise<void>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };
  return (
    <li
      className="db-task-card"
      data-done={done.shown || undefined}
      aria-busy={busy || done.pending || undefined}
      draggable={Boolean(actions) && !busy && !done.pending}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, item.path);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="db-task-card-top">
        <input
          type="checkbox"
          className="db-task-check"
          checked={done.shown}
          disabled={!actions || busy || done.pending}
          aria-label={item.done ? `Mark “${item.title}” not done` : `Mark “${item.title}” done`}
          onChange={() => {
            if (!actions) return;
            done.begin();
            void (item.done ? actions.reopen(item) : actions.complete(item)).finally(done.end);
          }}
        />
        <button
          type="button"
          className="db-task-title"
          onClick={() => context.openDocument(`/${item.path}`)}
        >
          {item.title}
        </button>
      </div>
      <div className="db-task-card-bottom">
        <TaskMeta item={item} today={context.today} />
        {item.group && <span className="db-task-where">{item.group.split('/').join(' › ')}</span>}
        {actions && (
          <select
            className="db-task-move"
            aria-label={`Move “${item.title}” to`}
            value={item.bucket ?? ''}
            disabled={busy}
            onChange={(event) => act(onMove(item, event.target.value || null))}
          >
            {columns.map((column) => (
              <option key={column.bucket ?? ''} value={column.bucket ?? ''}>
                {column.bucket === item.bucket
                  ? columnName(column)
                  : `Move to ${columnName(column)}`}
              </option>
            ))}
          </select>
        )}
      </div>
    </li>
  );
}

function AddToColumn({
  column,
  onAdd,
}: {
  column: BoardColumn;
  onAdd: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text;
    if (!value.trim()) return;
    void onAdd(value).then((added) => {
      if (added) setText((current) => (current === value ? '' : current));
    });
  };
  return (
    <form className="db-task-column-add" onSubmit={submit}>
      <input
        className="db-task-column-input"
        type="text"
        value={text}
        placeholder={`Add to ${columnName(column)}`}
        aria-label={`Add a task to ${columnName(column)}`}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(event) => setText(event.target.value)}
      />
    </form>
  );
}

export function TasksFolderPage({
  context,
  folder,
  directories,
}: {
  context: ShellPageContext;
  folder: KindFolder;
  directories: readonly string[];
}) {
  const { index, workspaceId, generation, actions } = context;
  const { items } = useWorkspaceTasks(index, workspaceId, generation);
  const board = useMemo(
    () => buildTaskBoard(folder, directories, items),
    [folder, directories, items],
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [newBucket, setNewBucket] = useState('');
  const name = folder.path.slice(folder.path.lastIndexOf('/') + 1) || context.workspaceName;
  const parent = folder.path.includes('/')
    ? folder.path.slice(0, folder.path.lastIndexOf('/')).split('/').join(' › ')
    : context.workspaceName;

  const move = (item: TaskItem, bucket: string | null) =>
    actions ? actions.moveToBucket(item, bucket) : Promise.resolve();

  const columnKey = (column: BoardColumn) => column.bucket ?? '';
  const onDragOver = (event: DragEvent, column: BoardColumn) => {
    if (!actions || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(columnKey(column));
  };
  const onDrop = (event: DragEvent, column: BoardColumn) => {
    setDropTarget(null);
    const path = event.dataTransfer.getData(DRAG_TYPE);
    const item = items.find((candidate) => candidate.path === path);
    if (!item || item.bucket === column.bucket) return;
    event.preventDefault();
    void move(item, column.bucket);
  };

  const addBucket = (event: FormEvent) => {
    event.preventDefault();
    if (!actions || !newBucket.trim()) return;
    void actions.addBucket(`/${folder.path}`, newBucket).then((added) => {
      if (added) setNewBucket('');
    });
  };

  return (
    <PageFrame
      eyebrow={parent}
      title={name}
      subtitle={board.openCount === 1 ? '1 open task' : `${board.openCount} open tasks`}
      label={`${name}, tasks`}
      wide
      singlePane={context.singlePane}
      onShowFiles={context.onShowFiles}
      actions={
        actions && (
          <button
            type="button"
            className="db-page-link"
            onClick={() => void actions.clearKind(`/${folder.path}`)}
          >
            Make an ordinary folder
          </button>
        )
      }
    >
      <div className="db-task-board">
        {board.columns.map((column) => {
          const key = columnKey(column);
          const visible =
            column.done && !showAllDone ? column.items.slice(0, DONE_SHOWN) : column.items;
          return (
            <section
              key={key}
              className="db-task-column"
              data-done={column.done || undefined}
              data-drop={dropTarget === key || undefined}
              aria-label={columnName(column)}
              onDragOver={(event) => onDragOver(event, column)}
              onDragLeave={() => setDropTarget((current) => (current === key ? null : current))}
              onDrop={(event) => onDrop(event, column)}
            >
              <h2 className="db-task-column-title">
                <span>{columnName(column)}</span>
                <span className="db-page-count">{column.items.length}</span>
              </h2>
              {actions && !column.done && (
                <AddToColumn
                  column={column}
                  onAdd={async (text) =>
                    (await actions.addTask(text, {
                      folder: `/${folder.path}`,
                      bucket: column.bucket,
                    })) !== null
                  }
                />
              )}
              {column.items.length === 0 ? (
                <p className="db-task-column-empty">
                  {column.done ? 'Finished tasks land here.' : 'Nothing here.'}
                </p>
              ) : (
                <ul className="db-task-cards">
                  {visible.map((item) => (
                    <TaskCard
                      key={item.path}
                      item={item}
                      columns={board.columns}
                      context={context}
                      onMove={move}
                    />
                  ))}
                </ul>
              )}
              {column.done && column.items.length > DONE_SHOWN && (
                <button
                  type="button"
                  className="db-page-link"
                  onClick={() => setShowAllDone((current) => !current)}
                >
                  {showAllDone ? 'Show fewer' : `Show all ${column.items.length}`}
                </button>
              )}
            </section>
          );
        })}
      </div>
      {actions && (
        <form className="db-task-add-bucket" onSubmit={addBucket}>
          <input
            className="db-task-column-input"
            type="text"
            value={newBucket}
            placeholder="New list, such as Waiting or Someday"
            aria-label="New list name"
            autoComplete="off"
            onChange={(event) => setNewBucket(event.target.value)}
          />
          <button type="submit" className="db-page-secondary" disabled={!newBucket.trim()}>
            Add list
          </button>
        </form>
      )}
    </PageFrame>
  );
}
