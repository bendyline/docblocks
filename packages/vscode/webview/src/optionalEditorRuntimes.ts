/** Fence types with a dedicated non-Monaco renderer in the Write canvas. */
const NON_MONACO_FENCE_LANGUAGES = new Set([
  'text',
  'txt',
  'plaintext',
  'plain',
  'ascii',
  'diagram',
  'tree',
  'timeline',
  'mermaid',
]);

/**
 * Whether Squisq's Write canvas will mount an embedded Monaco code editor.
 *
 * This mirrors Squisq's explicit-language fence gate without importing the
 * full editor package into the VS Code startup entry. It is deliberately
 * conservative: an unfamiliar explicit language is a Monaco code snippet,
 * while unlabelled and dedicated diagram/text fences are not.
 */
export function markdownUsesMonacoWidget(markdown: string): boolean {
  const openingFence = /^(?: {0,3})(?:`{3,}|~{3,})[\t ]*([^\s`~]+).*$/gmu;
  for (const match of markdown.matchAll(openingFence)) {
    const language = match[1]?.toLowerCase();
    if (language && !NON_MONACO_FENCE_LANGUAGES.has(language)) return true;
  }
  return false;
}
