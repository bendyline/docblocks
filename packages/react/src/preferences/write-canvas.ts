import type { WriteCanvasSettings } from '@bendyline/squisq-editor-react';

export type WriteCanvasPreferences = Required<WriteCanvasSettings>;

export const WRITE_CANVAS_TEXT_SIZE_MIN = 12;
export const WRITE_CANVAS_TEXT_SIZE_MAX = 32;
export const WRITE_CANVAS_LINE_SPACING_MIN = 1.2;
export const WRITE_CANVAS_LINE_SPACING_MAX = 2.4;

export const DEFAULT_WRITE_CANVAS_PREFERENCES: Readonly<WriteCanvasPreferences> = {
  textSize: 16,
  lineSpacing: 1.7,
};

const WRITE_CANVAS_STORAGE_KEY = 'docblocks:writeCanvasSettings';

export function loadWriteCanvasPreferences(): WriteCanvasPreferences {
  try {
    const raw = localStorage.getItem(WRITE_CANVAS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WRITE_CANVAS_PREFERENCES };

    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)) return { ...DEFAULT_WRITE_CANVAS_PREFERENCES };

    return {
      textSize: numberInRange(
        stored.textSize,
        WRITE_CANVAS_TEXT_SIZE_MIN,
        WRITE_CANVAS_TEXT_SIZE_MAX,
      )
        ? stored.textSize
        : DEFAULT_WRITE_CANVAS_PREFERENCES.textSize,
      lineSpacing: numberInRange(
        stored.lineSpacing,
        WRITE_CANVAS_LINE_SPACING_MIN,
        WRITE_CANVAS_LINE_SPACING_MAX,
      )
        ? stored.lineSpacing
        : DEFAULT_WRITE_CANVAS_PREFERENCES.lineSpacing,
    };
  } catch {
    return { ...DEFAULT_WRITE_CANVAS_PREFERENCES };
  }
}

export function saveWriteCanvasPreferences(value: WriteCanvasPreferences): void {
  try {
    localStorage.setItem(WRITE_CANVAS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore unavailable storage and quota errors; the in-memory choice still works.
  }
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
