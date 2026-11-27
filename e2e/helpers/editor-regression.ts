import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { showSourceView, showWriteView, viewButton } from './toolbar.js';

/** Audit the integrated editor too: upstream exclusions hide host regressions. */
export async function scanEditorControls(page: Page, electron = false): Promise<void> {
  await showWriteView(page);
  await expect(page.locator('.tiptap')).toBeVisible();
  const button = viewButton(page);
  const menu = page.getByRole('menu', { name: 'View', exact: true });
  for (const state of ['editor', 'view-menu'] as const) {
    if (state === 'view-menu') {
      await button.press('ArrowDown');
      await expect(menu).toBeVisible();
    }
    await page.locator('body').evaluate(async (root) => {
      await Promise.all(
        root
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const scanner = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    if (electron) scanner.setLegacyMode();
    const { violations } = await scanner.analyze();
    expect(violations, `${state}: ${JSON.stringify(violations)}`).toEqual([]);
    if (state !== 'editor') await page.keyboard.press('Escape');
  }
  await expect(menu).toHaveCount(0);
  // Opened from the keyboard, the menu focuses the view on screen; Up and Down
  // move within a column. Tab out of the open menu closes it and moves on
  // past the view button.
  await button.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'Write', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'Source', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(button).not.toBeFocused();
  await expect(button).toHaveAttribute('data-active-view', 'wysiwyg');
}

/**
 * A page's first Monaco mount on the Vite dev server requests ~700-770
 * unbundled monaco-editor modules. That measured 2-6 s after load on a fast
 * Mac, so the default 5 s expect timeout made every cold wait a coin flip.
 */
export const MONACO_COLD_LOAD_TIMEOUT = 30_000;

/** Initialize Markdown first, load suggestions, then mount another Monaco editor. */
export async function exerciseDeferredMonaco(page: Page): Promise<void> {
  await showSourceView(page);
  const source = page.locator('[data-testid="raw-editor"] textarea.inputarea');
  await expect(source).toBeVisible({ timeout: MONACO_COLD_LOAD_TIMEOUT });
  const modifier = await page.evaluate(() =>
    navigator.userAgent.includes('Macintosh') ? 'Meta' : 'Control',
  );
  await source.press(`${modifier}+a`);
  await page.keyboard.insertText(
    '# Monaco regression\n\n```javascript\nconst marker = 42;\nconsole.log(marker);\n```\n',
  );
  for (let cycle = 0; cycle < 2; cycle++) {
    await showWriteView(page);
    const inset = page.locator('.tiptap .monaco-editor');
    await expect(inset).toBeVisible();
    await expect(inset).toContainText('const marker = 42;');
    const input = inset.locator('textarea.inputarea');
    // Selecting all and collapsing right reaches the end on both macOS and
    // Windows Monaco keymaps (Cmd+End is not macOS's cursor-to-end binding).
    await input.press(`${modifier}+a`);
    await input.press('ArrowRight');
    await input.press('Enter');
    await page.keyboard.insertText('mar');
    await input.press('Control+Space');
    await expect(inset.locator('.suggest-widget.visible')).toBeVisible();
    await page.keyboard.press('Escape');
    await showSourceView(page);
    await expect(page.locator('[data-testid="raw-editor"]')).toContainText('console.log(marker);');
  }
  await showWriteView(page);
}
