/**
 * Social preview pictures for rendered Web pages: the 1200×630 card Open
 * Graph and Twitter show when a page is shared, drawn in the document's
 * theme — its colors and its title and body fonts.
 *
 * Browser-only. The card is painted on a canvas rather than drawn as SVG: an
 * SVG loaded as an image cannot use the page's web fonts, while a canvas can
 * once `document.fonts` has loaded them, and every host page serves the theme
 * fonts. The layout is computed apart from the painting so it can be checked
 * without a canvas.
 */

import { resolveFontFamily, type Theme } from '@bendyline/squisq/schemas';

export const SOCIAL_IMAGE_WIDTH = 1200;
export const SOCIAL_IMAGE_HEIGHT = 630;
export const SOCIAL_IMAGE_TYPE = 'image/png';

export interface SocialImageContent {
  title: string;
  description?: string;
  /** A short label for the site, such as its host name, set along the bottom. */
  site?: string;
  theme: Theme;
}

/** Draws a card and returns its PNG bytes. */
export type SocialImagePainter = (content: SocialImageContent) => Promise<Uint8Array>;

/** Width in pixels of `text` set in the CSS `font`. */
export type MeasureText = (text: string, font: string) => number;

export interface SocialImageTextBlock {
  /** CSS font shorthand. */
  font: string;
  color: string;
  lines: string[];
  /** Top of the first line box. */
  top: number;
  lineHeight: number;
}

export interface SocialImageLayout {
  title: SocialImageTextBlock;
  description: SocialImageTextBlock | null;
  site: SocialImageTextBlock | null;
}

const MARGIN_X = 88;
const TEXT_WIDTH = SOCIAL_IMAGE_WIDTH - 2 * MARGIN_X;
const ACCENT_TOP = 100;
const ACCENT_HEIGHT = 10;
const ACCENT_WIDTH = 96;
/** Title and description share this band, centered in it together. */
const STACK_TOP = ACCENT_TOP + ACCENT_HEIGHT + 40;
const STACK_BOTTOM = 486;
const STACK_GAP = 24;
const STRIP_HEIGHT = 14;
const TITLE_SIZES = [80, 72, 64, 56, 50] as const;
const TITLE_MAX_LINES = 3;
const DESCRIPTION_SIZE = 30;
const DESCRIPTION_MAX_LINES = 2;
const SITE_SIZE = 28;
const SANS_FALLBACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";

function fonts(theme: Theme): { title: string; titleWeight: number; body: string } {
  return {
    title: resolveFontFamily(theme.typography.titleFont, SERIF_FALLBACK),
    titleWeight: theme.typography.titleWeight === 'normal' ? 400 : 700,
    body: resolveFontFamily(theme.typography.bodyFont, SANS_FALLBACK),
  };
}

/** Where every line of text on the card goes. */
export function layoutSocialImage(
  content: SocialImageContent,
  measure: MeasureText,
): SocialImageLayout {
  const { colors } = content.theme;
  const family = fonts(content.theme);

  // The largest title size that fits; at the smallest, the title is clipped.
  let title: SocialImageTextBlock | null = null;
  for (const size of TITLE_SIZES) {
    const font = `${String(family.titleWeight)} ${String(size)}px ${family.title}`;
    const lines = wrapText(content.title, font, TEXT_WIDTH, measure);
    if (lines.length <= TITLE_MAX_LINES || size === TITLE_SIZES[TITLE_SIZES.length - 1]) {
      title = {
        font,
        color: colors.text,
        lines: clampLines(lines, TITLE_MAX_LINES, font, TEXT_WIDTH, measure),
        top: 0,
        lineHeight: Math.round(size * 1.12),
      };
      break;
    }
  }
  title ??= { font: '', color: colors.text, lines: [], top: 0, lineHeight: 0 };

  const titleHeight = title.lines.length * title.lineHeight;
  const descriptionFont = `400 ${String(DESCRIPTION_SIZE)}px ${family.body}`;
  const descriptionLineHeight = Math.round(DESCRIPTION_SIZE * 1.4);
  const room = Math.floor(
    (STACK_BOTTOM - STACK_TOP - titleHeight - STACK_GAP) / descriptionLineHeight,
  );
  const descriptionLines = content.description?.trim()
    ? clampLines(
        wrapText(content.description, descriptionFont, TEXT_WIDTH, measure),
        Math.min(DESCRIPTION_MAX_LINES, room),
        descriptionFont,
        TEXT_WIDTH,
        measure,
      )
    : [];
  const description: SocialImageTextBlock | null =
    descriptionLines.length > 0
      ? {
          font: descriptionFont,
          color: colors.textMuted,
          lines: descriptionLines,
          top: 0,
          lineHeight: descriptionLineHeight,
        }
      : null;

  const stackHeight =
    titleHeight + (description ? STACK_GAP + description.lines.length * description.lineHeight : 0);
  title.top = Math.round(STACK_TOP + Math.max(0, (STACK_BOTTOM - STACK_TOP - stackHeight) / 2));
  if (description) description.top = title.top + titleHeight + STACK_GAP;

  const siteFont = `600 ${String(SITE_SIZE)}px ${family.body}`;
  const siteLines = content.site?.trim()
    ? clampLines(
        wrapText(content.site, siteFont, TEXT_WIDTH, measure),
        1,
        siteFont,
        TEXT_WIDTH,
        measure,
      )
    : [];
  const siteLineHeight = Math.round(SITE_SIZE * 1.3);
  const site: SocialImageTextBlock | null =
    siteLines.length > 0
      ? {
          font: siteFont,
          color: colors.highlight,
          lines: siteLines,
          top: SOCIAL_IMAGE_HEIGHT - STRIP_HEIGHT - 48 - siteLineHeight,
          lineHeight: siteLineHeight,
        }
      : null;

  return { title, description, site };
}

/** Greedy word wrap; a word wider than a line is broken between characters. */
function wrapText(text: string, font: string, maxWidth: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, font) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    let rest = [...word];
    while (rest.length > 1 && measure(rest.join(''), font) > maxWidth) {
      let fit = rest.length - 1;
      while (fit > 1 && measure(rest.slice(0, fit).join(''), font) > maxWidth) fit--;
      lines.push(rest.slice(0, fit).join(''));
      rest = rest.slice(fit);
    }
    line = rest.join('');
  }
  if (line) lines.push(line);
  return lines;
}

/** At most `maxLines`, the last ending in an ellipsis when text was cut. */
function clampLines(
  lines: string[],
  maxLines: number,
  font: string,
  maxWidth: number,
  measure: MeasureText,
): string[] {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = [...kept[maxLines - 1]];
  while (last.length > 0 && measure(`${last.join('')}…`, font) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.join('').replace(/[\s,.;:–—-]+$/u, '')}…`;
  return kept;
}

/** Paint a card on a canvas with the theme's fonts and read it back as PNG. */
export const paintSocialImage: SocialImagePainter = async (content) => {
  const canvas = document.createElement('canvas');
  canvas.width = SOCIAL_IMAGE_WIDTH;
  canvas.height = SOCIAL_IMAGE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas is available to draw the social preview picture.');
  const measure: MeasureText = (text, font) => {
    context.font = font;
    return context.measureText(text).width;
  };

  // Measure with the theme's own faces, not a fallback that is drawn instead.
  const family = fonts(content.theme);
  const sample = `${content.title} ${content.description ?? ''} ${content.site ?? ''}`;
  await Promise.all(
    [
      `${String(family.titleWeight)} ${String(TITLE_SIZES[0])}px ${family.title}`,
      `400 ${String(DESCRIPTION_SIZE)}px ${family.body}`,
      `600 ${String(SITE_SIZE)}px ${family.body}`,
    ].map((font) => document.fonts?.load(font, sample).catch(() => [])),
  );
  const layout = layoutSocialImage(content, measure);
  const { colors } = content.theme;

  // Each fill starts from a safe color: canvas ignores a value it can't parse.
  const fill = (color: string, fallback: string): void => {
    context.fillStyle = fallback;
    context.fillStyle = color;
  };

  const background = context.createLinearGradient(0, 0, SOCIAL_IMAGE_WIDTH, SOCIAL_IMAGE_HEIGHT);
  try {
    background.addColorStop(0, colors.background);
    background.addColorStop(1, colors.backgroundLight);
    context.fillStyle = background;
  } catch {
    fill(colors.background, '#ffffff');
  }
  context.fillRect(0, 0, SOCIAL_IMAGE_WIDTH, SOCIAL_IMAGE_HEIGHT);

  // Two soft discs of the theme's colors in the top corner.
  context.globalAlpha = 0.16;
  fill(colors.primary, '#2563eb');
  context.beginPath();
  context.arc(SOCIAL_IMAGE_WIDTH - 70, 60, 260, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 0.14;
  fill(colors.secondary, '#475569');
  context.beginPath();
  context.arc(SOCIAL_IMAGE_WIDTH - 250, -40, 150, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  fill(colors.primary, '#2563eb');
  context.fillRect(MARGIN_X, ACCENT_TOP, ACCENT_WIDTH, ACCENT_HEIGHT);

  const strip = context.createLinearGradient(0, 0, SOCIAL_IMAGE_WIDTH, 0);
  try {
    strip.addColorStop(0, colors.primary);
    strip.addColorStop(1, colors.secondary);
    context.fillStyle = strip;
  } catch {
    fill(colors.primary, '#2563eb');
  }
  context.fillRect(0, SOCIAL_IMAGE_HEIGHT - STRIP_HEIGHT, SOCIAL_IMAGE_WIDTH, STRIP_HEIGHT);

  context.textBaseline = 'middle';
  context.textAlign = 'left';
  for (const block of [layout.title, layout.description, layout.site]) {
    if (!block) continue;
    context.font = block.font;
    fill(block.color, '#111111');
    block.lines.forEach((line, index) => {
      context.fillText(line, MARGIN_X, block.top + block.lineHeight * (index + 0.5), TEXT_WIDTH);
    });
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, SOCIAL_IMAGE_TYPE),
  );
  if (!blob) throw new Error('The social preview picture could not be encoded as PNG.');
  return new Uint8Array(await blob.arrayBuffer());
};
