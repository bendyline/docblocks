/**
 * Run every visual regression suite.
 *
 * The surfaces need separate Playwright configs — the site drives a dev server,
 * VS Code Web provisions a workbench — so there is no single config to point
 * at. This runs them in turn and reports which ones failed rather than stopping
 * at the first.
 *
 *   npm run test:e2e:visual
 *   npm run test:e2e:visual -- --site          # one surface
 *   npm run test:e2e:visual:update             # rewrite baselines
 *
 * Deliberately not part of `npm run all`: baselines are captured on Linux and a
 * screenshot diff should not block a change that altered nothing visible. It is
 * a pre-release and nightly gate instead.
 *
 * The desktop app has no visual suite yet. Its toolbar registers a Print control
 * after first paint and its status counters settle asynchronously, so captures
 * of that chrome render bimodally between otherwise identical runs — see the
 * finding recorded in AGENTS.md. Those geometries stay covered numerically by
 * `packages/desktop/e2e/titlebar-layout.spec.ts`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface VisualSuite {
  readonly flag: string;
  readonly label: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /**
   * Whether this suite's baselines are one shared set.
   *
   * Shared baselines are captured on Linux and must not be written anywhere
   * else. The desktop suite is the exception: native window chrome has no
   * cross-platform rendering to compare, so its baselines are per platform by
   * name and are captured on whichever OS runs them.
   */
  readonly sharedBaselines: boolean;
}

const SUITES: readonly VisualSuite[] = [
  {
    flag: '--site',
    label: 'site',
    sharedBaselines: true,
    args: [
      'playwright',
      'test',
      '--project=visual',
      '--project=visual-phone',
      '--project=visual-tablet-portrait',
      '--project=visual-tablet-landscape',
    ],
  },
  {
    flag: '--vscode',
    label: 'VS Code webview',
    sharedBaselines: true,
    args: ['playwright', 'test', '--config=e2e/playwright.config.ts', '--project=visual'],
    cwd: path.join(repoRoot, 'packages/vscode'),
  },
];

function run(suite: VisualSuite, extraArgs: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', [...suite.args, ...extraArgs], {
      cwd: suite.cwd ?? repoRoot,
      stdio: 'inherit',
      // The visual projects are declared only when this is set, which is what
      // keeps them out of `npm run test:e2e` and so out of the canonical gate.
      env: { ...process.env, DOCBLOCKS_VISUAL: '1' },
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Committed baselines are captured on Linux, because the shell chrome resolves
 * `system-ui` to a different typeface per platform. Writing them from another
 * host produces images CI can never match, so that needs saying out loud rather
 * than discovering it from a red pipeline.
 */
function assertBaselineHostIsSupported(
  suites: readonly VisualSuite[],
  extraArgs: readonly string[],
): void {
  const updating = extraArgs.some((argument) => argument.startsWith('--update-snapshots'));
  const shared = suites.filter((suite) => suite.sharedBaselines);
  if (!updating || shared.length === 0 || process.platform === 'linux') return;
  if (process.env.DOCBLOCKS_VISUAL_ALLOW_FOREIGN_BASELINES === '1') {
    process.stderr.write(
      `Writing baselines on ${process.platform}: these will not match CI. Do not commit them.\n`,
    );
    return;
  }
  process.stderr.write(
    [
      `Refusing to write ${shared.map((suite) => suite.label).join(' and ')} baselines on ${process.platform}.`,
      'Committed baselines are captured on Linux — the shell chrome resolves',
      'system-ui to a different typeface here, so these images would fail CI.',
      '',
      'Regenerate them with the "Update visual baselines" workflow, download its',
      'artifact, and commit that. To write throwaway local baselines anyway, set',
      'DOCBLOCKS_VISUAL_ALLOW_FOREIGN_BASELINES=1.',
    ].join('\n') + '\n',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const selected = SUITES.filter((suite) => argv.includes(suite.flag));
  const suites = selected.length > 0 ? selected : SUITES;
  const extraArgs = argv.filter((argument) => !SUITES.some((suite) => suite.flag === argument));
  assertBaselineHostIsSupported(suites, extraArgs);

  const failed: string[] = [];
  for (const suite of suites) {
    process.stdout.write(`\n── visual: ${suite.label} ──\n`);
    const code = await run(suite, extraArgs);
    if (code !== 0) failed.push(suite.label);
  }

  if (failed.length > 0) {
    process.stderr.write(`\nVisual regression failed: ${failed.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nVisual regression passed for ${suites.length} surface(s).\n`);
}

await main();
