import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { showWriteView } from './toolbar.js';

/** Audit the integrated editor too: upstream exclusions hide host regressions. */
export async function scanEditorControls(page: Page, electron = false): Promise<void> {
  await showWriteView(page);
  await expect(page.locator('.tiptap')).toBeVisible();
  const menus = {
    'view-options': { trigger: 'View options', menu: 'View options' },
    'write-mode': { trigger: 'Choose Write mode', menu: 'Write mode' },
    'use-mode': { trigger: 'Choose Use mode', menu: 'Use mode' },
  } as const;
  for (const state of ['editor', 'view-options', 'write-mode', 'use-mode'] as const) {
    if (state !== 'editor') {
      const { trigger, menu } = menus[state];
      await page.getByRole('button', { name: trigger, exact: true }).press('ArrowDown');
      await expect(page.getByRole('menu', { name: menu, exact: true })).toBeVisible();
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
  const tabs = page.getByRole('tablist', { name: 'Editor view' });
  await expect(tabs.getByRole('button')).toHaveCount(0);
  await tabs.getByRole('tab', { name: 'Write', exact: true }).press('End');
  await expect(tabs.locator('[data-view="preview"]')).toBeFocused();
  // The tablist is one tab stop; the ▾ mode buttons follow it, Write's first.
  // Tab out of an open menu closes it and moves on to the next control.
  await page.keyboard.press('Tab');
  const writeTrigger = page.getByRole('button', { name: 'Choose Write mode', exact: true });
  await expect(writeTrigger).toBeFocused();
  await writeTrigger.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu', { name: 'Write mode', exact: true })).toHaveCount(0);
  const useTrigger = page.getByRole('button', { name: 'Choose Use mode', exact: true });
  await expect(useTrigger).toBeFocused();
  await useTrigger.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu', { name: 'Use mode', exact: true })).toHaveCount(0);
  await expect(useTrigger).not.toBeFocused();
}

/**
 * A page's first Monaco mount on the Vite dev server requests ~700-770
 * unbundled monaco-editor modules. That measured 2-6 s after load on a fast
 * Mac, so the default 5 s expect timeout made every cold wait a coin flip.
 */
export const MONACO_COLD_LOAD_TIMEOUT = 30_000;

/** Initialize Markdown first, load suggestions, then mount another Monaco editor. */
export async function exerciseDeferredMonaco(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
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
    await page.getByRole('tab', { name: 'Write', exact: true }).click();
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
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    await expect(page.locator('[data-testid="raw-editor"]')).toContainText('console.log(marker);');
  }
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
}
