/**
 * Run the UX screenshot crawl against a local production preview.
 *
 * The crawl itself (`e2e/live-ux-crawl.ts`) is a driver, not a test: it walks
 * the shell and captures a screenshot inventory plus a health log. Pointing it
 * at a locally built preview by default makes it reproducible and usable on a
 * branch — a crawl of the deployed site can only ever describe what already
 * shipped.
 *
 *   npm run ux:crawl                      # build, preview, crawl
 *   npm run ux:crawl -- reports/my-run    # choose the output directory
 *   npm run ux:crawl -- --no-build        # reuse packages/site/dist
 *   LIVE_UX_BASE_URL=https://docblocks.com npm run ux:crawl   # the live site
 *
 * The service worker only exists in a production build, which is the same
 * reason the offline E2E suite runs against `vite preview` rather than the dev
 * server.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview, type PreviewServer } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sitePackageRoot = path.join(repoRoot, 'packages', 'site');
const crawlEntry = path.join(repoRoot, 'e2e', 'live-ux-crawl.ts');

// Distinct from the site dev server (5220), the desktop dev server (5221), and
// the offline preview (5230) so a crawl never collides with a suite in flight.
const PREVIEW_PORT = 5240;

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Run a child process without blocking this one.
 *
 * `spawnSync` would be simpler, but the preview server below runs on this
 * process's event loop: blocking it means the crawl's own navigations never get
 * a response, and every step times out.
 */
function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

async function startPreview(): Promise<PreviewServer> {
  const server = await preview({
    root: sitePackageRoot,
    logLevel: 'warn',
    preview: { host: '127.0.0.1', port: PREVIEW_PORT, strictPort: true },
  });
  return server;
}

async function main(): Promise<void> {
  const passThrough = process.argv.slice(2);
  const skipBuild = passThrough.includes('--no-build');
  const crawlArgs = passThrough.filter((argument) => argument !== '--no-build');

  const externalBaseUrl = process.env.LIVE_UX_BASE_URL;
  if (externalBaseUrl) {
    say(`Crawling the configured LIVE_UX_BASE_URL (${externalBaseUrl}); no preview is started.`);
    await runCommand('npx', ['tsx', crawlEntry, ...crawlArgs]);
    return;
  }

  if (!skipBuild) {
    say('Building the site for preview…');
    await runCommand('npm', ['run', 'build', '-w', 'docblocks-site']);
  }

  say(`Starting the site preview on port ${PREVIEW_PORT}…`);
  const server = await startPreview();
  const baseUrl = `http://127.0.0.1:${PREVIEW_PORT}`;
  try {
    await runCommand('npx', ['tsx', crawlEntry, ...crawlArgs], {
      ...process.env,
      LIVE_UX_BASE_URL: baseUrl,
    });
    say(`Crawled ${baseUrl}.`);
  } finally {
    await server.close();
  }
}

await main();
