/**
 * A row between the toolbar and the document that edits its properties:
 * due date, category, tags, repeat, whether it is done, and (in a tasks
 * folder with more than one open or done list) which list it is in.
 *
 * Every change is a frontmatter edit made through the editor itself
 * (`applySourceEdits`), so it is one undoable step, the caret stays where it
 * was, and the document session saves it like any other edit. Moving a task
 * between buckets, and finishing one in a tasks folder, are file moves the
 * shell makes.
 */

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { parseFrontmatter, splitFrontmatterBlock } from '@bendyline/squisq/markdown';
import {
  DocumentPropertyError,
  REPEAT_RULES,
  applyDocumentProperties,
  dueDate,
  dueTime,
  readDocumentProperties,
  type DocumentProperties,
  type DocumentPropertiesPatch,
  type LocalDate,
  type RepeatRule,
} from '@bendyline/docblocks/properties';
import { offersListChoice, type StripTask } from './list-choice.js';

export type { StripTask } from './list-choice.js';

export interface DocumentPropertiesStripProps {
  /** Where the document sits as a task, or null outside a tasks folder. */
  task: StripTask | null;
  /** Categories already used in the workspace, offered as suggestions. */
  categories: readonly string[];
  /** Show the strip even for a document that carries no properties yet. */
  forceOpen: boolean;
  today: LocalDate;
  /** Finish or reopen a task in a tasks folder (a move). */
  onSetDone: (done: boolean) => Promise<void>;
  onMoveToBucket: (bucket: string | null) => Promise<void>;
  /** Hide the strip again after it was opened for a document without properties. */
  onClose: () => void;
}

const REPEAT_LABELS: Record<RepeatRule, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};

function frontmatterOf(source: string): Record<string, unknown> | undefined {
  const block = splitFrontmatterBlock(source).frontmatter;
  if (!block) return undefined;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return undefined;
  try {
    return (
      parseFrontmatter(block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '')) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/** The one edit that turns `before` into `after`: what lies between their shared ends. */
function minimalEdit(before: string, after: string) {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end += 1;
  }
  return { start, end: before.length - end, text: after.slice(start, after.length - end) };
}

function hasAny(properties: DocumentProperties): boolean {
  return Object.keys(properties).length > 0;
}

export function DocumentPropertiesStrip({
  task,
  categories,
  forceOpen,
  today,
  onSetDone,
  onMoveToBucket,
  onClose,
}: DocumentPropertiesStripProps) {
  const { markdownSource, applySourceEdits } = useEditorContext();
  const properties = useMemo(
    () => readDocumentProperties(frontmatterOf(markdownSource)),
    [markdownSource],
  );
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tagsText, setTagsText] = useState((properties.tags ?? []).join(', '));
  const [categoryText, setCategoryText] = useState(properties.category ?? '');
  // Follow edits made elsewhere (Source view, another device) when not typing here.
  useEffect(() => setTagsText((properties.tags ?? []).join(', ')), [properties.tags]);
  useEffect(() => setCategoryText(properties.category ?? ''), [properties.category]);

  if (!forceOpen && !task && !hasAny(properties)) return null;

  const apply = async (patch: DocumentPropertiesPatch) => {
    setProblem(null);
    let next: string;
    try {
      next = await applyDocumentProperties(markdownSource, patch);
    } catch (error: unknown) {
      setProblem(
        error instanceof DocumentPropertyError ? error.message : 'That could not be saved.',
      );
      return;
    }
    if (next === markdownSource) return;
    if (!applySourceEdits([minimalEdit(markdownSource, next)], { baseSource: markdownSource })) {
      setProblem('Switch to Write or Markdown to change these.');
    }
  };

  const done = task ? task.done : properties.completed !== undefined;
  const toggleDone = () => {
    if (task) {
      setBusy(true);
      void onSetDone(!done).finally(() => setBusy(false));
    } else {
      void apply({ completed: done ? null : today });
    }
  };

  const due = properties.due;
  const commitTags = () => {
    const tags = tagsText
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    const current = (properties.tags ?? []).join(',');
    if (tags.join(',') !== current) void apply({ tags });
  };
  const commitCategory = () => {
    if (categoryText.trim() !== (properties.category ?? '')) void apply({ category: categoryText });
  };
  const submit = (event: FormEvent) => event.preventDefault();

  return (
    <form className="db-properties" aria-label="Document details" onSubmit={submit}>
      <label className="db-properties-done">
        <input
          type="checkbox"
          className="db-task-check"
          checked={done}
          disabled={busy}
          onChange={toggleDone}
        />
        Done
      </label>

      <label className="db-properties-field">
        <span className="db-properties-label">Due</span>
        <input
          type="date"
          className="db-properties-input"
          aria-label="Due date"
          value={due ? dueDate(due) : ''}
          onChange={(event) => {
            const day = event.target.value;
            const time = due ? dueTime(due) : null;
            void apply({ due: day ? (time ? `${day}T${time}` : day) : null });
          }}
        />
      </label>

      <label className="db-properties-field">
        <span className="db-properties-label">Category</span>
        <input
          type="text"
          className="db-properties-input"
          list={`${id}-categories`}
          aria-label="Category"
          value={categoryText}
          size={10}
          placeholder="None"
          onChange={(event) => setCategoryText(event.target.value)}
          onBlur={commitCategory}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitCategory();
          }}
        />
        <datalist id={`${id}-categories`}>
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </label>

      <label className="db-properties-field">
        <span className="db-properties-label">Tags</span>
        <input
          type="text"
          className="db-properties-input"
          value={tagsText}
          size={14}
          placeholder="Separated by commas"
          aria-label="Tags"
          onChange={(event) => setTagsText(event.target.value)}
          onBlur={commitTags}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitTags();
          }}
        />
      </label>

      <label className="db-properties-field">
        <span className="db-properties-label">Repeat</span>
        <select
          className="db-properties-input"
          value={properties.repeat ?? ''}
          aria-label="Repeat"
          onChange={(event) =>
            void apply({ repeat: (event.target.value || null) as RepeatRule | null })
          }
        >
          <option value="">Never</option>
          {REPEAT_RULES.map((rule) => (
            <option key={rule} value={rule}>
              {REPEAT_LABELS[rule]}
            </option>
          ))}
        </select>
      </label>

      {task && offersListChoice(task) && (
        <label className="db-properties-field">
          <span className="db-properties-label">List</span>
          <select
            className="db-properties-input"
            value={task.bucket ?? ''}
            aria-label="List"
            disabled={busy}
            onChange={(event) => {
              setBusy(true);
              void onMoveToBucket(event.target.value || null).finally(() => setBusy(false));
            }}
          >
            {task.bucket === null && <option value="">Not in a list</option>}
            {task.buckets.map((bucket) => (
              <option key={bucket.name} value={bucket.name}>
                {bucket.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {forceOpen && !task && !hasAny(properties) && (
        <button type="button" className="db-page-link" onClick={onClose}>
          Hide
        </button>
      )}
      {problem && (
        <p className="db-properties-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
