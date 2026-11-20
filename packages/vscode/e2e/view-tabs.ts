import type { Frame, FrameLocator } from '@playwright/test';
import { expect } from './test.js';

/**
 * Switch the webview editor to Source. Source is chosen from the Write mode
 * menu, not a tab of its own; the first tab then reads Source and carries
 * `data-view="raw"`. Choosing it through the menu also takes the same path
 * as a user, which is what preloads Monaco on pointer intent.
 */
export async function showSource(editor: Frame | FrameLocator): Promise<void> {
  await editor.getByRole('button', { name: 'Choose Write mode', exact: true }).click();
  const item = editor
    .getByRole('menu', { name: 'Write mode', exact: true })
    .getByRole('menuitemradio', { name: 'Source', exact: true });
  await item.click();
  await expect(item).toBeHidden();
  await expect(editor.locator('[role="tab"][data-view="raw"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
}
