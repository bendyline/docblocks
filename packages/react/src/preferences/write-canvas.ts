import type { WriteCanvasSettings } from '@bendyline/squisq-editor-react';

/**
 * Stable ids for the Write-canvas font schemes offered in Settings. This list
 * mirrors `DOCBLOCKS_WRITE_CANVAS_FONT_SCHEMES` in `@bendyline/docblocks/vscode`
 * (the wire/persisted contract) and the `docblocks.writeCanvasFontScheme` enum
 * in the VS Code `package.json`; a guard test keeps the three in sync.
 */
export type WriteCanvasFontScheme =
  | 'theme'
  | 'serif-sans'
  | 'sans-sans'
  | 'serif-serif'
  | 'pt-serif'
  | 'hanken'
  | 'playfair-pt-serif'
  | 'hanken-lora'
  | 'dm-serif-dm-sans'
  | 'inter';

export type WriteCanvasFontSchemeGroup = 'theme' | 'system' | 'curated';

export interface WriteCanvasFontSchemeOption {
  id: WriteCanvasFontScheme;
  label: string;
  group: WriteCanvasFontSchemeGroup;
  /** CSS font-family for headings. Omitted for `'theme'` (inherit). */
  headerFont?: string;
  /** CSS font-family for body text. Omitted for `'theme'` (inherit). */
  bodyFont?: string;
}

// Shared fallback stacks. The OS-default schemes resolve to these on every
// surface with no web font; the curated schemes name a self-hosted face and
// fall back to these when it hasn't loaded.
const SANS_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF_STACK = 'Georgia, "Times New Roman", serif';

/**
 * Curated Write-canvas font schemes, in picker order. A named scheme is an
 * explicit user preference and overrides the active theme in Write mode through
 * the DocBlocks host stylesheet. `'theme'` sets no fonts, i.e. inherits the
 * active theme / host as before.
 */
export const WRITE_CANVAS_FONT_SCHEMES: readonly WriteCanvasFontSchemeOption[] = [
  { id: 'theme', label: 'Inherit from theme', group: 'theme' },
  {
    id: 'serif-sans',
    label: 'Serif headings · Sans body',
    group: 'system',
    headerFont: SERIF_STACK,
    bodyFont: SANS_STACK,
  },
  {
    id: 'sans-sans',
    label: 'Sans headings · Sans body',
    group: 'system',
    headerFont: SANS_STACK,
    bodyFont: SANS_STACK,
  },
  {
    id: 'serif-serif',
    label: 'Serif headings · Serif body',
    group: 'system',
    headerFont: SERIF_STACK,
    bodyFont: SERIF_STACK,
  },
  {
    id: 'pt-serif',
    label: 'PT Serif',
    group: 'curated',
    headerFont: '"PT Serif", Georgia, serif',
    bodyFont: '"PT Serif", Georgia, serif',
  },
  {
    id: 'hanken',
    label: 'Hanken Grotesk',
    group: 'curated',
    headerFont: '"Hanken Grotesk", system-ui, sans-serif',
    bodyFont: '"Hanken Grotesk", system-ui, sans-serif',
  },
  {
    id: 'playfair-pt-serif',
    label: 'Playfair Display · PT Serif',
    group: 'curated',
    headerFont: '"Playfair Display", Georgia, serif',
    bodyFont: '"PT Serif", Georgia, serif',
  },
  {
    id: 'hanken-lora',
    label: 'Hanken Grotesk · Lora',
    group: 'curated',
    headerFont: '"Hanken Grotesk", system-ui, sans-serif',
    bodyFont: '"Lora", Georgia, serif',
  },
  {
    id: 'dm-serif-dm-sans',
    label: 'DM Serif Display · DM Sans',
    group: 'curated',
    headerFont: '"DM Serif Display", Georgia, serif',
    bodyFont: '"DM Sans", system-ui, sans-serif',
  },
  {
    id: 'inter',
    label: 'Inter',
    group: 'curated',
    headerFont: '"Inter", system-ui, sans-serif',
    bodyFont: '"Inter", system-ui, sans-serif',
  },
];

const FONT_SCHEMES_BY_ID = new Map(WRITE_CANVAS_FONT_SCHEMES.map((scheme) => [scheme.id, scheme]));

export const DEFAULT_WRITE_CANVAS_FONT_SCHEME: WriteCanvasFontScheme = 'theme';

/** Resolve a scheme id to the header/body CSS font-family strings (empty for `'theme'`). */
export function resolveWriteCanvasFonts(
  scheme: WriteCanvasFontScheme,
): Pick<WriteCanvasSettings, 'headerFont' | 'bodyFont'> {
  const option = FONT_SCHEMES_BY_ID.get(scheme);
  const resolved: Pick<WriteCanvasSettings, 'headerFont' | 'bodyFont'> = {};
  if (option?.headerFont) resolved.headerFont = option.headerFont;
  if (option?.bodyFont) resolved.bodyFont = option.bodyFont;
  return resolved;
}

function isWriteCanvasFontScheme(value: unknown): value is WriteCanvasFontScheme {
  return typeof value === 'string' && FONT_SCHEMES_BY_ID.has(value as WriteCanvasFontScheme);
}

/** Persisted Write-canvas preferences. Stores the font scheme id, not resolved fonts. */
export interface WriteCanvasPreferences {
  textSize: number;
  lineSpacing: number;
  fontScheme: WriteCanvasFontScheme;
}

export const WRITE_CANVAS_TEXT_SIZE_MIN = 12;
export const WRITE_CANVAS_TEXT_SIZE_MAX = 32;
export const WRITE_CANVAS_LINE_SPACING_MIN = 1;
export const WRITE_CANVAS_LINE_SPACING_MAX = 2.4;

export const DEFAULT_WRITE_CANVAS_PREFERENCES: Readonly<WriteCanvasPreferences> = {
  textSize: 16,
  lineSpacing: 1.7,
  fontScheme: DEFAULT_WRITE_CANVAS_FONT_SCHEME,
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
      // Older stored preferences predate fontScheme; fall back to the default.
      fontScheme: isWriteCanvasFontScheme(stored.fontScheme)
        ? stored.fontScheme
        : DEFAULT_WRITE_CANVAS_PREFERENCES.fontScheme,
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
