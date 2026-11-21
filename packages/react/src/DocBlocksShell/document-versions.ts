import type { DocumentExternalOrigin } from '@bendyline/docblocks/document';
import type { ConflictCopyName } from '@bendyline/docblocks/filesystem';
import { describeAge } from './conflict-summary.js';

/** Who a version came from, in words: "Saved on Mike's MacBook Pro". */
export function describeVersionSource(copy: Pick<ConflictCopyName, 'origin' | 'label'>): string {
  switch (copy.origin) {
    case 'sync':
      return copy.label ? `Saved on ${copy.label}` : 'Saved on another device';
    case 'draft':
      return 'A recovered draft that was set aside';
    case 'premerge':
      // Both sides of a merge are kept: the text here, and the other device's.
      return copy.label
        ? `The version from ${copy.label}, before edits were combined`
        : 'Your text from before edits were combined';
    case 'local':
      // Text kept out of the document: unsaved edits that gave way to a saved
      // version, or another device's version the user chose not to combine.
      // The copy syncs with the folder, so "this device" could be wrong elsewhere.
      return copy.label
        ? `Edits from ${copy.label} that were set aside`
        : 'Edits that were set aside';
  }
}

/** One line per version for a list: "Saved on Mike's MacBook Pro, 3 minutes ago". */
export function describeVersion(
  copy: Pick<ConflictCopyName, 'origin' | 'label' | 'capturedAt'>,
  now: number,
): string {
  const age = describeAge(copy.capturedAt, now);
  return age ? `${describeVersionSource(copy)}, ${age}` : describeVersionSource(copy);
}

/** "1 other version to review" / "3 other versions to review". */
export function describeVersionCount(count: number): string {
  return `${count.toLocaleString()} other version${count === 1 ? '' : 's'} to review`;
}

/** Where changes came from, for a sentence: "Mike's MacBook Pro" or "another device". */
export function describeOrigin(origin: DocumentExternalOrigin | undefined): string {
  return origin?.savedBy?.trim() || 'another device';
}

/**
 * A name for a version kept as its own document beside the original:
 * "Unicorns (from Mike's MacBook Pro).md", numbered when that is taken.
 */
export function keptVersionFileName(
  documentName: string,
  copy: Pick<ConflictCopyName, 'label'>,
  taken: ReadonlySet<string>,
): string {
  const dot = documentName.lastIndexOf('.');
  const stem = dot > 0 ? documentName.slice(0, dot) : documentName;
  const extension = dot > 0 ? documentName.slice(dot) : '';
  const base = `${stem} (${copy.label ? `from ${copy.label}` : 'other version'})`;
  const lowered = new Set([...taken].map((name) => name.toLowerCase()));
  let candidate = `${base}${extension}`;
  for (let attempt = 2; lowered.has(candidate.toLowerCase()); attempt += 1) {
    candidate = `${base} ${attempt}${extension}`;
  }
  return candidate;
}
