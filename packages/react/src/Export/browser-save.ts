import type { ExportDestinationAdapter } from './ExportToolbarControls.js';

export type BrowserSaveMode = 'downloads' | 'save-as';

const INSTALLED_DISPLAY_QUERIES = [
  '(display-mode: window-controls-overlay)',
  '(display-mode: standalone)',
] as const;

function isInstalledWebApp(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    INSTALLED_DISPLAY_QUERIES.some((query) => globalThis.matchMedia(query).matches)
  );
}

export function browserSaveMode(): BrowserSaveMode {
  return isInstalledWebApp() &&
    typeof window !== 'undefined' &&
    typeof window.showSaveFilePicker === 'function'
    ? 'save-as'
    : 'downloads';
}

export function saveActionLabel(format: string, mode: BrowserSaveMode): string {
  return mode === 'save-as'
    ? `Save ${format.toUpperCase()} as...`
    : `Save ${format.toUpperCase()} to Downloads`;
}

function isPickerCancellation(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

function pickerOptions(blob: Blob | null, filename: string): SaveFilePickerOptions {
  const extensionMatch = filename.match(/(\.[^./\\]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase();
  if (!extension) return { suggestedName: filename };

  const mimeType = blob?.type || 'application/octet-stream';
  return {
    suggestedName: filename,
    types: [
      {
        description: `${extension.slice(1).toUpperCase()} file`,
        accept: { [mimeType]: [extension] },
      },
    ],
  };
}

function savePickerFilename(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop() || 'document';
}

/**
 * Build the destination adapter used by an installed Chromium PWA. The picker
 * runs before conversion so its transient user activation is not lost while a
 * potentially expensive document export is being generated.
 */
export function createBrowserSaveAsAdapter(): ExportDestinationAdapter | undefined {
  if (browserSaveMode() !== 'save-as' || !window.showSaveFilePicker) return undefined;

  const handles = new Map<string, FileSystemFileHandle>();
  let nextGrantId = 0;

  return {
    pickBeforeSave: true,
    showDestination: false,
    async resolveTarget(filename) {
      return { grantId: null, displayPath: filename };
    },
    async pickTarget(filename) {
      try {
        const suggestedName = savePickerFilename(filename);
        const handle = await window.showSaveFilePicker?.(pickerOptions(null, suggestedName));
        if (!handle) return null;
        const grantId = `browser-save-${nextGrantId}`;
        nextGrantId += 1;
        handles.set(grantId, handle);
        return { grantId, displayPath: handle.name };
      } catch (caught: unknown) {
        if (isPickerCancellation(caught)) return null;
        throw caught;
      }
    },
    async saveBlob(blob, filename, target) {
      if (!target?.grantId) throw new Error('Choose a file before saving the export.');
      const handle = handles.get(target.grantId);
      if (!handle) throw new Error('Choose a file before saving the export.');

      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (caught: unknown) {
        try {
          await writable.abort();
        } catch {
          // Preserve the original write/close failure.
        }
        throw caught;
      }

      return target;
    },
  };
}
