import fs from 'node:fs';
import path from 'node:path';

interface LockEntry {
  readonly name?: string;
  readonly version?: string;
  readonly link?: boolean;
  readonly license?: string;
  readonly cpu?: readonly string[];
  readonly os?: readonly string[];
}

interface LockSource {
  readonly root: string;
  readonly packages: Readonly<Record<string, LockEntry>>;
}

export interface LinkedNoticePackage {
  readonly directory: string;
  readonly lockfile: string;
  readonly entry: LockEntry;
}

function packageName(key: string, entry: LockEntry): string | undefined {
  return key.includes('node_modules/') ? key.split('node_modules/').at(-1) : entry.name;
}

function isWithin(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Only active first-party links can introduce another dependency lockfile. */
export function linkedNoticePackages(
  root: string,
  rootLockKeys: readonly string[],
): ReadonlyMap<string, LinkedNoticePackage> {
  root = fs.realpathSync(root);
  const sources = new Map<string, LockSource>();
  for (const key of rootLockKeys) {
    if (!/(?:^|\/)node_modules\/@bendyline\/[^/]+$/u.test(key)) continue;
    const installed = path.join(root, key);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(installed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = fs.realpathSync(installed);
    if (isWithin(root, target)) continue;
    let directory = target;
    while (true) {
      const lockfile = path.join(directory, 'package-lock.json');
      if (fs.existsSync(lockfile)) {
        if (!sources.has(directory)) {
          const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8')) as {
            lockfileVersion?: number;
            packages?: Readonly<Record<string, LockEntry>>;
          };
          if (lock.lockfileVersion !== 3 || !lock.packages) {
            throw new Error(`Linked notice source ${lockfile} requires lockfileVersion 3.`);
          }
          sources.set(directory, { root: directory, packages: lock.packages });
        }
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  const packages = new Map<string, LinkedNoticePackage>();
  for (const source of sources.values()) {
    for (const [key, entry] of Object.entries(source.packages)) {
      const name = packageName(key, entry);
      if (entry.link || !entry.version || !name) continue;
      const directory = path.resolve(source.root, key);
      // A lockfile entry must describe a package inside its own checkout.
      if (!isWithin(source.root, directory)) continue;
      const identity = `${name}@${entry.version}`;
      if (!packages.has(identity)) {
        packages.set(identity, {
          directory,
          lockfile: path.join(source.root, 'package-lock.json'),
          entry,
        });
      }
    }
  }
  return packages;
}

/** A stale lock entry must never lend its identity/license to different installed code. */
export function verifyLinkedNoticePackage(
  component: LinkedNoticePackage,
  name: string,
  version: string,
): void {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(component.directory, 'package.json'), 'utf8'),
  ) as { name?: string; version?: string };
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(
      `Linked package ${component.directory} does not match ${name}@${version} in ${component.lockfile}; rebuild after synchronizing the linked checkout's dependencies.`,
    );
  }
}
