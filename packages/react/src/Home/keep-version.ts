/**
 * Keep a version of a document's text before an edit the person did not type
 * themselves. Versions go where the editor keeps them: the document's
 * `<stem>_files` companion folder, under Squisq's versions layout, so the
 * editor's Versions list shows them and can restore one.
 */

import { DocumentVersionManager } from '@bendyline/squisq/versions';
import {
  FileSystemContentContainer,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';

export async function keepDocumentVersion(
  provider: FileSystemProvider,
  path: string,
  source: string,
  now?: Date,
): Promise<void> {
  const document = parseWorkspacePath(path);
  const slash = document.lastIndexOf('/');
  const parent = slash === -1 ? '' : document.slice(0, slash);
  const stem = document.slice(slash + 1).replace(/\.[^.]+$/, '');
  const container = new FileSystemContentContainer(
    provider,
    parent ? `${parent}/${stem}_files` : `${stem}_files`,
    { documentMediaPrefix: `${stem}_files` },
  );
  // A version matching the newest one already kept is not written twice.
  await new DocumentVersionManager(container, { basename: stem }).saveVersion({
    content: source,
    ...(now ? { now } : {}),
  });
}
