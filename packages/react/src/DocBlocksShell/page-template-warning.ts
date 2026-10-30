import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type { OutsideInTemplateError } from './outside-in.js';

/**
 * A page whose Markdown saved while its page template kept the page itself
 * from regenerating. Keyed by the rendered page, so a late commit from the
 * previously open document never shows against the current one.
 */
export interface PageTemplateWarning {
  /** Canonical workspace path of the rendered page. */
  targetPath: string;
  message: string;
  dismissed: boolean;
}

export function pageTemplateWarningFor(
  targetPath: string,
  renderBlocked: OutsideInTemplateError | null | undefined,
): PageTemplateWarning | null {
  return renderBlocked
    ? {
        targetPath: parseWorkspacePath(targetPath),
        message: renderBlocked.message,
        dismissed: false,
      }
    : null;
}

/**
 * Fold one commit's outcome into the current warning. Autosave reports the
 * same blocked render on every keystroke, so an unchanged problem returns the
 * current warning as is: a Dismiss holds until the problem changes or a
 * render succeeds.
 */
export function nextPageTemplateWarning(
  current: PageTemplateWarning | null,
  targetPath: string,
  renderBlocked: OutsideInTemplateError | null,
): PageTemplateWarning | null {
  const target = parseWorkspacePath(targetPath);
  if (!renderBlocked) return current?.targetPath === target ? null : current;
  if (current?.targetPath === target && current.message === renderBlocked.message) return current;
  return pageTemplateWarningFor(target, renderBlocked);
}

/** Drop the warning once a template pass regenerated its page. */
export function clearRegeneratedPageTemplateWarning(
  current: PageTemplateWarning | null,
  updatedPages: readonly string[],
): PageTemplateWarning | null {
  if (!current) return current;
  return updatedPages.some((page) => parseWorkspacePath(page) === current.targetPath)
    ? null
    : current;
}

export function isPageTemplateWarningFor(
  warning: PageTemplateWarning | null,
  targetPath: string | null | undefined,
): warning is PageTemplateWarning {
  return (
    warning !== null &&
    !warning.dismissed &&
    !!targetPath &&
    warning.targetPath === parseWorkspacePath(targetPath)
  );
}
