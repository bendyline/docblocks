/**
 * The shell's catalog renderer: Squisq's script-free plain HTML exporter,
 * loaded only once a workspace enables a catalog. Scheduling, budgets, and
 * write safety live in core's shared `createWorkspaceOutputsScheduler`.
 */

import type { WorkspaceOutputsRenderer } from '@bendyline/docblocks/workspace-settings';

let defaultRenderer: Promise<WorkspaceOutputsRenderer> | null = null;

export function loadDefaultWorkspaceOutputsRenderer(): Promise<WorkspaceOutputsRenderer> {
  defaultRenderer ??= import('@bendyline/squisq-formats/html').then((formats) => {
    const { htmlToMarkdownDocSync, markdownDocToPlainHtml } = formats;
    // Squisq releases before page templates have no detector.
    const { isHtmlPageTemplate } = formats as Partial<{
      isHtmlPageTemplate: (html: string) => boolean;
    }>;
    return {
      renderCatalogHtml: (document, { title, themeId }) =>
        markdownDocToPlainHtml(document, { title, themeId }),
      importHtml: (html) => htmlToMarkdownDocSync(html),
      ...(typeof isHtmlPageTemplate === 'function' ? { isPageTemplate: isHtmlPageTemplate } : {}),
    };
  });
  return defaultRenderer;
}
