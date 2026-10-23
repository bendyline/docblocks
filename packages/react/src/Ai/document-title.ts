/** The document's title: frontmatter `title`, else its first heading. */
export function documentTitle(source: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1] ?? '';
  const fromFrontmatter = /^title:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter)?.[1];
  if (fromFrontmatter) return fromFrontmatter;
  return /^#{1,6}\s+(.+?)\s*(\{.*)?$/mu.exec(source)?.[1] ?? '';
}
