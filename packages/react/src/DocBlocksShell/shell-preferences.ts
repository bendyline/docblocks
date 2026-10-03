import type { ViewPreferences } from '@bendyline/squisq-editor-react';
import type { FileExplorerSortMode } from '../FileExplorer/entry-sort.js';
import type { DbSidebarPreference } from '../layout/form-factor.js';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../layout/form-factor.js';

export {
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../layout/form-factor.js';

const WELCOME_GATEWAY_KEY = 'docblocks:welcomeGatewayDismissed';
const SIDEBAR_WIDTH_KEY = 'docblocks:sidebarWidth';
const VIEW_PREFERENCES_KEY = 'docblocks:viewPreferences';
const FILE_EXPLORER_SORT_MODE_KEY = 'docblocks:fileExplorerSortMode';
const SIDEBAR_PREFERENCE_KEY = 'docblocks:sidebarMode';

const DEFAULT_VIEW_PREFERENCES: ViewPreferences = Object.freeze({
  outline: false,
  inlinePreview: true,
  showStatusBar: true,
});

export function isWelcomeGatewayDismissed(): boolean {
  try {
    return localStorage.getItem(WELCOME_GATEWAY_KEY) === '1';
  } catch {
    return false;
  }
}

export function markWelcomeGatewayDismissed(): void {
  try {
    localStorage.setItem(WELCOME_GATEWAY_KEY, '1');
  } catch {
    // First-run presentation state is best-effort.
  }
}

export function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function saveSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // Layout persistence is best-effort.
  }
}

/**
 * Load the sidebar preference.
 *
 * `collapsed` deliberately degrades to `auto` on load: a reload must never
 * strand someone in a hidden sidebar they cannot find their way back from.
 * `pinned` does persist, because that is the setting an iPad user makes once
 * and expects to keep.
 */
export function loadSidebarPreference(): DbSidebarPreference {
  try {
    return localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === 'pinned' ? 'pinned' : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveSidebarPreference(preference: DbSidebarPreference): void {
  try {
    if (preference === 'pinned') {
      localStorage.setItem(SIDEBAR_PREFERENCE_KEY, 'pinned');
    } else {
      localStorage.removeItem(SIDEBAR_PREFERENCE_KEY);
    }
  } catch {
    // Layout persistence is best-effort.
  }
}

export function loadFileExplorerSortMode(): FileExplorerSortMode {
  try {
    return localStorage.getItem(FILE_EXPLORER_SORT_MODE_KEY) === 'last-modified'
      ? 'last-modified'
      : 'name';
  } catch {
    return 'name';
  }
}

export function saveFileExplorerSortMode(mode: FileExplorerSortMode): void {
  try {
    localStorage.setItem(FILE_EXPLORER_SORT_MODE_KEY, mode);
  } catch {
    // File ordering persistence is best-effort.
  }
}

export function loadViewPreferences(): ViewPreferences {
  try {
    const raw = localStorage.getItem(VIEW_PREFERENCES_KEY);
    if (!raw) return DEFAULT_VIEW_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_VIEW_PREFERENCES;
    }
    const record = parsed as Record<string, unknown>;
    return {
      outline:
        typeof record.outline === 'boolean' ? record.outline : DEFAULT_VIEW_PREFERENCES.outline,
      inlinePreview:
        typeof record.inlinePreview === 'boolean'
          ? record.inlinePreview
          : DEFAULT_VIEW_PREFERENCES.inlinePreview,
      showStatusBar:
        typeof record.showStatusBar === 'boolean'
          ? record.showStatusBar
          : DEFAULT_VIEW_PREFERENCES.showStatusBar,
    };
  } catch {
    return DEFAULT_VIEW_PREFERENCES;
  }
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  try {
    localStorage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // View preference persistence is best-effort.
  }
}
