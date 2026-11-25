/**
 * Tags that mark side information kept in a document (Squisq accessory block
 * types), never its title. Listed here rather than read from Squisq so the
 * shell, which shows the title at startup, does not load Squisq's document
 * code; a test keeps the list equal to Squisq's registry.
 */
export const SIDE_INFORMATION_TAGS: readonly string[] = ['summary', 'flashcard', 'quiz'];

const HEADING = /^#{1,6}\s+(.+?)\s*(\{.*)?$/gmu;

/** The document's title: frontmatter `title`, else its first heading that is not side information. */
export function documentTitle(source: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1] ?? '';
  const fromFrontmatter = /^title:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter)?.[1];
  if (fromFrontmatter) return fromFrontmatter;
  for (const match of source.matchAll(HEADING)) {
    const tag = /^\{\[([A-Za-z][\w-]*)/u.exec(match[2] ?? '')?.[1];
    if (tag && SIDE_INFORMATION_TAGS.includes(tag)) continue;
    return match[1] ?? '';
  }
  return '';
}
