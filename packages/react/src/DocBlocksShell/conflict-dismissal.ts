import type { DocumentSessionConflict } from '@bendyline/docblocks/document';

/** The outside version the user had in front of them when they dismissed the banner. */
export type DismissedConflict = Pick<
  DocumentSessionConflict,
  'targetKey' | 'externalContent' | 'externalVersion'
>;

export function dismissConflict(conflict: DocumentSessionConflict): DismissedConflict {
  return {
    targetKey: conflict.targetKey,
    externalContent: conflict.externalContent,
    externalVersion: conflict.externalVersion,
  };
}

/**
 * Whether `conflict` is still the one the user dismissed. Only the outside
 * branch counts: typing updates the local branch on every keystroke and must
 * not bring the banner back, but each newer outside change is a new conflict
 * the user has not seen.
 */
export function isConflictDismissed(
  conflict: DocumentSessionConflict,
  dismissed: DismissedConflict | null,
): boolean {
  return (
    dismissed !== null &&
    conflict.targetKey === dismissed.targetKey &&
    conflict.externalVersion === dismissed.externalVersion &&
    conflict.externalContent === dismissed.externalContent
  );
}
