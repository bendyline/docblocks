import type { Page } from '@playwright/test';
import { centerOf, windowDragsAt } from './drag-regions.js';
import { expect, test, tourWelcome } from './fixtures.js';
import { showWriteView } from '../../../e2e/helpers/toolbar.js';

async function collapseSidebar(window: Page): Promise<void> {
  const resizer = window.getByRole('separator', { name: 'Resize sidebar' });
  const resizerBox = await resizer.boundingBox();
  if (!resizerBox) throw new Error('Sidebar resizer not found');
  const y = resizerBox.y + resizerBox.height / 2;
  await window.mouse.move(resizerBox.x + resizerBox.width / 2, y);
  await window.mouse.down();
  await window.mouse.move(100, y);
  await window.mouse.up();
  await expect(window.locator('.db-shell')).toHaveClass(/db-shell--mobile/);
}

test('keeps toolbar controls outside the native caption button area', async ({ launchApp }) => {
  const { window } = await launchApp();
  const toolbar = window.locator('.squisq-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await tourWelcome(window);
  await window.evaluate(() => globalThis.resizeTo(972, 600));
  await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBeLessThan(1_000);
  await expect(window.locator('.db-shell')).toHaveClass(/db-shell--desktop-toolbar-wrapped/);
  await showWriteView(toolbar);
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
    const editorHeaderBorder = editorHeader
      ? Number.parseFloat(getComputedStyle(editorHeader).borderBottomWidth)
      : Number.NaN;

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
      editorHeaderContentBottom: (editorHeaderRect?.bottom ?? Number.NaN) - editorHeaderBorder,
      sidebarHeaderHeight: sidebarHeaderRect?.height,
      viewTabsBottom: viewTabsRect?.bottom,
      viewTabsRight: viewTabsRect?.right,
      controls,
      exportTop: exportRect?.top,
      exportBottom: exportRect?.bottom,
      exportRight: exportRect?.right,
    };
  });

  const physicalPixel = 1 / geometry.devicePixelRatio;
  expect(Math.abs((geometry.editorHeaderHeight ?? Infinity) - 84)).toBeLessThan(physicalPixel);
  expect(Math.abs((geometry.sidebarHeaderHeight ?? Infinity) - 84)).toBeLessThan(physicalPixel);
  expect(geometry.viewTabsBottom).not.toBeUndefined();
  // The tab row's surface must run to the window edge; stopping short leaves
  // the lighter toolbar background showing beside the native close button.
  expect(Math.abs((geometry.viewTabsRight ?? -Infinity) - geometry.toolbar.right)).toBeLessThan(
    physicalPixel,
  );
  expect(geometry.exportTop).toBeGreaterThanOrEqual(
    (geometry.viewTabsBottom ?? Infinity) - physicalPixel,
  );
  expect(geometry.exportRight).toBeLessThanOrEqual(geometry.toolbar.right - 8);
  // The second row centers its controls between the tab row and the header's
  // bottom divider, as the single-row toolbar does. Stretched flex lines once
  // left them a few pixels low.
  const spaceAbove = (geometry.exportTop ?? Number.NaN) - (geometry.viewTabsBottom ?? Number.NaN);
  const spaceBelow = geometry.editorHeaderContentBottom - (geometry.exportBottom ?? Number.NaN);
  expect(Math.abs(spaceAbove - spaceBelow)).toBeLessThan(physicalPixel);
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
  await tourWelcome(window);
  await showWriteView(toolbar);

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

test('keeps the collapsed titlebar draggable over a scrolled document', async ({ launchApp }) => {
  const { window } = await launchApp();
  const toolbar = window.locator('.squisq-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await tourWelcome(window);
  await showWriteView(toolbar);
  await collapseSidebar(window);

  // Scrolling carries the editor's contenteditable, and the controls inside
  // it, up beneath the caption band. Chromium does not clip app-region boxes
  // to their scroller, so while that content declared no-drag it carved the
  // whole titlebar away, and a collapsed layout has no sidebar header left
  // to drag instead.
  await window.locator('.squisq-wysiwyg-container').evaluate((element) => {
    element.scrollTop = 400;
  });
  const editorTop = await window
    .locator('.squisq-wysiwyg-editor')
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(editorTop).toBeLessThan(0);

  const tabRowGap = await toolbar.evaluate((element) => {
    const row = element.querySelector('.squisq-toolbar-view-tabs');
    if (!row) throw new Error('View tab row not found');
    const rowRect = row.getBoundingClientRect();
    const lastControlRight = Math.max(
      ...Array.from(row.children, (child) => child.getBoundingClientRect().right),
    );
    const point = { x: lastControlRight + 24, y: rowRect.top + rowRect.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      point,
      empty:
        hit !== null &&
        element.contains(hit) &&
        hit.closest('button, a, input, [role="button"], [role="tab"]') === null,
    };
  });
  expect(tabRowGap.empty).toBe(true);
  const writeTab = toolbar.locator('[role="tab"][data-view="wysiwyg"]');
  expect(await windowDragsAt(window, [tabRowGap.point, await centerOf(writeTab)])).toEqual([
    true,
    false,
  ]);

  // The file drawer slides over that header but precedes it in the document,
  // so the covered header must not decide the drawer's own titlebar: its
  // controls stay clickable and its grip still moves the window.
  await toolbar.getByRole('button', { name: 'Show file list' }).click();
  await expect(window.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'open');
  const sidebar = window.locator('.db-shell-sidebar');
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().left)))
    .toBe(0);
  const drawerHeader = sidebar.locator('.db-shell-sidebar-header');
  const grip = drawerHeader.locator('.db-window-drag-grip');
  await grip.hover();
  await expect(grip).not.toHaveClass(/db-window-drag-grip--detect-hover/);
  const settings = drawerHeader.getByRole('button', { name: 'Workspace settings' });
  expect(await windowDragsAt(window, [await centerOf(grip), await centerOf(settings)])).toEqual([
    true,
    false,
  ]);
});

test('keeps the welcome screen drag strip inside its pane', async ({ launchApp }) => {
  const { window } = await launchApp();
  const gateway = window.locator('.db-welcome-gateway');
  await expect(gateway).toBeVisible({ timeout: 30_000 });

  // The titlebar-area values are measured from the window, but the welcome
  // screen starts after the sidebar. A strip sized from them alone overhangs
  // the pane by the sidebar's width, which Windows and Linux show as a
  // permanent horizontal scrollbar on the first screen.
  const geometry = await gateway.evaluate((element) => {
    const strip = getComputedStyle(element, '::before');
    return {
      devicePixelRatio: globalThis.devicePixelRatio,
      paneLeft: element.getBoundingClientRect().left,
      overflow: element.scrollWidth - element.clientWidth,
      stripLeft: Number.parseFloat(strip.left),
      stripRight: Number.parseFloat(strip.right),
    };
  });

  expect(geometry.paneLeft).toBeGreaterThan(0);
  expect(geometry.overflow).toBeLessThan(1 / geometry.devicePixelRatio);
  expect(geometry.stripLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.stripRight).toBeGreaterThanOrEqual(0);
});
