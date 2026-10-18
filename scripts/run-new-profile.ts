/**
 * Runs the desktop app or the site against a brand-new, empty profile, so the
 * first-run experience can be tried without disturbing everyday dev state.
 *
 *   npm run app:new              # Electron with throwaway userData + Documents
 *   npm run site:new             # site dev server in a browser with a throwaway profile
 *   npm run site:new -- --keep   # leave the profile on disk afterwards to inspect it
 *
 * Both first do the same preparation as `npm run app` / `npm run site`. Every
 * run starts from a new empty directory under the OS temp folder and deletes it
 * on exit unless --keep is passed.
 *
 * - app: DOCBLOCKS_DEV_PROFILE_DIR moves the source build's userData (Chromium
 *   storage, settings, window state, the Gezel grant) and its Documents folder,
 *   which holds the DocBlocks-dev workspace. ~/.gezel is still shared, so AI
 *   models already downloaded there carry over.
 * - site: the site keeps its state in the browser (IndexedDB, localStorage), so
 *   this starts the site's Vite dev server and opens it in Chrome, Edge, or
 *   Chromium with a fresh --user-data-dir. Closing that window stops the
 *   server. DOCBLOCKS_BROWSER names another Chromium-family executable. The
 *   dev server registers no service worker, so this does not cover PWA install.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVELOPMENT_PROFILE_ENV } from '../packages/desktop/main/development-runtime.js';
import { npmChildEnvironment } from './run-canonical-gate.js';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const npmCli = path.join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const siteDir = path.join(repoRoot, 'packages', 'site');
const BROWSER_ENV = 'DOCBLOCKS_BROWSER';
const USAGE = 'Usage: tsx scripts/run-new-profile.ts <app|site> [--keep]\n';

/** Installed Chromium-family browsers to try, most familiar first. */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    return [
      ...roots.map((root) =>
        path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ),
      ...roots.map((root) =>
        path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const directories = (env.PATH ?? '').split(path.posix.delimiter).filter(Boolean);
  return [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'chromium',
    'chromium-browser',
  ].flatMap((name) => directories.map((directory) => path.posix.join(directory, name)));
}

async function resolveBrowser(): Promise<string> {
  const override = process.env[BROWSER_ENV]?.trim();
  if (override) {
    if (!fs.existsSync(override))
      throw new Error(`${BROWSER_ENV} names ${override}, which does not exist.`);
    return override;
  }
  const installed = browserCandidates(process.platform, process.env).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (installed) return installed;
  // The E2E suites install Playwright's Chromium, so a checkout always has one.
  const { chromium } = await import('@playwright/test');
  const bundled = chromium.executablePath();
  if (fs.existsSync(bundled)) return bundled;
  throw new Error(
    `No Chrome, Edge, or Chromium found. Set ${BROWSER_ENV} to a Chromium-family browser executable.`,
  );
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`Failed to start ${child.spawnfile}: ${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function runApp(profileDir: string): Promise<number> {
  // Ctrl+C reaches the npm child too, and the desktop dev supervisor shuts the
  // app down. Stay alive until it has, so the profile can be removed after.
  const waitForChild = (): void => {};
  process.on('SIGINT', waitForChild);
  process.on('SIGTERM', waitForChild);
  try {
    const child = spawn(process.execPath, [npmCli, 'run', 'dev:desktop'], {
      cwd: repoRoot,
      env: { ...npmChildEnvironment(), [DEVELOPMENT_PROFILE_ENV]: profileDir },
      stdio: 'inherit',
      windowsHide: true,
    });
    return await exitCodeOf(child);
  } finally {
    process.off('SIGINT', waitForChild);
    process.off('SIGTERM', waitForChild);
  }
}

async function runSite(profileDir: string): Promise<number> {
  const browser = await resolveBrowser();
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.join(siteDir, 'vite.config.ts'),
    root: siteDir,
    // The throwaway browser below replaces Vite's open-on-start, which would
    // use the everyday browser profile and its existing site storage.
    server: { open: false },
  });

  let browserProcess: ChildProcess | undefined;
  let stopping = false;
  const stopBrowser = (): void => {
    stopping = true;
    browserProcess?.kill();
  };
  process.on('SIGINT', stopBrowser);
  process.on('SIGTERM', stopBrowser);
  try {
    await server.listen();
    server.printUrls();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('The site dev server did not report a local URL.');
    if (stopping) return 0;

    process.stdout.write(`\nOpening ${url} in ${browser}\nClose that window to stop.\n`);
    browserProcess = spawn(
      browser,
      [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', url],
      { stdio: 'ignore' },
    );
    const code = await exitCodeOf(browserProcess);
    return stopping ? 0 : code;
  } finally {
    process.off('SIGINT', stopBrowser);
    process.off('SIGTERM', stopBrowser);
    await server.close();
  }
}

function removeProfile(profileDir: string): void {
  try {
    // Browser and Electron helper processes can hold profile files for a
    // moment after the main process exits; rmSync retries EBUSY and EPERM.
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    process.stderr.write(
      `Could not remove the throwaway profile at ${profileDir}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function runNewProfile(argv: readonly string[]): Promise<number> {
  const [surface, ...flags] = argv;
  if ((surface !== 'app' && surface !== 'site') || flags.some((flag) => flag !== '--keep')) {
    process.stderr.write(USAGE);
    return 2;
  }
  const keep = flags.includes('--keep');

  const parent = path.join(os.tmpdir(), 'docblocks-new');
  fs.mkdirSync(parent, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(parent, `${surface}-`));
  process.stdout.write(`Throwaway ${surface} profile: ${profileDir}\n`);

  try {
    return surface === 'app' ? await runApp(profileDir) : await runSite(profileDir);
  } finally {
    if (keep) process.stdout.write(`Kept the throwaway profile at ${profileDir}\n`);
    else removeProfile(profileDir);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runNewProfile(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
