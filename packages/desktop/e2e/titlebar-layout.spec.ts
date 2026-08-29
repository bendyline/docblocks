import { expect, test } from './fixtures.js';

test('keeps toolbar controls outside the native caption button area', async ({ launchApp }) => {
  const { window } = await launchApp();
  const toolbar = window.locator('.squisq-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await window.evaluate(() => globalThis.resizeTo(972, 600));
  await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBeLessThan(1_000);
  await expect(window.locator('.db-shell')).toHaveClass(/db-shell--desktop-toolbar-wrapped/);
  await toolbar.getByRole('tab', { name: 'Write' }).click();
  await expect(toolbar.getByRole('button', { name: 'Export and share' })).toBeVisible();

  const geometry = await toolbar.evaluate((element) => {
    const toolbarRect = element.getBoundingClientRect();
    const editorHeader = element.closest('.squisq-editor-header');
    const editorHeaderRect = editorHeader?.getBoundingClientRect();
    const sidebarHeaderRect = document
      .querySelector('.db-shell-sidebar-header')
      ?.getBoundingClientRect();
    const viewTabsRect = element
      .querySelector('.squisq-toolbar-view-tabs')
      ?.getBoundingClientRect();
    const controls = Array.from(element.children)
      .filter((control): control is HTMLElement => control instanceof HTMLElement)
      .filter((control) => control.getBoundingClientRect().width > 0)
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          className: control.className,
          top: rect.top,
          right: rect.right,
        };
      });
    const exportRect = element
      .querySelector('[aria-label="Export and share"]')
      ?.getBoundingClientRect();

    return {
      devicePixelRatio: globalThis.devicePixelRatio,
      viewportWidth: globalThis.innerWidth,
      toolbar: {
        top: toolbarRect.top,
        left: toolbarRect.left,
        right: toolbarRect.right,
        width: toolbarRect.width,
      },
      editorHeaderHeight: editorHeaderRect?.height,
      sidebarHeaderHeight: sidebarHeaderRect?.height,
      viewTabsBottom: viewTabsRect?.bottom,
      controls,
      exportTop: exportRect?.top,
      exportRight: exportRect?.right,
    };
  });

  const physicalPixel = 1 / geometry.devicePixelRatio;
  expect(Math.abs((geometry.editorHeaderHeight ?? Infinity) - 84)).toBeLessThan(physicalPixel);
  expect(Math.abs((geometry.sidebarHeaderHeight ?? Infinity) - 84)).toBeLessThan(physicalPixel);
  expect(geometry.viewTabsBottom).not.toBeUndefined();
  expect(geometry.exportTop).toBeGreaterThanOrEqual(
    (geometry.viewTabsBottom ?? Infinity) - physicalPixel,
  );
  expect(geometry.exportRight).toBeLessThanOrEqual(geometry.toolbar.right - 8);
  for (const control of geometry.controls) {
    expect(control.right, control.className).toBeLessThanOrEqual(geometry.toolbar.right);
    if (control.className !== 'squisq-toolbar-view-tabs') {
      expect(control.top, control.className).toBeGreaterThanOrEqual(
        (geometry.viewTabsBottom ?? Infinity) - physicalPixel,
      );
    }
  }
});
