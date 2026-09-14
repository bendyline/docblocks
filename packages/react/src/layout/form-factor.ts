/**
 * The one place layout breakpoints are defined.
 *
 * There is no PostCSS in this repository, so `@custom-media` is unavailable and
 * native CSS cannot read a custom property inside a media condition. TypeScript
 * therefore owns the numbers and CSS keys off the `data-db-*` attributes stamped
 * by `useFormFactorAttributes`. That is already the house pattern — the theme is
 * stamped pre-paint by `packages/site/public/bootstrap-theme.js` and the
 * stylesheet keys off `[data-theme]`.
 *
 * `compactMax` is 720 rather than the shell's historical 768 so it coincides
 * with Squisq's own editor-body container query: below that width Squisq already
 * auto-hides the outline and inline preview, which is exactly the width at which
 * DocBlocks should stop offering a split view.
 */
export const DB_BREAKPOINTS = Object.freeze({
  /** Inclusive upper bound for phones and narrow slivers. */
  compactMax: 720,
  /** Inclusive upper bound for tablet-portrait and half-screen laptops. */
  mediumMax: 1023,
  /** Inclusive upper bound for tablet-landscape and laptops. */
  expandedMax: 1439,
  /**
   * Largest short edge still considered a phone. Orientation-independent on
   * purpose: a phone turned sideways is 844x390, which is `medium` by width but
   * is obviously not a tablet. The widest phone short edge in circulation is
   * around 430px; the narrowest tablet short edge is the iPad mini's 744px, so
   * 520 sits in open space between them.
   */
  phoneMaxShortEdge: 520,
});

/**
 * Sidebar geometry. Owned here rather than in `shell-preferences` so the layout
 * vocabulary has one home and imports flow in a single direction
 * (`shell-preferences` -> `layout`). Re-exported from `shell-preferences` for
 * existing callers.
 */
export const SIDEBAR_WIDTH_DEFAULT = 320;
export const SIDEBAR_WIDTH_MIN = 320;
export const SIDEBAR_WIDTH_MAX = 600;
/** Releasing the resizer below this collapses the sidebar into the drawer. */
export const SIDEBAR_COLLAPSE_THRESHOLD = SIDEBAR_WIDTH_MIN;

export const DB_LAYOUT_MINIMA = Object.freeze({
  /**
   * Narrower than this, an editor pane beside the sidebar is not worth the
   * split. Paired with `SIDEBAR_WIDTH_MIN` to derive `splitPaneAllowed`.
   */
  editorMinWidth: 480,
});

/** Smallest viewport that can host a sidebar and a usable editor side by side. */
export const SPLIT_PANE_MIN_WIDTH = SIDEBAR_WIDTH_MIN + DB_LAYOUT_MINIMA.editorMinWidth;

export type DbWidthClass = 'compact' | 'medium' | 'expanded' | 'wide';
export type DbPointer = 'coarse' | 'fine';
export type DbHover = 'hover' | 'none';
export type DbOrientation = 'portrait' | 'landscape';
export type DbFormFactor = 'phone' | 'tablet-portrait' | 'tablet-landscape' | 'desktop';
export type DbLayoutMode = 'single-pane' | 'split-pane';

/**
 * `auto` follows the form factor. `pinned` and `collapsed` are explicit user
 * choices made by pinning the sidebar or dragging the resizer shut.
 */
export type DbSidebarPreference = 'auto' | 'pinned' | 'collapsed';

export interface FormFactorInput {
  /** Measured width of the shell element, not the window. */
  readonly width: number;
  readonly height: number;
  readonly pointer: DbPointer;
  readonly hover: DbHover;
  /** Running as an installed PWA (standalone or window-controls-overlay). */
  readonly installed: boolean;
}

export interface FormFactor extends FormFactorInput {
  readonly widthClass: DbWidthClass;
  readonly orientation: DbOrientation;
  readonly formFactor: DbFormFactor;
  readonly splitPaneAllowed: boolean;
}

export function classifyWidth(width: number): DbWidthClass {
  if (width <= DB_BREAKPOINTS.compactMax) return 'compact';
  if (width <= DB_BREAKPOINTS.mediumMax) return 'medium';
  if (width <= DB_BREAKPOINTS.expandedMax) return 'expanded';
  return 'wide';
}

/**
 * Width and input modality are classified separately on purpose.
 *
 * The shell's previous single `useIsMobile(768)` boolean conflated them, which
 * is why an iPad in landscape inherited desktop hover-reveal affordances it can
 * never trigger. Keeping `pointer` distinct from `widthClass` also lets a 500px
 * desktop browser window get the drawer layout without being called a phone.
 */
export function classifyFormFactor(input: FormFactorInput): FormFactor {
  const widthClass = classifyWidth(input.width);
  const orientation: DbOrientation = input.height >= input.width ? 'portrait' : 'landscape';

  let formFactor: DbFormFactor;
  if (input.pointer === 'fine') {
    formFactor = 'desktop';
  } else if (Math.min(input.width, input.height) <= DB_BREAKPOINTS.phoneMaxShortEdge) {
    formFactor = 'phone';
  } else {
    formFactor = orientation === 'portrait' ? 'tablet-portrait' : 'tablet-landscape';
  }

  return {
    ...input,
    widthClass,
    orientation,
    formFactor,
    splitPaneAllowed: input.width >= SPLIT_PANE_MIN_WIDTH,
  };
}

/**
 * Resolve the pane layout. An explicit user preference wins over the form
 * factor, but nothing overrides a viewport too narrow to hold both panes.
 */
export function resolveLayoutMode(
  formFactor: FormFactor,
  preference: DbSidebarPreference,
): DbLayoutMode {
  if (!formFactor.splitPaneAllowed) return 'single-pane';
  if (preference === 'collapsed') return 'single-pane';
  if (preference === 'pinned') return 'split-pane';
  if (formFactor.widthClass === 'expanded' || formFactor.widthClass === 'wide') {
    return 'split-pane';
  }
  // 800-1023 with a fine pointer keeps the historical desktop split; the same
  // band on a touch device (an iPad in portrait) gets the overlay drawer.
  if (formFactor.pointer === 'fine') return 'split-pane';
  return 'single-pane';
}

/**
 * The contract between this module and `docblocks.css`. Every adaptive rule in
 * the stylesheet keys off one of these attributes rather than re-testing a
 * width, so the breakpoints above stay the single source of truth.
 */
export function formFactorDataAttributes(
  formFactor: FormFactor,
  layoutMode: DbLayoutMode,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'data-db-width': formFactor.widthClass,
    'data-db-form-factor': formFactor.formFactor,
    'data-db-pointer': formFactor.pointer,
    'data-db-hover': formFactor.hover,
    'data-db-orientation': formFactor.orientation,
    'data-db-layout': layoutMode,
  });
}
