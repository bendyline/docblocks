import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { stripInheritedEditorEnvironment } from './launch-env.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const version = process.env.VSCODE_DESKTOP_TEST_VERSION ?? '1.85.2';
  const removed = stripInheritedEditorEnvironment(process.env);
  if (removed.length > 0) {
    process.stderr.write(
      `Launching VS Code without variables inherited from a parent editor: ${removed.join(', ')}\n`,
    );
  }
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'docblocks-vscode-desktop-user-'));
  const extensionsDir = await mkdtemp(
    path.join(os.tmpdir(), 'docblocks-vscode-desktop-extensions-'),
  );
  try {
    await runTests({
      version,
      extensionDevelopmentPath: packageRoot,
      extensionTestsPath: path.join(packageRoot, 'dist', 'desktop-e2e', 'index.cjs'),
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

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
