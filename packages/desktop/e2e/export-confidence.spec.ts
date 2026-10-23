import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveWorkspaceId } from '../main/workspace-id.js';
import { expect, test, tourWelcome } from './fixtures.js';

test('opens the confirmed saved export on request without automatic open', async ({
  launchApp,
  userDataDir,
  workspaceDir,
}, info) => {
  const target = path.join(userDataDir, 'exported-proposal.md');
  const workspaceId = deriveWorkspaceId(fs.realpathSync.native(workspaceDir));
  const access = { path: target, confirmedByPicker: true };
  const exportTargets = Object.fromEntries(
    ['Welcome.md', '/Welcome.md'].map((selectedFile) => [
      createHash('sha256')
        .update(JSON.stringify([workspaceId, selectedFile]))
        .digest('hex'),
      { last: access, byExtension: { md: access } },
    ]),
  );
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ workspaces: [], exportTargets }),
  );
  const { window } = await launchApp();
  await tourWelcome(window);
  await window.getByRole('button', { name: 'Export and share' }).click();
  await window.getByRole('menuitem', { name: 'Export document...' }).click();
  const dialog = window.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'Markdown' }).click();
  await expect(
    dialog.getByRole('checkbox', { name: 'Open in app after saving' }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save MD', exact: true }).click();
  const confirmation = window.getByRole('complementary', { name: 'Export result' });
  await expect(confirmation).toContainText(target);
  expect(fs.readFileSync(target, 'utf8')).toContain('# Welcome to DocBlocks');
  await expect(window).toHaveTitle('Welcome - DocBlocks');
  await window.screenshot({ path: info.outputPath('saved-export-open-action.png') });
  await confirmation.getByRole('button', { name: 'Open exported file' }).click();
  await expect(window).toHaveTitle('exported-proposal - DocBlocks');
  await expect(confirmation).toBeHidden();
});
