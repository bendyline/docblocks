import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontRoot = path.join(repoRoot, 'packages/site/public/fonts');
const css = await readFile(path.join(fontRoot, 'fonts.css'), 'utf8');
const fontFiles = (await readdir(fontRoot)).filter((file) => file.endsWith('.woff2')).sort();
const referencedFonts = new Set(
  [...css.matchAll(/url\(['"]?\/fonts\/([^'")]+\.woff2)['"]?\)/gu)].map((match) => match[1]),
);

const missing = [...referencedFonts].filter((file) => !fontFiles.includes(file));
const unreferenced = fontFiles.filter((file) => !referencedFonts.has(file));
if (missing.length > 0 || unreferenced.length > 0) {
  throw new Error(
    [
      missing.length > 0 ? `Missing referenced fonts: ${missing.join(', ')}` : '',
      unreferenced.length > 0 ? `Unreferenced font files: ${unreferenced.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

const byHash = new Map<string, string[]>();
for (const file of fontFiles) {
  const hash = createHash('sha256')
    .update(await readFile(path.join(fontRoot, file)))
    .digest('hex');
  const duplicates = byHash.get(hash) ?? [];
  duplicates.push(file);
  byHash.set(hash, duplicates);
}
const duplicateGroups = [...byHash.values()].filter((files) => files.length > 1);
if (duplicateGroups.length > 0) {
  throw new Error(
    `Site fonts contain byte-identical duplicates:\n${duplicateGroups
      .map((files) => `  ${files.join(', ')}`)
      .join('\n')}`,
  );
}

process.stdout.write(`${fontFiles.length} unique site fonts are referenced and present.\n`);
