import { parseWorkspacePath } from './workspace-path.js';

/** Return the hidden companion directory used for a document's media and versions. */
export function documentCompanionPath(documentPath: string): string {
  const rooted = documentPath.replace(/\\/g, '/').startsWith('/');
  const clean = parseWorkspacePath(documentPath);
  if (!clean) throw new Error('The workspace root has no document companion path.');
  const slash = clean.lastIndexOf('/');
  const parent = slash < 0 ? '' : clean.slice(0, slash);
  const name = (slash < 0 ? clean : clean.slice(slash + 1)).replace(/\.[^.]+$/, '');
  if (parent) return `${parent}/${name}_files`;
  return rooted ? `/${name}_files` : `${name}_files`;
}
