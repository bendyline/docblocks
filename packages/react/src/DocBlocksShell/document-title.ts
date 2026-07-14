import { useEffect } from 'react';

const APP_TITLE = 'DocBlocks';

export function titleForSelectedFile(selectedFile: string | null): string {
  if (!selectedFile) return APP_TITLE;

  const filename = selectedFile.replace(/^\/+/, '').split('/').pop();
  const name = filename?.replace(/\.[^.]+$/, '');
  return name ? `${name} - ${APP_TITLE}` : APP_TITLE;
}

export function useDocumentTitle(selectedFile: string | null): void {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = titleForSelectedFile(selectedFile);
    }
  }, [selectedFile]);
}
