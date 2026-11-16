/**
 * How far main.tsx zooms the iPhone viewport.
 *
 * At 1pt per CSS pixel an iPhone draws the shell at about 153 CSS px per inch,
 * where it reads small. The Android phones the shell is sized on draw nearer
 * 120: a Galaxy S20 FE with Display size raised runs at 3.375 device pixels
 * per CSS px, about 121 per inch, and Android WebView also scales page text by
 * the system font size, which WKWebView ignores. A 1.3 zoom puts a 6.7"
 * iPhone at about 118 CSS px per inch, level with that S20 FE.
 */
export const IPHONE_SCALE = 1.3;

/**
 * Narrowest layout the phone shell is built and tested at — that S20 FE lays
 * out exactly 320 CSS px across. A narrower iPhone zooms less rather than drop
 * below it: a 430pt iPhone takes the full 1.3 (331px), a 393pt one 1.228, a
 * 375pt one 1.171.
 */
export const IPHONE_MIN_LAYOUT_WIDTH = 320;

/**
 * The zoom for an iPhone whose screen measures `width` x `height` points.
 * The short edge decides, so the result is the same in either orientation.
 * Floored to three decimals, so the meta tag and `--db-viewport-scale` carry
 * the same number and the layout never rounds below the minimum width.
 */
export function iphoneViewportScale(width: number, height: number): number {
  const shortEdge = Math.min(width, height);
  if (!(shortEdge > 0)) return 1;
  const scale = Math.min(IPHONE_SCALE, shortEdge / IPHONE_MIN_LAYOUT_WIDTH);
  return Math.max(1, Math.floor(scale * 1000) / 1000);
}
