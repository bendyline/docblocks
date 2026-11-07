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
 *   npm run ux:crawl -- --review          # functional, export, accessibility audit
 *   npm run ux:crawl -- --affordances     # click every control; contact sheet
 *   npm run ux:crawl -- --pages           # every static page × 7 profiles; downloads
 *   npm run ux:crawl -- --scale           # isolated editor typing/load benchmark
 *   npm run ux:crawl -- --all             # crawl, pages, affordances, review into one folder
 *   LIVE_UX_BASE_URL=https://docblocks.com npm run ux:crawl   # the live site
 *   LIVE_UX_BASE_URL=https://docblocks.com npm run ux:crawl -- --all reports/teardown
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
/**
 * The teardown `--all` runs, in order, each into a subfolder of one output
 * directory. Scale is left out: its typing timings need an otherwise idle
 * machine, so it runs on its own.
 */
const ALL_DRIVERS = [
  ['crawl', crawlEntry],
  ['pages', path.join(repoRoot, 'e2e', 'site-pages-crawl.ts')],
  ['affordances', path.join(repoRoot, 'e2e', 'site-affordance-crawl.ts')],
  ['review', path.join(repoRoot, 'e2e', 'site-ship-review.ts')],
] as const;

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

interface DriverRun {
  name: string;
  entry: string;
  args: string[];
}

/**
 * Run each driver in turn. A driver exits non-zero when any of its audit steps
 * failed; with several queued, that is recorded and the rest still run, so one
 * failing flow never cancels the remainder of a teardown.
 */
async function runDrivers(runs: readonly DriverRun[], env?: NodeJS.ProcessEnv): Promise<string[]> {
  const failed: string[] = [];
  for (const run of runs) {
    try {
      await runCommand('npx', ['tsx', run.entry, ...run.args], env);
    } catch (error) {
      if (runs.length === 1) throw error;
      failed.push(run.name);
      say(`${run.name} reported failures: ${String(error)}`);
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const passThrough = process.argv.slice(2);
  const skipBuild = passThrough.includes('--no-build');
  const review = passThrough.includes('--review');
  const affordances = passThrough.includes('--affordances');
  const pages = passThrough.includes('--pages');
  const scale = passThrough.includes('--scale');
  const all = passThrough.includes('--all');
  if ([review, affordances, pages, scale, all].filter(Boolean).length > 1) {
    throw new Error('Choose one of --review, --affordances, --pages, --scale, or --all.');
  }
  const entry = review
    ? path.join(repoRoot, 'e2e', 'site-ship-review.ts')
    : affordances
      ? path.join(repoRoot, 'e2e', 'site-affordance-crawl.ts')
      : pages
        ? path.join(repoRoot, 'e2e', 'site-pages-crawl.ts')
        : scale
          ? path.join(repoRoot, 'e2e', 'site-scale-review.ts')
          : crawlEntry;
  const crawlArgs = passThrough.filter(
    (argument) =>
      !['--no-build', '--review', '--affordances', '--pages', '--scale', '--all'].includes(
        argument,
      ),
  );
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const allRoot = crawlArgs[0] ?? path.join('reports', `site-review-${stamp}`);
  const runs: DriverRun[] = all
    ? ALL_DRIVERS.map(([name, driver]) => ({
        name,
        entry: driver,
        args: [path.join(allRoot, name)],
      }))
    : [{ name: path.basename(entry, '.ts'), entry, args: crawlArgs }];

  const externalBaseUrl = process.env.LIVE_UX_BASE_URL;
  let failed: string[];
  if (externalBaseUrl) {
    say(`Crawling the configured LIVE_UX_BASE_URL (${externalBaseUrl}); no preview is started.`);
    failed = await runDrivers(runs);
  } else {
    if (!skipBuild) {
      say('Building the site for preview…');
      await runCommand('npm', ['run', 'build', '-w', 'docblocks-site']);
    }

    say(`Starting the site preview on port ${PREVIEW_PORT}…`);
    const server = await startPreview();
    const baseUrl = `http://127.0.0.1:${PREVIEW_PORT}`;
    try {
      failed = await runDrivers(runs, { ...process.env, LIVE_UX_BASE_URL: baseUrl });
      say(`Crawled ${baseUrl}.`);
    } finally {
      await server.close();
    }
  }
  if (all) say(`Teardown evidence: ${path.resolve(repoRoot, allRoot)}`);
  if (failed.length > 0) {
    say(`Drivers with failed steps (inspect their results): ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
