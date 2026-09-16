import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVAILABLE_FONT_STACKS } from '@bendyline/squisq';
import {
  declaredFontFaceFamilies,
  fontParityViolations,
  requiredFamilies,
  type SurfaceFonts,
} from './font-parity-policy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontRoot = path.join(repoRoot, 'packages/site/public/fonts');
const cssFiles = [
  path.join(fontRoot, 'fonts.css'),
  path.join(repoRoot, 'packages/site/public/marketing/marketing.css'),
];
const cssSources = await Promise.all(cssFiles.map((file) => readFile(file, 'utf8')));
const fontFiles = (await readdir(fontRoot)).filter((file) => file.endsWith('.woff2')).sort();
const referencedFonts = new Set(
  cssSources.flatMap((css) =>
    [...css.matchAll(/url\(['"]?\/fonts\/([^'")]+\.woff2)['"]?\)/gu)].map((match) => match[1]),
  ),
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

/**
 * Every surface that mounts the editor must declare the same webfont families.
 *
 * The checks above prove the site's own fonts are internally consistent. They
 * say nothing about the other two surfaces, so a family present on the site and
 * absent from the VS Code webview renders in a fallback face there — correct on
 * two surfaces, wrong on the third, and silent on all three.
 */
const SURFACE_STYLESHEETS: readonly { surface: string; source: string; fontDir: string }[] = [
  {
    surface: 'site',
    source: 'packages/site/public/fonts/fonts.css',
    fontDir: 'packages/site/public/fonts',
  },
  {
    surface: 'desktop renderer',
    source: 'packages/desktop/renderer/public/fonts/fonts.css',
    fontDir: 'packages/desktop/renderer/public/fonts',
  },
  {
    surface: 'VS Code webview',
    source: 'packages/vscode/webview/src/fonts.css',
    fontDir: 'packages/vscode/webview/src/fonts',
  },
];

/**
 * Families a surface may legitimately omit, with the reason.
 *
 * Keep this empty unless a surface genuinely cannot render a stack: an entry
 * here is a documented decision to let that font fall back on that surface.
 */
const FONT_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {};

const surfaces: SurfaceFonts[] = [];
for (const { surface, source, fontDir } of SURFACE_STYLESHEETS) {
  const css = await readFile(path.join(repoRoot, source), 'utf8');
  surfaces.push({ surface, source, families: declaredFontFaceFamilies(css) });

  // Declaring a family proves nothing if its file is absent: the face still
  // falls back, just as silently. Each surface names its files differently —
  // the site and desktop serve from a public root, the webview resolves
  // relative to the stylesheet Vite bundles — so compare basenames.
  const available = new Set(
    (await readdir(path.join(repoRoot, fontDir))).filter((file) => file.endsWith('.woff2')),
  );
  const referenced = [
    ...new Set([...css.matchAll(/url\(['"]?[^'")]*?([^/'")]+\.woff2)['"]?\)/gu)].map((m) => m[1]!)),
  ];
  const absent = referenced.filter((file) => !available.has(file)).sort();
  if (absent.length > 0) {
    throw new Error(
      `${surface} (${source}) references ${absent.length} font file(s) missing from ${fontDir}: ` +
        absent.join(', '),
    );
  }
}

/**
 * The chrome's deterministic alternative to `system-ui`. Not a Squisq stack, so
 * it is required explicitly: regenerating fonts.css upstream would otherwise
 * drop it from a surface and only the visual suite would notice, one OS later.
 */
const FIXED_UI_FAMILY = 'DocBlocks Fixed UI';

const required = [...requiredFamilies(AVAILABLE_FONT_STACKS), FIXED_UI_FAMILY].sort();
const parityViolations = fontParityViolations(required, surfaces, FONT_EXEMPTIONS);
if (parityViolations.length > 0) {
  throw new Error(
    [
      'Editor surfaces disagree about which Squisq font stacks they can render.',
      'Squisq ships no @font-face rules; a stack naming a googleFontFamily needs',
      'the host page to supply it, or documents using it fall back silently.',
      '',
      ...parityViolations.map(
        (violation) =>
          `  ${violation.surface} (${violation.source}) is missing ${violation.missing.length}: ` +
          violation.missing.join(', '),
      ),
      '',
      "Add the faces to that surface's fonts.css, or record a justified entry in",
      'FONT_EXEMPTIONS.',
    ].join('\n'),
  );
}

process.stdout.write(
  `${required.length} Squisq font families render on all ${surfaces.length} editor surfaces.\n`,
);
