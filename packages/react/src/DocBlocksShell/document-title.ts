import { useEffect } from 'react';

const APP_TITLE = 'DocBlocks';
const INSTALLED_DISPLAY_QUERIES = [
  '(display-mode: window-controls-overlay)',
  '(display-mode: standalone)',
] as const;

function unbrandedHomeTitle(homeDocumentTitle: string): string {
  if (homeDocumentTitle === APP_TITLE) return '';
  for (const separator of [' — ', ' - ', ': ', ' | ']) {
    const prefix = `${APP_TITLE}${separator}`;
    if (homeDocumentTitle.startsWith(prefix)) return homeDocumentTitle.slice(prefix.length);
  }
  return homeDocumentTitle;
}

export function titleForSelectedFile(
  selectedFile: string | null,
  homeDocumentTitle = APP_TITLE,
  homeDocumentPath?: string,
  includeAppName = true,
): string {
  if (!selectedFile || selectedFile === homeDocumentPath) {
    return includeAppName ? homeDocumentTitle : unbrandedHomeTitle(homeDocumentTitle);
  }

  const filename = selectedFile.replace(/^\/+/, '').split('/').pop();
  const name = filename?.replace(/\.[^.]+$/, '');
  if (!name) return includeAppName ? APP_TITLE : '';
  return includeAppName ? `${name} - ${APP_TITLE}` : name;
}

export function useDocumentTitle(
  selectedFile: string | null,
  homeDocumentTitle?: string,
  homeDocumentPath?: string,
): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const displayQueries =
      typeof globalThis.matchMedia === 'function'
        ? INSTALLED_DISPLAY_QUERIES.map((query) => globalThis.matchMedia(query))
        : [];
    const updateTitle = (): void => {
      const includeAppName = !displayQueries.some((query) => query.matches);
      document.title = titleForSelectedFile(
        selectedFile,
        homeDocumentTitle,
        homeDocumentPath,
        includeAppName,
      );
    };

    updateTitle();
    for (const query of displayQueries) query.addEventListener('change', updateTitle);
    return () => {
      for (const query of displayQueries) query.removeEventListener('change', updateTitle);
    };
  }, [homeDocumentPath, homeDocumentTitle, selectedFile]);
}
