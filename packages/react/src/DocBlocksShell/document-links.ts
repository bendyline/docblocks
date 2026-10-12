import type { DocumentLinkCandidate } from '@bendyline/squisq-editor-react';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { compareFileNames } from '../FileExplorer/entry-sort.js';

/** A Markdown document the link picker can offer, as listed by the workspace index. */
export interface DocumentLinkTarget {
  readonly name: string;
  readonly path: string;
}

function dirname(path: string): string {
  const clean = path.replace(/^\/+/, '');
  const index = clean.lastIndexOf('/');
  return index < 0 ? '' : clean.slice(0, index);
}

export function relativeMarkdownLink(fromFile: string, toFile: string): string {
  const fromParts = fromFile.replace(/^\/+/, '').split('/').filter(Boolean);
  const toParts = toFile.replace(/^\/+/, '').split('/').filter(Boolean);
  const fromDirectory = fromParts.slice(0, -1);
  const toDirectory = toParts.slice(0, -1);
  const toBase = toParts[toParts.length - 1] ?? '';
  let common = 0;
  while (
    common < fromDirectory.length &&
    common < toDirectory.length &&
    fromDirectory[common] === toDirectory[common]
  ) {
    common += 1;
  }
  const parts = [
    ...Array(fromDirectory.length - common).fill('..'),
    ...toDirectory.slice(common),
    toBase,
  ];
  return parts.length === 0 ? toBase : parts.join('/');
}

export function createDocumentLinkCandidates(
  entries: readonly DocumentLinkTarget[],
  selectedFile: string,
  query: string,
): DocumentLinkCandidate[] {
  const normalizedQuery = query.trim().toLowerCase();
  const selected = parseWorkspacePath(selectedFile);
  const candidates: DocumentLinkCandidate[] = [];
  for (const entry of entries) {
    if (parseWorkspacePath(entry.path) === selected) continue;
    const label = entry.name.replace(/\.(?:md|markdown|mdown)$/iu, '');
    const path = relativeMarkdownLink(selectedFile, entry.path);
    if (
      normalizedQuery &&
      !label.toLowerCase().includes(normalizedQuery) &&
      !path.toLowerCase().includes(normalizedQuery)
    ) {
      continue;
    }
    const description = dirname(entry.path);
    candidates.push(description ? { path, label, description } : { path, label });
  }
  // Same order as the file explorer; the path separates equal names in
  // different folders.
  candidates.sort(
    (left, right) =>
      compareFileNames(left.label, right.label) || compareFileNames(left.path, right.path),
  );
  return candidates;
}
