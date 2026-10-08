/**
 * Synchronous outside-in path layout.
 *
 * The canonical contract is `@bendyline/squisq-formats/outside-in`, but that
 * entry also loads every format runtime. DocBlocks surfaces that only need
 * the path rules — the shell's navigation, the workspace catalog walker, and
 * the VS Code extension host — share this one copy instead.
 */

export const OUTSIDE_IN_FORMAT_IDS = ['html', 'docx', 'pdf', 'pptx', 'xlsx', 'csv'] as const;
export type OutsideInFormatId = (typeof OUTSIDE_IN_FORMAT_IDS)[number];
const FORMAT_IDS = new Set<string>(OUTSIDE_IN_FORMAT_IDS);

export interface OutsideInLayout {
  targetPath: string;
  format: OutsideInFormatId;
  parentDirectory: string;
  stem: string;
  companionName: string;
  companionDirectory: string;
  markdownFilename: string;
  markdownPath: string;
  relativeTargetPath: string;
  backupDirectory: string;
  backupFilename: string;
  backupPath: string;
}

function normalizePath(path: string): string {
  const leading = path.replace(/\\/g, '/').startsWith('/') ? '/' : '';
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Outside-in paths must be canonical workspace paths: ${path}`);
  }
  return leading + parts.join('/');
}

function join(parent: string, child: string): string {
  if (!parent || parent === '/') return parent === '/' ? `/${child}` : child;
  return `${parent}/${child}`;
}

function slug(stem: string): string {
  return (
    stem
      .normalize('NFKD')
      .replace(/\p{Mark}+/gu, '')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'document'
  );
}

export function resolveOutsideInLayout(path: string): OutsideInLayout | null {
  const targetPath = normalizePath(path);
  const slash = targetPath.lastIndexOf('/');
  const parentDirectory = slash < 0 ? '' : slash === 0 ? '/' : targetPath.slice(0, slash);
  const filename = slash < 0 ? targetPath : targetPath.slice(slash + 1);
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const rawFormat = filename.slice(dot + 1).toLowerCase();
  const format = rawFormat === 'htm' ? 'html' : rawFormat;
  if (!FORMAT_IDS.has(format)) return null;
  const stem = filename.slice(0, dot);
  const companionName = `${stem}_files`;
  const companionDirectory = join(parentDirectory, companionName);
  const markdownFilename = `${slug(stem)}.md`;
  const backupDirectory = join(companionDirectory, '.original');
  const backupFilename = `original.${format}`;
  return {
    targetPath,
    format: format as OutsideInFormatId,
    parentDirectory,
    stem,
    companionName,
    companionDirectory,
    markdownFilename,
    markdownPath: join(companionDirectory, markdownFilename),
    relativeTargetPath: `../${filename}`,
    backupDirectory,
    backupFilename,
    backupPath: join(backupDirectory, backupFilename),
  };
}

/** Move the companion root while preserving the authored Markdown slug. */
export function relocateOutsideInLayout(
  layout: OutsideInLayout,
  targetPath: string,
): OutsideInLayout {
  const next = resolveOutsideInLayout(targetPath);
  if (!next || next.format !== layout.format)
    throw new Error('Keep the outside-in document format when moving it.');
  const root = `${normalizePath(layout.companionDirectory).replace(/\/$/, '')}/`;
  const source = normalizePath(layout.markdownPath);
  if (!source.startsWith(root))
    throw new Error('The Markdown source is outside its companion directory.');
  const markdownPath = join(next.companionDirectory, source.slice(root.length));
  return { ...next, markdownPath, markdownFilename: layout.markdownFilename };
}

export function chooseOutsideInMarkdownPath(
  layout: OutsideInLayout,
  paths: readonly string[],
): string | null {
  const canonical = normalizePath(layout.markdownPath);
  const normalized = paths.map(normalizePath);
  const exact = normalized.find((path) => path === canonical);
  if (exact) return exact;
  const folded = normalized.find(
    (path) => path.toLocaleLowerCase('en-US') === canonical.toLocaleLowerCase('en-US'),
  );
  if (folded) return folded;
  const prefix = `${normalizePath(layout.companionDirectory).replace(/\/$/, '')}/`;
  const markdown = normalized.filter(
    (path) =>
      path.startsWith(prefix) &&
      !path.slice(prefix.length).includes('/') &&
      path.toLocaleLowerCase('en-US').endsWith('.md'),
  );
  return markdown.length === 1 ? markdown[0]! : null;
}
