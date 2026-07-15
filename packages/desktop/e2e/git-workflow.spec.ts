import fs from 'node:fs';
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
