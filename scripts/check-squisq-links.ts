/**
 * Preflight for local Squisq development links.
 *
 * When `npm run link:squisq` points @bendyline/squisq* packages at
 * ../squisq source folders, DocBlocks' DTS build depends on those linked
 * packages already having their declaration outputs. This check fails fast
 * with the package and file that need rebuilding instead of letting tsup
 * surface a vague "Could not find a declaration file" later.
 */

import fs from 'node:fs';
import path from 'node:path';

interface PackageJson {
  name?: string;
  types?: string;
  typings?: string;
  exports?: Record<string, unknown>;
}

const linkedPackages = [
  '@bendyline/squisq',
  '@bendyline/squisq-react',
  '@bendyline/squisq-editor-react',
  '@bendyline/squisq-formats',
  '@bendyline/squisq-video',
  '@bendyline/squisq-video-react',
  '@bendyline/squisq-cli',
];

const root = path.resolve(import.meta.dirname, '..');

function readPackageJson(packageDir: string): PackageJson | null {
  const packageJsonPath = path.join(packageDir, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function collectTypePaths(pkg: PackageJson): string[] {
  const paths = new Set<string>();
  if (pkg.types) paths.add(pkg.types);
  if (pkg.typings) paths.add(pkg.typings);

  const rootExport = pkg.exports?.['.'];
  if (rootExport && typeof rootExport === 'object' && !Array.isArray(rootExport)) {
    const types = (rootExport as { types?: unknown }).types;
    if (typeof types === 'string') paths.add(types);
  }

  return [...paths];
}

const missing: string[] = [];

for (const packageName of linkedPackages) {
  const packageDir = path.join(root, 'node_modules', ...packageName.split('/'));
  if (!fs.existsSync(packageDir)) continue;

  const stat = fs.lstatSync(packageDir);
  if (!stat.isSymbolicLink()) continue;

  const pkg = readPackageJson(packageDir);
  if (!pkg) {
    missing.push(`${packageName}: package.json could not be read`);
    continue;
  }

  const typePaths = collectTypePaths(pkg);
  for (const typePath of typePaths) {
    const absoluteTypePath = path.resolve(packageDir, typePath);
    if (!fs.existsSync(absoluteTypePath)) {
      missing.push(`${packageName}: missing ${path.relative(packageDir, absoluteTypePath)}`);
    }
  }
}

if (missing.length > 0) {
  console.error('Linked Squisq packages are missing declaration output:\n');
  for (const item of missing) {
    console.error(`  - ${item}`);
  }
  console.error(
    '\nBuild the linked Squisq packages first, for example:\n' +
      '  cd ..\\squisq\n' +
      '  npm run build -w @bendyline/squisq-editor-react\n',
  );
  process.exit(1);
}
