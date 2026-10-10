import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkGezelLinks, GEZEL_PACKAGES, linkedGezelRoot, repoRoot } from './gezel-links.js';
import { npmChildEnvironment } from './run-canonical-gate.js';

interface WorkspacePackage {
  name: string;
  dir: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Build runtime dependencies first, without pulling in SDK dev-dependency cycles. */
export function gezelBuildPackages(source: string): WorkspacePackage[] {
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of fs.readdirSync(path.join(source, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(source, 'packages', entry.name);
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspacePackage;
    packages.set(manifest.name, { ...manifest, dir });
  }
  const result: WorkspacePackage[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(name: string) {
    if (visited.has(name)) return;
    if (active.has(name)) throw new Error(`Gezel runtime dependency cycle at ${name}`);
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`Missing Gezel workspace package ${name}`);
    active.add(name);
    for (const [dependency, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      if (version.startsWith('workspace:')) visit(dependency);
    }
    active.delete(name);
    visited.add(name);
    if (pkg.scripts?.build) result.push(pkg);
  }
  for (const [, name] of GEZEL_PACKAGES) visit(name);
  return result;
}

interface LeaseContext {
  leaseEnv: NodeJS.ProcessEnv;
  setChildPid(pid: number | undefined): Promise<void>;
}

interface LeaseModule {
  withDependencyReadLease<T>(
    root: string,
    run: (lease: LeaseContext) => Promise<T>,
    options: { command: string; env: NodeJS.ProcessEnv },
  ): Promise<T>;
}

export async function buildLinkedGezel(root = repoRoot): Promise<number> {
  const source = linkedGezelRoot(root);
  if (!source) {
    process.stdout.write('Gezel: using installed registry packages (no local links).\n');
    return 0;
  }
  const lease = (await import(
    pathToFileURL(path.join(source, 'scripts/dependency-lease.mjs')).href
  )) as LeaseModule;
  const environment = npmChildEnvironment();
  return lease.withDependencyReadLease(
    source,
    async ({ leaseEnv, setChildPid }) => {
      // Always rebuild the runtime closure. Gezel's service also copies Python,
      // eval and other assets outside src/, so a source-only mtime check is unsafe.
      for (const pkg of gezelBuildPackages(source)) {
        process.stdout.write(`Linked Gezel: building ${pkg.name}\n`);
        const child = spawn(
          process.execPath,
          [
            path.join(root, 'node_modules/npm/bin/npm-cli.js'),
            '--prefix',
            pkg.dir,
            '--workspaces=false',
            'run',
            'build',
          ],
          {
            cwd: pkg.dir,
            env: { ...environment, ...leaseEnv },
            stdio: 'inherit',
            shell: false,
            windowsHide: true,
          },
        );
        const completed = new Promise<number>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => resolve(code ?? 1));
        });
        await setChildPid(child.pid);
        const status = await completed;
        if (status !== 0) return status;
      }
      checkGezelLinks(root);
      process.stdout.write(
        'Linked Gezel is built. Restart a running Electron app to load the new backend.\n',
      );
      return 0;
    },
    { command: 'DocBlocks linked Gezel build', env: environment },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildLinkedGezel()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
