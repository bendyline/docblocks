import { useMemo } from 'react';
import {
  findJournalEntry,
  journalDateFromPath,
  journalEntryHeading,
  type KindFolder,
} from '@bendyline/docblocks/folders';
import { CaptureBox } from './CaptureBox.js';
import { PageFrame, PageSection } from './PageFrame.js';
import type { ShellPageContext } from './page-context.js';
import { useWorkspaceTasks } from './useWorkspaceTasks.js';

const MONTHS_SHOWN = 6;

function dayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, number - 1, 1)));
}

/**
 * A line that says what an entry holds: its opening text, else its title
 * unless that is only the date it was started with, else its length.
 */
function entrySummary(
  date: string,
  document: { readonly excerpt?: string; readonly title: string; readonly wordCount: number },
): string {
  if (document.excerpt) return document.excerpt;
  if (document.title && document.title !== journalEntryHeading(date)) return document.title;
  return document.wordCount > 4 ? `${document.wordCount} words` : 'Just started';
}

export function JournalPage({
  context,
  folder,
}: {
  context: ShellPageContext;
  folder: KindFolder;
}) {
  const { index, workspaceId, generation, today, actions } = context;
  const { documents, items } = useWorkspaceTasks(index, workspaceId, generation);
  const prefix = folder.path ? `${folder.path}/` : '';
  const name = folder.path.slice(folder.path.lastIndexOf('/') + 1) || context.workspaceName;

  const { months, others, todaysEntry } = useMemo(() => {
    const inJournal = documents.filter((document) => document.path.startsWith(prefix));
    const dated = new Map<string, (typeof inJournal)[number][]>();
    const undated: (typeof inJournal)[number][] = [];
    for (const document of inJournal) {
      const date = journalDateFromPath(document.path);
      if (!date) {
        undated.push(document);
        continue;
      }
      const list = dated.get(date);
      if (list) list.push(document);
      else dated.set(date, [document]);
    }
    const doneOn = new Map<string, number>();
    for (const item of items) {
      if (item.done && item.completedOn) {
        doneOn.set(item.completedOn, (doneOn.get(item.completedOn) ?? 0) + 1);
      }
    }
    const byMonth = new Map<
      string,
      { date: string; document: (typeof inJournal)[number]; done: number }[]
    >();
    for (const date of [...dated.keys()].sort().reverse()) {
      const month = date.slice(0, 7);
      const list = byMonth.get(month) ?? [];
      for (const document of dated.get(date)!)
        list.push({ date, document, done: doneOn.get(date) ?? 0 });
      byMonth.set(month, list);
    }
    return {
      months: [...byMonth.entries()],
      others: undated,
      todaysEntry: findJournalEntry(
        folder.path,
        inJournal.map((document) => document.path),
        today,
      ),
    };
  }, [documents, items, prefix, folder.path, today]);

  const openToday = () =>
    todaysEntry
      ? context.openDocument(`/${todaysEntry}`)
      : void actions?.openJournalDay(`/${folder.path}`, today);

  return (
    <PageFrame
      title={name}
      subtitle="One note for each day"
      label={`${name}, journal`}
      singlePane={context.singlePane}
      onShowFiles={context.onShowFiles}
      actions={
        <button
          type="button"
          className="db-page-primary"
          disabled={!todaysEntry && !actions}
          onClick={openToday}
        >
          {todaysEntry ? "Open today's entry" : "Write today's entry"}
        </button>
      }
    >
      {actions && (
        <CaptureBox
          label="Add a line to today"
          placeholder="Walked to the market"
          today={today}
          readsDates={false}
          primary={{ label: 'Add', run: (text) => actions.appendToJournal(text) }}
        />
      )}
      {months.length === 0 && (
        <p className="db-page-empty">
          {context.listing ? 'Looking through your notes…' : 'No entries yet.'}
        </p>
      )}
      {months.slice(0, MONTHS_SHOWN).map(([month, entries]) => (
        <PageSection key={month} title={monthLabel(month)} count={entries.length}>
          <ul className="db-journal-list">
            {entries.map(({ date, document, done }) => (
              <li key={document.path} className="db-journal-entry">
                <button
                  type="button"
                  className="db-journal-open"
                  onClick={() => context.openDocument(`/${document.path}`)}
                >
                  <span className="db-journal-date">{dayLabel(date)}</span>
                  <span className="db-journal-excerpt">{entrySummary(date, document)}</span>
                </button>
                {done > 0 && (
                  <span className="db-journal-done">
                    {done === 1 ? '1 task done' : `${done} tasks done`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </PageSection>
      ))}
      {months.length > MONTHS_SHOWN && (
        <p className="db-page-empty">Older entries are in the {name} folder, filed by year.</p>
      )}
      {others.length > 0 && (
        <PageSection title="Other notes" count={others.length}>
          <ul className="db-home-recent">
            {others.map((document) => (
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
    </PageFrame>
  );
}
