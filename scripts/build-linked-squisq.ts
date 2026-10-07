/**
 * Brings locally linked Squisq packages up to date before a dev launch.
 *
 * `npm run link:squisq` symlinks @bendyline/squisq* to ../squisq/packages/*,
 * but every DocBlocks surface consumes a linked package's built `dist/`, never
 * its `src/`. A Squisq source edit is therefore invisible to a running app
 * until that package is rebuilt — the link looks live while serving stale code.
 *
 * This rebuilds, in Squisq's dependency order, each linked package whose
 * sources are newer than its last build, so `npm run app` and `npm run site`
 * start from current code. Up-to-date packages cost a directory scan, and with
 * no links (registry packages) it does nothing.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmChildEnvironment } from './run-canonical-gate.js';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const npmCli = path.join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');

/** Squisq's own build order (`build:dev` plus the CLI in ../squisq/package.json). */
export const SQUISQ_BUILD_ORDER = [
  '@bendyline/squisq',
  '@bendyline/squisq-calc',
  '@bendyline/squisq-formats',
  '@bendyline/squisq-react',
  '@bendyline/squisq-grid-react',
  '@bendyline/squisq-video',
  '@bendyline/squisq-video-react',
  '@bendyline/squisq-editor-react',
  '@bendyline/squisq-cli',
] as const;

/**
 * Siblings whose built code ends up inside a package's own `dist/`, so a
 * rebuild of the sibling must also rebuild the package. Everything else
 * imports its siblings as externals and picks up their new `dist/` directly.
 */
const EMBEDDED_SIBLINGS: Readonly<Record<string, readonly string[]>> = {
  // The standalone players are self-contained IIFEs (`noExternal: [/.*/]`).
  '@bendyline/squisq-react': ['@bendyline/squisq'],
  // copy-player-bundle.mjs copies those players into the CLI's dist.
  '@bendyline/squisq-cli': ['@bendyline/squisq-react'],
};

const TOP_LEVEL_INPUT = /^(package\.json|tsup(\..+)?\.config\.[cm]?[jt]s|tsconfig(\..+)?\.json)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const BUILT_CODE = /\.[cm]?js$/;
const DECLARATION = /\.d\.[cm]?ts$/;

export interface LinkedSquisqPackage {
  name: string;
  /** The package's real directory inside the Squisq checkout. */
  dir: string;
}

interface NewestFile {
  file: string;
  mtimeMs: number;
}

/** Linked Squisq packages, in the order they must build. */
export function linkedSquisqPackages(root: string = repoRoot): LinkedSquisqPackage[] {
  const linked: LinkedSquisqPackage[] = [];
  for (const name of SQUISQ_BUILD_ORDER) {
    const installed = path.join(root, 'node_modules', ...name.split('/'));
    let isLink = false;
    try {
      isLink = fs.lstatSync(installed).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue;
    try {
      linked.push({ name, dir: fs.realpathSync(installed) });
    } catch {
      // A dangling link has nothing to build; the build itself reports it.
    }
  }
  return linked;
}

function newestFile(
  dir: string,
  include: (name: string) => boolean,
  skipDir: (name: string) => boolean = () => false,
): NewestFile | null {
  let newest: NewestFile | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const candidate = entry.isDirectory()
      ? skipDir(entry.name)
        ? null
        : newestFile(full, include, skipDir)
      : include(entry.name)
        ? { file: full, mtimeMs: fs.statSync(full).mtimeMs }
        : null;
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
  }
  return newest;
}

function later(a: NewestFile | null, b: NewestFile | null): NewestFile | null {
  if (!a) return b;
  if (!b) return a;
  return b.mtimeMs > a.mtimeMs ? b : a;
}

/** The newest file that feeds the package's build: sources, build scripts, and config. */
export function newestBuildInput(packageDir: string): NewestFile | null {
  const isSource = (name: string) => !TEST_FILE.test(name);
  // `__tests__`, `__fixtures__`, `__snapshots__`, and dependencies never ship.
  const isExcludedDir = (name: string) => name.startsWith('__') || name === 'node_modules';
  let newest = later(
    newestFile(path.join(packageDir, 'src'), isSource, isExcludedDir),
    newestFile(path.join(packageDir, 'scripts'), isSource, isExcludedDir),
  );
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !TOP_LEVEL_INPUT.test(entry.name)) continue;
    const file = path.join(packageDir, entry.name);
    newest = later(newest, { file, mtimeMs: fs.statSync(file).mtimeMs });
  }
  return newest;
}

/**
 * When the package last built successfully, or null when it never has. A build
 * rewrites every output, so the newest output marks it — but tsup emits
 * declarations after code, so a build that failed there leaves the older
 * declarations behind, and the earlier of the two keeps that package stale.
 */
export function lastBuiltAt(packageDir: string): number | null {
  const distDir = path.join(packageDir, 'dist');
  const code = newestFile(distDir, (name) => BUILT_CODE.test(name));
  if (!code) return null;
  const declarations = newestFile(distDir, (name) => DECLARATION.test(name));
  return declarations ? Math.min(code.mtimeMs, declarations.mtimeMs) : code.mtimeMs;
}

/** Why the package needs a rebuild, or null when its `dist/` is current. */
export function staleReason(
  pkg: LinkedSquisqPackage,
  builtAtByName: ReadonlyMap<string, number | null>,
): string | null {
  const builtAt = lastBuiltAt(pkg.dir);
  if (builtAt === null) return 'it has never been built';
  const input = newestBuildInput(pkg.dir);
  if (input && input.mtimeMs > builtAt) {
    return `${path.relative(pkg.dir, input.file).replaceAll('\\', '/')} changed since its last build`;
  }
  for (const sibling of EMBEDDED_SIBLINGS[pkg.name] ?? []) {
    const siblingBuiltAt = builtAtByName.get(sibling);
    if (siblingBuiltAt != null && siblingBuiltAt > builtAt) {
      return `it embeds ${sibling}, which was rebuilt`;
    }
  }
  return null;
}

/** The directory whose package.json declares the workspaces a package belongs to. */
function workspaceRoot(packageDir: string): string {
  for (let dir = path.dirname(packageDir); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        workspaces?: unknown;
      };
      if (manifest.workspaces) return dir;
    } catch {
      // No manifest at this level; keep walking up.
    }
  }
  return packageDir;
}

function runSquisqBuild(pkg: LinkedSquisqPackage): number {
  const result = spawnSync(process.execPath, [npmCli, 'run', 'build', '-w', pkg.name], {
    cwd: workspaceRoot(pkg.dir),
    env: npmChildEnvironment(),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export interface BuildLinkedSquisqOptions {
  root?: string;
  build?: (pkg: LinkedSquisqPackage) => number;
  log?: (message: string) => void;
}

/** Rebuilds every stale linked package in order. Returns a process exit code. */
export function buildLinkedSquisq({
  root = repoRoot,
  build = runSquisqBuild,
  log = (message) => process.stdout.write(`${message}\n`),
}: BuildLinkedSquisqOptions = {}): number {
  const linked = linkedSquisqPackages(root);
  if (linked.length === 0) return 0;

  const builtAtByName = new Map<string, number | null>();
  let rebuilt = 0;
  for (const pkg of linked) {
    const reason = staleReason(pkg, builtAtByName);
    if (reason) {
      log(`Linked Squisq: rebuilding ${pkg.name} — ${reason}.`);
      const status = build(pkg);
      if (status !== 0) {
        log(`Linked Squisq: ${pkg.name} failed to build (exit code ${status}).`);
        return status;
      }
      rebuilt++;
    }
    builtAtByName.set(pkg.name, lastBuiltAt(pkg.dir));
  }

  const current = linked.length - rebuilt;
  log(
    `Linked Squisq: ${rebuilt} rebuilt, ${current} already current. ` +
      'Later ../squisq edits need a rebuild too: run `npm run dev:squisq` alongside, or restart.',
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = buildLinkedSquisq();
}
