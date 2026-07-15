import { useEffect } from 'react';

const APP_TITLE = 'DocBlocks';

export function titleForSelectedFile(
  selectedFile: string | null,
  homeDocumentTitle = APP_TITLE,
  homeDocumentPath?: string,
): string {
  if (!selectedFile || selectedFile === homeDocumentPath) return homeDocumentTitle;

  const filename = selectedFile.replace(/^\/+/, '').split('/').pop();
  const name = filename?.replace(/\.[^.]+$/, '');
  return name ? `${name} - ${APP_TITLE}` : APP_TITLE;
}

export function useDocumentTitle(
  selectedFile: string | null,
  homeDocumentTitle?: string,
  homeDocumentPath?: string,
): void {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = titleForSelectedFile(selectedFile, homeDocumentTitle, homeDocumentPath);
    }
  }, [homeDocumentPath, homeDocumentTitle, selectedFile]);
}
