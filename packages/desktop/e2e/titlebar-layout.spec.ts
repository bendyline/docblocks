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

test('keeps the compact toolbar visible after the sidebar is collapsed', async ({ launchApp }) => {
  const { window } = await launchApp();
  const toolbar = window.locator('.squisq-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await toolbar.getByRole('tab', { name: 'Write' }).click();

  const resizer = window.getByRole('separator', { name: 'Resize sidebar' });
  const resizerBox = await resizer.boundingBox();
  if (!resizerBox) throw new Error('Sidebar resizer not found');

  await window.mouse.move(
    resizerBox.x + resizerBox.width / 2,
    resizerBox.y + resizerBox.height / 2,
  );
  await window.mouse.down();
  await window.mouse.move(100, resizerBox.y + resizerBox.height / 2);

  const collapsePreview = window.locator('.db-sidebar-collapse-preview');
  await expect(collapsePreview).toBeVisible();
  await expect(collapsePreview).toContainText('Release to hide files');
  await expect(collapsePreview.locator('svg')).toBeVisible();

  await window.mouse.up();

  const shell = window.locator('.db-shell');
  await expect(shell).toHaveClass(/db-shell--mobile/);
  await expect(window.locator('.db-shell-sidebar')).not.toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Export and share' })).toBeVisible();
  await expect(
    toolbar.locator('.squisq-toolbar-actions .squisq-toolbar-button').first(),
  ).toBeVisible();

  const geometry = await toolbar.evaluate((element) => {
    const toolbarRect = element.getBoundingClientRect();
    const editorHeaderRect = element.closest('.squisq-editor-header')?.getBoundingClientRect();
    const viewTabsRect = element
      .querySelector('.squisq-toolbar-view-tabs')
      ?.getBoundingClientRect();
    const actionRect = element
      .querySelector('.squisq-toolbar-actions .squisq-toolbar-button')
      ?.getBoundingClientRect();
    const exportRect = element
      .querySelector('[aria-label="Export and share"]')
      ?.getBoundingClientRect();
    return {
      devicePixelRatio: globalThis.devicePixelRatio,
      toolbarHeight: toolbarRect.height,
      editorHeaderHeight: editorHeaderRect?.height,
      viewTabsBottom: viewTabsRect?.bottom,
      actionTop: actionRect?.top,
      exportBottom: exportRect?.bottom,
      headerBottom: editorHeaderRect?.bottom,
    };
  });

  const physicalPixel = 1 / geometry.devicePixelRatio;
  // The editor header owns the 1px divider, leaving 83px of toolbar content.
  expect(Math.abs(geometry.toolbarHeight - 83)).toBeLessThan(physicalPixel);
  expect(Math.abs((geometry.editorHeaderHeight ?? Infinity) - 84)).toBeLessThan(physicalPixel);
  expect(geometry.actionTop).toBeGreaterThanOrEqual(
    (geometry.viewTabsBottom ?? Infinity) - physicalPixel,
  );
  expect(geometry.exportBottom).toBeLessThanOrEqual(
    (geometry.headerBottom ?? -Infinity) + physicalPixel,
  );
});
