import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Audit the integrated editor too: upstream exclusions hide host regressions. */
export async function scanEditorControls(page: Page, electron = false): Promise<void> {
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
  await expect(page.locator('.tiptap')).toBeVisible();
  for (const state of ['editor', 'view-options', 'use-mode']) {
    if (state !== 'editor') {
      await page
        .getByRole('button', {
          name: state === 'view-options' ? 'View options' : 'Choose Use mode',
          exact: true,
        })
        .press('ArrowDown');
      await expect(
        page.getByRole('menu', {
          name: state === 'view-options' ? 'View options' : 'Use mode',
          exact: true,
        }),
      ).toBeVisible();
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
  await page.keyboard.press('Tab');
  const trigger = page.getByRole('button', { name: 'Choose Use mode', exact: true });
  await expect(trigger).toBeFocused();
  await trigger.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu', { name: 'Use mode', exact: true })).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
}

/** Initialize Markdown first, load suggestions, then mount another Monaco editor. */
export async function exerciseDeferredMonaco(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  const source = page.locator('[data-testid="raw-editor"] textarea.inputarea');
  await expect(source).toBeVisible();
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
