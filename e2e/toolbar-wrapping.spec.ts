import { test, expect, type Page } from '@playwright/test';

/**
 * Between the compact breakpoint (768px) and roughly 1000px the shell keeps
 * its split view, so the sidebar, view tabs, and host controls share a single
 * toolbar row with Squisq's formatting actions. The actions lane is the only
 * flexible item, so it used to be squeezed to zero and every formatting
 * control disappeared into the ··· menu. The shell now gives that band the
 * same two-row toolbar the Electron app uses.
 */

async function openWelcomeDocument(page: Page) {
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();

  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  if (await tour.isVisible().catch(() => false)) await tour.click();

  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Write' }).click();
  await expect(page.getByRole('tab', { name: 'Write' })).toHaveAttribute('aria-selected', 'true');
}

/** Formatting buttons a user can actually see and reach, and any that overhang. */
async function toolbarControls(page: Page) {
  return page.locator('.squisq-toolbar').evaluate((toolbar) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const clipped = [...toolbar.querySelectorAll('button')]
      .filter(visible)
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left < 0 || rect.right > document.documentElement.clientWidth;
      })
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
    const viewTabs = toolbar.querySelector('.squisq-toolbar-view-tabs');
    const viewTabsRect = viewTabs?.getBoundingClientRect();
    // Anything sharing a row with the tabs starts above their bottom edge; a
    // wrapped toolbar has every other control strictly below them.
    const sharingTabRow = [...toolbar.children]
      .filter((child) => child !== viewTabs && visible(child))
      .filter((child) => child.getBoundingClientRect().top < (viewTabsRect?.bottom ?? 0) - 1)
      .map((child) => child.className.toString());
    return {
      formatting: [
        ...toolbar.querySelectorAll('.squisq-toolbar-actions .squisq-toolbar-button'),
      ].filter(visible).length,
      clipped,
      sharingTabRow,
      height: Math.round(toolbar.getBoundingClientRect().height),
    };
  });
}

test.describe('editor toolbar on a narrow desktop viewport', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test('wraps to two rows and keeps formatting controls on screen', async ({ page }) => {
    await openWelcomeDocument(page);

    await expect(page.locator('.db-shell')).toHaveClass(/db-shell--desktop-toolbar-wrapped/);

    const controls = await toolbarControls(page);
    // The view tabs claim a row of their own, which is what pushes the
    // formatting and host controls onto a second row.
    expect(controls.sharingTabRow).toEqual([]);
    expect(controls.height).toBeGreaterThan(80);
    // The regression this guards: the actions lane collapsing to nothing.
    expect(controls.formatting).toBeGreaterThanOrEqual(5);
    expect(controls.clipped).toEqual([]);

    // Whatever did not fit is still reachable rather than merely clipped.
    // Scoped to the toolbar — the file explorer has a "More actions" button too.
    await page.locator('.squisq-toolbar').getByRole('button', { name: 'More actions' }).click();
    await expect(page.locator('.squisq-toolbar-overflow-menu')).toBeVisible();
  });
});

test.describe('editor toolbar on a wide desktop viewport', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('keeps a single row when the editor pane has room', async ({ page }) => {
    await openWelcomeDocument(page);

    await expect(page.locator('.db-shell')).not.toHaveClass(/db-shell--desktop-toolbar-wrapped/);

    const controls = await toolbarControls(page);
    expect(controls.sharingTabRow.length).toBeGreaterThan(0);
    expect(controls.formatting).toBeGreaterThanOrEqual(5);
    expect(controls.clipped).toEqual([]);
  });
});
