/**
 * Dashboard image (`png`) conversion controls.
 *
 * Squisq's Dashboard mode projects a whole document onto one canvas, and the
 * linked registry's `png` format renders that projection to a raster image.
 * Three axes shape the result:
 *
 * - **size** — a named resolution preset, or explicit pixel dimensions
 * - **layout** — which dashboard layout places the cells (`auto` picks by
 *   block count), including layouts the document defines in frontmatter
 * - **style** — the cell dressing (`basic`/`card`/`panel`/`accent`)
 *
 * The document's own `squisq-dashboard-*` frontmatter supplies every axis a
 * caller leaves unset, so an unqualified `convert -f png` honors what the
 * author wrote. Validation lives here rather than at each call site so the
 * `convert` command and the MCP conversion service reject the same inputs
 * with the same messages — and reject them BEFORE a browser is launched.
 */

import type { Doc } from '@bendyline/squisq/schemas';
import type { PngFormatOptions } from '@bendyline/squisq-cli/api';

/** Caller-supplied dashboard image controls, before validation. */
export interface DashboardImageInput {
  /** Named resolution preset id (for example `fhd`, `4k`, `square`). */
  resolution?: string;
  /** Custom pixel width; requires `height` and excludes `resolution`. */
  width?: string | number;
  /** Custom pixel height; requires `width` and excludes `resolution`. */
  height?: string | number;
  /** Dashboard layout id, or `auto` for the block-count pick. */
  layout?: string;
  /** Cell style variant. */
  style?: string;
  /** Render the document-title band. */
  title?: boolean;
}

/** Validated options ready to hand to the registry as `formatOptions.png`. */
export type DashboardImageOptions = Omit<PngFormatOptions, 'onProgress'>;

/** True when the caller set any dashboard image control. */
export function hasDashboardImageInput(input: DashboardImageInput): boolean {
  return (
    input.resolution !== undefined ||
    input.width !== undefined ||
    input.height !== undefined ||
    input.layout !== undefined ||
    input.style !== undefined ||
    input.title !== undefined
  );
}

/** Parse a pixel count that may arrive as a Commander string. */
function pixelCount(value: string | number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`The ${flag} must be a whole number of pixels.`);
  }
  return parsed;
}

/**
 * Validate the size, layout, and style axes.
 *
 * Everything checkable without the document is checked here. The layout id
 * is only normalized, because a document may define its own layouts in
 * frontmatter — {@link assertKnownDashboardLayout} finishes that check once
 * the document has been read.
 */
export async function resolveDashboardImageOptions(
  input: DashboardImageInput,
): Promise<DashboardImageOptions> {
  const [{ resolveDashboardStyleId, DASHBOARD_STYLE_IDS }, video] = await Promise.all([
    import('@bendyline/squisq/doc'),
    import('@bendyline/squisq-video'),
  ]);

  const width = pixelCount(input.width, '--image-width');
  const height = pixelCount(input.height, '--image-height');
  // Preset-vs-custom conflicts, both-or-neither, bounds, and the megapixel
  // cap all raise a descriptive RangeError from the shared Squisq validator,
  // so the browser dialog and the CLI accept exactly the same dimensions.
  const dimensions = video.resolveDashboardDimensions({
    resolution: input.resolution,
    width,
    height,
  });

  const options: DashboardImageOptions = {};
  if (input.resolution !== undefined) {
    options.resolution = input.resolution as PngFormatOptions['resolution'];
  } else if (width !== undefined && height !== undefined) {
    options.width = dimensions.width;
    options.height = dimensions.height;
  }

  if (input.layout !== undefined) {
    const layout = input.layout.trim().toLowerCase();
    if (!layout) throw new Error('The --image-layout id must be a non-empty string.');
    options.layout = layout;
  }

  // The style vocabulary is closed, so an unknown value fails here rather
  // than silently rendering the document's own style.
  if (input.style !== undefined) {
    const style = resolveDashboardStyleId(input.style);
    if (!style) {
      throw new Error(
        `Unknown dashboard style "${input.style}". Valid: ${DASHBOARD_STYLE_IDS.join(', ')}`,
      );
    }
    options.style = style;
  }

  if (input.title !== undefined) options.title = input.title;
  return options;
}

/**
 * Reject a layout id the document cannot actually use. Deferred until the
 * document is available because `listDashboardLayouts` includes the custom
 * layouts a document declares in its own frontmatter alongside the built-ins.
 */
export async function assertKnownDashboardLayout(
  layout: string | undefined,
  doc: Doc,
): Promise<void> {
  if (!layout) return;
  const { DASHBOARD_AUTO_LAYOUT_ID, listDashboardLayouts } = await import('@bendyline/squisq/doc');
  if (layout === DASHBOARD_AUTO_LAYOUT_ID) return;
  const available = listDashboardLayouts(doc);
  if (available.some((entry) => entry.id === layout)) return;
  const known = available.map((entry) => entry.id).join(', ');
  throw new Error(
    `Unknown dashboard layout "${layout}". Valid: ${DASHBOARD_AUTO_LAYOUT_ID}, ${known}`,
  );
}

/** Named resolution presets, for help text and capability reporting. */
export async function listDashboardResolutions(): Promise<
  readonly { id: string; label: string; width: number; height: number }[]
> {
  const { DASHBOARD_RESOLUTIONS } = await import('@bendyline/squisq-video');
  return DASHBOARD_RESOLUTIONS.map(({ id, label, width, height }) => ({
    id,
    label,
    width,
    height,
  }));
}
