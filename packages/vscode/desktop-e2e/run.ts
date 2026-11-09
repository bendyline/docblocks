import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { stripInheritedEditorEnvironment } from './launch-env.js';
import { SUITE_STARTED_MARKER, retryUntilSuiteStarts } from './suite-marker.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Launches allowed per run. VS Code kills itself with exit code 1 when Electron
 * reports its window unresponsive during a command-line test run, and a cold
 * Windows runner can stall that first window before the workbench even opens.
 * Only a launch that never reached the suite is retried; a failure after the
 * suite starts is the suite's own and fails immediately.
 */
const LAUNCH_ATTEMPTS = 2;

async function launch(version: string, marker: string): Promise<void> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'docblocks-vscode-desktop-user-'));
  const extensionsDir = await mkdtemp(
    path.join(os.tmpdir(), 'docblocks-vscode-desktop-extensions-'),
  );
  try {
    await runTests({
      version,
      extensionDevelopmentPath: packageRoot,
      extensionTestsPath: path.join(packageRoot, 'dist', 'desktop-e2e', 'index.cjs'),
      extensionTestsEnv: { [SUITE_STARTED_MARKER]: marker },
      launchArgs: [
        path.join(packageRoot, 'test-fixtures'),
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
  } finally {
    await Promise.all([
      rm(userDataDir, { recursive: true, force: true }),
      rm(extensionsDir, { recursive: true, force: true }),
    ]);
  }
}

async function main(): Promise<void> {
  const version = process.env.VSCODE_DESKTOP_TEST_VERSION ?? '1.85.2';
  const removed = stripInheritedEditorEnvironment(process.env);
  if (removed.length > 0) {
    process.stderr.write(
      `Launching VS Code without variables inherited from a parent editor: ${removed.join(', ')}\n`,
    );
  }
  const markers = await mkdtemp(path.join(os.tmpdir(), 'docblocks-vscode-desktop-started-'));
  const marker = (attempt: number) => path.join(markers, `attempt-${attempt}`);
  try {
    await retryUntilSuiteStarts(
      (attempt) => launch(version, marker(attempt)),
      (attempt) => existsSync(marker(attempt)),
      {
        attempts: LAUNCH_ATTEMPTS,
        onRetry: (error) =>
          process.stderr.write(
            `VS Code exited before the desktop suite started (${error instanceof Error ? error.message : String(error)}); relaunching with a fresh profile.\n`,
          ),
      },
    );
  } finally {
    await rm(markers, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
