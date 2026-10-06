/**
 * Make model-written text safe to place inside generated diagram markup.
 *
 * Diagram syntax only ever comes from the compiler, so the one way to break
 * out of it is through label text. Each character that Mermaid or a Squisq
 * annotation treats as syntax is swapped for a look-alike, and line breaks are
 * collapsed, so a label can never close a quote, start a directive
 * (`%%{init}`), add a statement, or begin a new heading.
 */

const LOOKALIKES: Readonly<Record<string, string>> = {
  '"': "'",
  '`': "'",
  ';': ',',
  '<': '‹',
  '>': '›',
  '{': '(',
  '}': ')',
  '[': '(',
  ']': ')',
  '|': '/',
  '\\': '/',
};

/** Single-line text with syntax characters replaced, clipped to `max` characters. */
export function cleanLabel(value: string, max: number): string {
  const flat = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  let mapped = '';
  for (const char of flat) mapped += LOOKALIKES[char] ?? char;
  return clip(mapped, max);
}

/** Clip at a word boundary when one is close, marking the cut with an ellipsis. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const hard = value.slice(0, Math.max(1, max - 1));
  const space = hard.lastIndexOf(' ');
  // Keep the hard cut when it already ends on a whole word.
  const cut = value[hard.length] === ' ' || space < max * 0.5 ? hard : hard.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** A label safe for a Mermaid participant alias, where `:` ends the alias. */
export function participantLabel(value: string, max: number): string {
  return cleanLabel(value, max).replace(/:/gu, '∶');
}

/**
 * A paragraph line safe as markdown body text: cleaned, with any leading
 * character that would turn it into a heading, list, quote, or rule escaped.
 */
export function bodyLine(value: string, max: number): string {
  const text = cleanLabel(value, max);
  return /^(#|[-*+](\s|$)|\d+[.)](\s|$)|=+$|_{3,})/u.test(text) ? `\\${text}` : text;
}

/** A unique, readable id built from `text`, avoiding every id in `taken`. */
export function slugId(prefix: string, text: string, taken: Set<string>): string {
  // Whole words up to 24 characters, so ids never end mid-word.
  let slug = '';
  for (const word of text
    .normalize('NFKD')
    .toLowerCase()
    .match(/[a-z0-9]+/gu) ?? []) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 24) {
      if (!slug) slug = word.slice(0, 24);
      break;
    }
    slug = next;
  }
  const base = slug ? `${prefix}-${slug}` : prefix;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  taken.add(id);
  return id;
}
