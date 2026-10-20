const STORAGE_KEY = 'docblocks:openAfterExport';

/** Shared by document and video export, independently of format and workspace. */
export function loadOpenAfterExport(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveOpenAfterExport(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Keep the current session's choice when preference storage is unavailable.
  }
}
