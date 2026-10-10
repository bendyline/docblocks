import fs from 'node:fs';
import path from 'node:path';

export const GEZEL_PACKAGES = [
  ['core', '@bendyline/gezel'],
  ['app-sdk', '@bendyline/gezel-app-sdk'],
  ['service', '@bendyline/gezel-service'],
] as const;

export const repoRoot = path.resolve(import.meta.dirname, '..');

function locations(root: string) {
  const modules = path.join(root, 'packages/desktop/node_modules');
  return { modules, saved: path.join(modules, '.docblocks-gezel') };
}

function stat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Explicit opt-in. Preserve installed packages so unlink needs no installer. */
export function linkGezel(root = repoRoot, source = path.resolve(root, '../gezel')): void {
  const sourceRoot = fs.realpathSync(source);
  const { modules, saved } = locations(root);
  const plan = GEZEL_PACKAGES.map(([dir, name]) => {
    const target = path.join(sourceRoot, 'packages', dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    if (manifest.name !== name) throw new Error(`Expected ${name} at ${target}`);
    const installed = path.join(modules, name);
    const backup = path.join(saved, name);
    const current = stat(installed);
    if (
      current?.isSymbolicLink() &&
      path.resolve(path.dirname(installed), fs.readlinkSync(installed)) !== target
    ) {
      throw new Error(`${installed} already links elsewhere; unlink it explicitly first.`);
    }
    if (current && !current.isSymbolicLink() && stat(backup)) {
      throw new Error(
        `${name} has both an installed copy and a saved copy; run npm run unlink:gezel before relinking to keep the installed copy.`,
      );
    }
    return { installed, target, backup, current };
  });
  for (const { installed, target, backup, current } of plan) {
    if (current?.isSymbolicLink()) continue;
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    if (current) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(installed, backup);
    }
    try {
      fs.symlinkSync(target, installed, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (current) fs.renameSync(backup, installed);
      throw error;
    }
  }
  fs.mkdirSync(saved, { recursive: true });
  fs.writeFileSync(path.join(saved, 'source.json'), `${JSON.stringify(sourceRoot)}\n`);
}

/** Resolve what Electron actually loads, including workspace-local npm shadows. */
export function linkedGezelRoot(root = repoRoot, required = false): string | null {
  const { modules, saved } = locations(root);
  const links = GEZEL_PACKAGES.map(([dir, name]) => ({
    dir,
    name,
    installed: path.join(modules, name),
    linked: stat(path.join(modules, name))?.isSymbolicLink() ?? false,
  }));
  // npm install can replace every link while leaving our saved-copy marker.
  // The installed packages, not that historical marker, decide what to build.
  if (!links.some((entry) => entry.linked) && !required) return null;
  if (links.some((entry) => !entry.linked)) {
    throw new Error(
      'Gezel links are missing or incomplete. Run npm run link:gezel (or npm run unlink:gezel to restore registry packages).',
    );
  }
  const source = path.resolve(fs.realpathSync(links[0].installed), '../..');
  for (const entry of links) {
    if (fs.realpathSync(entry.installed) !== path.join(source, 'packages', entry.dir)) {
      throw new Error(`${entry.name} must resolve to the same Gezel checkout as the other links.`);
    }
  }
  const configured = stat(path.join(saved, 'source.json')) !== null;
  if (
    configured &&
    JSON.parse(fs.readFileSync(path.join(saved, 'source.json'), 'utf8')) !== source
  ) {
    throw new Error('Gezel links differ from the configured checkout. Relink explicitly.');
  }
  return source;
}

export function unlinkGezel(root = repoRoot): void {
  const { modules, saved } = locations(root);
  const marker = path.join(saved, 'source.json');
  if (!stat(marker)) throw new Error('No Gezel links were created by npm run link:gezel.');
  const source: string = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const plan = GEZEL_PACKAGES.map(([dir, name]) => {
    const installed = path.join(modules, name);
    const current = stat(installed);
    const linked = current?.isSymbolicLink() ?? false;
    if (
      current &&
      (linked
        ? path.resolve(path.dirname(installed), fs.readlinkSync(installed)) !==
          path.join(source, 'packages', dir)
        : !current.isDirectory() ||
          JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).name !== name)
    ) {
      throw new Error(`${installed} changed since linking; it will not be overwritten.`);
    }
    return { installed, current, linked, backup: path.join(saved, name) };
  });
  for (const { installed, current, linked, backup } of plan) {
    if (current && !linked) {
      // npm has already restored this package, possibly at a newer version.
      // Keep it and discard only the obsolete copy saved by linkGezel().
      if (stat(backup)) fs.rmSync(backup, { recursive: true });
    } else {
      if (current) fs.unlinkSync(installed);
      if (stat(backup)) fs.renameSync(backup, installed);
    }
  }
  fs.unlinkSync(marker);
}

export function checkGezelLinks(root = repoRoot): void {
  const source = linkedGezelRoot(root, true)!;
  for (const [dir, name] of GEZEL_PACKAGES) {
    const target = path.join(source, 'packages', dir);
    for (const file of ['dist/index.js', 'dist/index.d.ts']) {
      if (!fs.existsSync(path.join(target, file)))
        throw new Error(`${name} is missing ${file}; run npm run build:gezel-linked.`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    process.stdout.write(`${name}@${manifest.version} -> ${target}\n`);
  }
}
