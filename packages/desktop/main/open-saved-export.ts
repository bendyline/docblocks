import path from 'node:path';
import { resolveSavedExportGrant } from './export-grants.js';

/** Keep this narrower than the save API: saving bytes must never grant executable launch. */
const OPENABLE_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.pptx',
  '.epub',
  '.html',
  '.zip',
  '.mp4',
  '.gif',
]);

export async function openSavedExport(
  ownerId: number,
  documentKey: string,
  grantId: string,
  actions: {
    openInDocBlocks: (absolutePath: string) => void;
    openDefault: (absolutePath: string) => Promise<string>;
    beginAccess: (bookmark: string) => void;
  },
): Promise<void> {
  const target = await resolveSavedExportGrant(ownerId, documentKey, grantId);
  const extension = path.extname(target.absolutePath).toLowerCase();
  if (target.bookmark) actions.beginAccess(target.bookmark);
  if (extension === '.md') {
    actions.openInDocBlocks(target.absolutePath);
    return;
  }
  if (!OPENABLE_EXTENSIONS.has(extension)) throw new Error('This export type cannot be opened');
  const message = await actions.openDefault(target.absolutePath);
  if (message) throw new Error(message);
}
