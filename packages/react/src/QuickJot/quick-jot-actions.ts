/**
 * What Quick Jot's buttons do with a jot: make it a document, a task, or a
 * line in today's journal entry. Everything is written through the pages'
 * actions, so a jot lands exactly where the same thing typed on the Tasks,
 * Journal or Unfiled page would.
 *
 * This interface is the seam between the box and the writes: a richer box
 * (a Squisq composer) can replace the text area and keep these unchanged.
 */

import { parseCapture, type LocalDate } from '@bendyline/docblocks/properties';
import { noteTitleFor, type PageActions } from '../Home/page-actions.js';
import { isEditorDocumentImportFile } from '../DocBlocksShell/import-file-types.js';
import { pastedContentToMarkdown } from '../DocBlocksShell/pasted-document.js';
import { splitJotTask, type JotDraft, type JotOutcome } from './quick-jot-model.js';

export interface QuickJotActions {
  /** Always offered. */
  readonly toDocument: (draft: JotDraft) => Promise<JotOutcome>;
  /** Absent when the workspace has no tasks folder: the button is not shown. */
  readonly toTask?: (draft: JotDraft) => Promise<JotOutcome>;
  /** Absent when the workspace has no journal: the button is not shown. */
  readonly toJournal?: (draft: JotDraft) => Promise<JotOutcome>;
}

export interface QuickJotActionHost {
  readonly actions: Pick<
    PageActions,
    'saveNote' | 'addDescribedTask' | 'appendToJournal' | 'attach'
  >;
  /** Import files into the Unfiled drawer; resolves the paths of what was imported. */
  readonly importToUnfiled: (files: readonly File[]) => Promise<readonly string[]>;
  readonly openDocument: (path: string) => void;
  readonly report: (kind: 'success' | 'error', message: string) => void;
  readonly today: () => LocalDate;
  readonly offersTask: boolean;
  readonly offersJournal: boolean;
  /** The Markdown a jot's text becomes; the paste pipeline's reading by default. */
  readonly toMarkdown?: (text: string) => Promise<string>;
}

function quoted(text: string): string {
  return `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;
}

export function createQuickJotActions(host: QuickJotActionHost): QuickJotActions {
  const filesOf = (draft: JotDraft) => draft.attachments.map((attachment) => attachment.file);
  const toMarkdown = host.toMarkdown ?? ((text: string) => pastedContentToMarkdown({ text }));

  const toDocument = async (draft: JotDraft): Promise<JotOutcome> => {
    const text = draft.text.trim();
    const files = filesOf(draft);
    if (!text && files.length === 0) return 'kept';
    // Word, PDF or slides dropped in on their own are documents already:
    // import them as they would be from the file list.
    if (!text && files.every((file) => isEditorDocumentImportFile(file))) {
      const imported = await host.importToUnfiled(files);
      if (imported.length === 0) return 'kept';
      host.openDocument(imported[0]!);
      return 'used';
    }
    let markdown = '';
    if (text) {
      try {
        markdown = await toMarkdown(draft.text);
      } catch {
        host.report('error', 'DocBlocks could not read that text. Try it as plain text.');
        return 'kept';
      }
    }
    // Named from what was typed, not from the Markdown it became.
    const path = await host.actions.saveNote(
      markdown,
      text ? noteTitleFor(text) : undefined,
      files,
    );
    if (path === null) return 'kept';
    host.openDocument(path);
    return 'used';
  };

  const toTask = async (draft: JotDraft): Promise<JotOutcome> => {
    const { title, notes } = splitJotTask(draft.text);
    const capture = parseCapture(title, host.today());
    if (!capture.title.trim()) return 'kept';
    const path = await host.actions.addDescribedTask({
      title: capture.title,
      ...(capture.due ? { due: capture.due } : {}),
      ...(notes ? { notes } : {}),
    });
    if (path === null) return 'kept';
    const files = filesOf(draft);
    if (files.length > 0 && !(await host.actions.attach(path, files))) return 'text-used';
    host.report('success', `Added ${quoted(capture.title)} to your tasks.`);
    return 'used';
  };

  const toJournal = async (draft: JotDraft): Promise<JotOutcome> => {
    if (!draft.text.trim()) return 'kept';
    const added = await host.actions.appendToJournal(draft.text, {
      keepLines: true,
      attachments: filesOf(draft),
    });
    return added ? 'used' : 'kept';
  };

  return {
    toDocument,
    ...(host.offersTask ? { toTask } : {}),
    ...(host.offersJournal ? { toJournal } : {}),
  };
}
