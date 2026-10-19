import { expect, test } from './fixtures.js';
import {
  exerciseDeferredMonaco,
  scanEditorControls,
} from '../../../e2e/helpers/editor-regression.js';

test('desktop editor controls and deferred Monaco initialize coherently', async ({
  launchApp,
}, info) => {
  const { window: page } = await launchApp();
  await expect(page.locator('.squisq-status-bar')).toBeVisible();
  await page.getByRole('button', { name: 'Tour the welcome document', exact: true }).click();
  await scanEditorControls(page, true);
  await exerciseDeferredMonaco(page);
  await page.screenshot({ path: info.outputPath('editor.png') });
});
