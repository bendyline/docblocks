import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures.js';

function git(workspaceDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workspaceDir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

test('detects, commits, and displays history through the desktop Git UI', async ({
  launchApp,
  workspaceDir,
}) => {
  git(workspaceDir, ['init']);
  git(workspaceDir, ['config', 'user.name', 'DocBlocks E2E']);
  git(workspaceDir, ['config', 'user.email', 'docblocks-e2e@example.invalid']);
  const tracked = path.join(workspaceDir, 'tracked.md');
  fs.writeFileSync(tracked, '# Initial\n', 'utf8');
  git(workspaceDir, ['add', '--', 'tracked.md']);
  git(workspaceDir, ['commit', '-m', 'Initial fixture']);

  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  const gitChip = window.getByRole('button', { name: /Git: branch/u });
  await expect(gitChip).toBeVisible({ timeout: 20_000 });

  fs.appendFileSync(tracked, '\nChanged through the desktop E2E workflow.\n', 'utf8');
  await expect(gitChip).toHaveAttribute('aria-label', /1 change/u, { timeout: 20_000 });

  await gitChip.click();
  await window.getByRole('menuitem', { name: 'Commit…' }).click();
  const commitDialog = window.getByRole('dialog', { name: 'Commit changes' });
  await expect(commitDialog.getByText('tracked.md', { exact: true })).toBeVisible();
  await commitDialog.getByLabel('Commit message').fill('Commit from desktop E2E');
  await commitDialog.getByRole('button', { name: 'Commit', exact: true }).click();

  await expect(gitChip).not.toHaveAttribute('aria-label', /change/u, { timeout: 20_000 });
  expect(git(workspaceDir, ['log', '-1', '--pretty=%s'])).toBe('Commit from desktop E2E');

  await gitChip.click();
  await window.getByRole('menuitem', { name: 'Commit history…' }).click();
  const history = window.getByRole('dialog', { name: 'Commit history' });
  await expect(history.getByText('Commit from desktop E2E', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

/**
 * Opening a folder whose Git metadata lives outside it (a subfolder of a
 * larger repository, or a separate `--separate-git-dir`) used to greet the
 * user with a native "Allow access to the full Git repository?" message box
 * at launch. It must now stay quiet: git off, and an unobtrusive offer at the
 * foot of the sidebar.
 */
test('offers expanded repository access from the status bar instead of a launch modal', async ({
  launchApp,
  workspaceDir,
}) => {
  const externalGitDir = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'db-gitdir-'),
  );
  try {
    git(workspaceDir, ['init', `--separate-git-dir=${externalGitDir}`]);
    git(workspaceDir, ['config', 'user.name', 'DocBlocks E2E']);
    git(workspaceDir, ['config', 'user.email', 'docblocks-e2e@example.invalid']);
    fs.writeFileSync(path.join(workspaceDir, 'tracked.md'), '# Initial\n', 'utf8');
    git(workspaceDir, ['add', '--', 'tracked.md']);
    git(workspaceDir, ['commit', '-m', 'Initial fixture']);

    const first = await launchApp();
    const window = first.window;
    await window.waitForSelector('.db-shell', { timeout: 30_000 });

    const offer = window.getByRole('button', { name: /^Enable Git for this folder/u });
    await expect(offer).toBeVisible({ timeout: 20_000 });
    await expect(window.getByRole('button', { name: /Git: branch/u })).toHaveCount(0);

    await offer.click();
    const dialog = window.getByRole('dialog', { name: 'Enable Git for this folder?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Enable Git' }).click();

    await expect(window.getByRole('button', { name: /Git: branch/u })).toBeVisible({
      timeout: 20_000,
    });

    // The answer is remembered: the next launch is not asked again.
    await first.close();
    const second = await launchApp();
    await second.window.waitForSelector('.db-shell', { timeout: 30_000 });
    await expect(second.window.getByRole('button', { name: /Git: branch/u })).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      second.window.getByRole('button', { name: /^Enable Git for this folder/u }),
    ).toHaveCount(0);
  } finally {
    fs.rmSync(externalGitDir, { recursive: true, force: true });
  }
});
