/** Rewrite owned media references after a Markdown companion changes name. */
export async function rewriteCompanionReferences(
  content: string,
  oldPath: string,
  newPath: string,
): Promise<string> {
  const companionName = (path: string) =>
    path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '') + '_files';
  const oldName = companionName(oldPath);
  const newName = companionName(newPath);
  if (oldName === newName || (!content.includes(oldName) && !content.includes(encodeURI(oldName))))
    return content;
  const { parseMarkdown, stringifyMarkdown } = await import('@bendyline/squisq/markdown');
  const document = parseMarkdown(content);
  let changed = false;
  const rewrite = (value: string): string => {
    const relative = value.startsWith('./') ? './' : '';
    const path = value.slice(relative.length);
    for (const [before, after] of [
      [oldName, newName],
      [encodeURI(oldName), encodeURI(newName)],
    ]) {
      if (path.startsWith(`${before}/`)) {
        changed = true;
        return `${relative}${after}/${path.slice(before.length + 1)}`;
      }
    }
    return value;
  };
  const mediaFields = new Set([
    'src',
    'href',
    'poster',
    'audio',
    'video',
    'image',
    'backgroundImage',
  ]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      ['image', 'link', 'definition'].includes(String(node.type)) &&
      typeof node.url === 'string'
    ) {
      node.url = rewrite(node.url);
    }
    if (
      (node.type === 'htmlBlock' || node.type === 'htmlInline') &&
      typeof node.rawHtml === 'string'
    ) {
      node.rawHtml = node.rawHtml.replace(/<(?:img|audio|video|source|a)\b[^>]*>/gi, (tag) =>
        tag.replace(
          /(\s)(src|href|poster)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
          (
            _match,
            space: string,
            name: string,
            equals: string,
            doubleQuoted: string | undefined,
            singleQuoted: string | undefined,
            unquoted: string | undefined,
          ) => {
            const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
            return `${space}${name}${equals}${quote}${rewrite(doubleQuoted ?? singleQuoted ?? unquoted ?? '')}${quote}`;
          },
        ),
      );
    }
    for (const field of ['attributes', 'params']) {
      const attributes = node[field];
      if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
        const values = attributes as Record<string, unknown>;
        for (const key of mediaFields)
          if (typeof values[key] === 'string') values[key] = rewrite(values[key]);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'frontmatter' && key !== 'position' && key !== 'htmlChildren') visit(child);
    }
  };
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const block of document.children) {
    changed = false;
    visit(block);
    if (!changed) continue;
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error('Cannot locate a media reference in the Markdown source.');
    }
    let text = stringifyMarkdown({ type: 'document', children: [block] }).replace(/\n+$/, '');
    if (content.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
    replacements.push({ start, end, text });
  }
  // Preserve frontmatter, prose and code outside the changed parsed blocks.
  for (const replacement of replacements.reverse()) {
    content =
      content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
  }
  return content;
}
