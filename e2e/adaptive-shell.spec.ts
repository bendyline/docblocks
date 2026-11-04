import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * Layout behaviour of the adaptive shell. Runs on the touch-emulating device
 * projects declared in playwright.config.ts, so `data-db-pointer` is really
 * `coarse` here rather than a viewport size standing in for one.
 */

async function openWelcomeDocument(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();
  // Each test gets a fresh context, so a first-run gateway is deterministic --
  // but which one depends on the layout. Single-pane shows the compact
  // first-run screen; split-pane shows the slideshow gateway. Wait for whichever
  // arrives rather than probing: `isVisible()` on a not-yet-rendered gateway
  // returns false immediately and silently skips opening the document.
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  // In single-pane the tour hands the viewport to the editor; wait for the
  // drawer to finish closing so probes read a settled layout.
  const shell = page.locator('.db-shell');
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane') {
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
  }
}

/**
 * A touch drag through Chromium's own input pipeline. Synthetic DOM events
 * would skip the part that matters: the browser deciding, from touch-action,
 * whether a sideways move is its scroll or the page's pointer drag.
 */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  /** Runs with the finger halfway there and still down. */
  midway?: () => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const STEPS = 12;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let step = 1; step <= STEPS; step++) {
    if (step === STEPS / 2 + 1) await midway?.();
    const t = step / STEPS;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** The stamped contract that `docblocks.css` keys off. */
async function layoutAttributes(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      width: root.getAttribute('data-db-width'),
      formFactor: root.getAttribute('data-db-form-factor'),
      pointer: root.getAttribute('data-db-pointer'),
      layout: root.getAttribute('data-db-layout'),
      drawer: root.getAttribute('data-db-drawer'),
    };
  });
}

test.describe('adaptive shell on a phone', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('stamps a coarse single-pane form factor and keeps both panes mounted', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);

    const attributes = await layoutAttributes(page);
    expect(attributes.pointer).toBe('coarse');
    expect(attributes.formFactor).toBe('phone');
    expect(attributes.layout).toBe('single-pane');

    // Both panes exist even though only one is reachable.
    await expect(page.locator('aside.db-shell-sidebar')).toHaveCount(1);
    await expect(page.locator('main.db-shell-editor-area')).toHaveCount(1);
  });

  test('opens the drawer without tearing down the editor', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);

    // Tag the live editor node so we can prove identity across the toggle.
    // Unmounting it would destroy Tiptap, Monaco, undo history and scroll
    // position — the regression this layout exists to prevent.
    await page.evaluate(() => {
      const editor = document.querySelector('.squisq-editor-shell');
      if (!editor) throw new Error('editor shell not found');
      (editor as HTMLElement).dataset.identityProbe = 'original';
    });

    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'open');
    await expect(page.locator('main.db-shell-editor-area')).toHaveAttribute('inert', '');

    // The drawer slides in over ~220ms. Wait for it to settle flush with the
    // start edge before measuring anything: a boundingBox() taken mid-flight
    // reports the off-screen position and every derived coordinate is wrong.
    await expect
      .poll(async () =>
        Math.round((await page.locator('aside.db-shell-sidebar').boundingBox())?.x ?? -1),
      )
      .toBe(0);

    const drawerBox = await page.locator('aside.db-shell-sidebar').boundingBox();
    const scrimBox = await page.locator('.db-shell-scrim').boundingBox();
    if (!drawerBox || !scrimBox) throw new Error('drawer or scrim not laid out');

    // The drawer is capped at 85vw precisely so a dismissable strip of scrim
    // always remains. Assert that invariant, then tap it.
    const uncovered = scrimBox.x + scrimBox.width - (drawerBox.x + drawerBox.width);
    expect(uncovered, 'no tappable scrim left beside the drawer').toBeGreaterThanOrEqual(44);
    await page.locator('.db-shell-scrim').click({
      position: { x: scrimBox.width - uncovered / 2, y: scrimBox.height / 2 },
    });
    await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'closed');

    const survived = await page.evaluate(
      () =>
        document.querySelector('.squisq-editor-shell')?.getAttribute('data-identity-probe') ?? null,
    );
    expect(survived, 'the editor node was replaced across a drawer toggle').toBe('original');
  });

  test('swipes the drawer open over the document and shut over the files', async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    test.skip(browserName !== 'chromium', 'drives touch input through CDP');
    await openWelcomeDocument(page);
    const shell = page.locator('.db-shell');

    // Both drags start inside a scroller -- the editor, then the file tree --
    // where the browser takes a sideways move for itself unless told not to.
    const editorBox = await page.locator('.squisq-wysiwyg-container').boundingBox();
    if (!editorBox) throw new Error('editor not laid out');
    const y = editorBox.y + editorBox.height / 2;
    const sidebar = page.locator('aside.db-shell-sidebar');
    // Halfway through, the drawer is on screen and part way out, under the finger.
    const partWayOut = async () => {
      await expect(sidebar).toBeVisible();
      const box = await sidebar.boundingBox();
      if (!box) throw new Error('drawer not laid out');
      expect(box.x).toBeLessThan(-box.width * 0.2);
      expect(box.x).toBeGreaterThan(-box.width * 0.8);
    };
    await touchDrag(page, { x: 2, y }, { x: editorBox.width * 0.8, y }, partWayOut);
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    await expect
      .poll(async () =>
        Math.round((await page.locator('aside.db-shell-sidebar').boundingBox())?.x ?? -1),
      )
      .toBe(0);

    const treeBox = await page.locator('.db-tree').boundingBox();
    if (!treeBox) throw new Error('file tree not laid out');
    const treeY = treeBox.y + Math.min(treeBox.height / 2, 120);
    await touchDrag(
      page,
      { x: treeBox.x + treeBox.width * 0.7, y: treeY },
      { x: treeBox.x + 8, y: treeY },
      partWayOut,
    );
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
  });

  test('opens the outline from the right edge and closes it under the drawer', async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    test.skip(browserName !== 'chromium', 'drives touch input through CDP');
    await openWelcomeDocument(page);
    const body = await page.locator('.squisq-editor-with-gutter').boundingBox();
    if (!body) throw new Error('editor body not laid out');
    const y = body.y + body.height / 2;

    await touchDrag(page, { x: body.x + body.width - 2, y }, { x: body.x + 80, y });
    const sheet = page.getByTestId('navigation-sheet');
    await expect(sheet).toHaveAttribute('data-state', 'open');
    // The outline sits on the sheet's surface, not on the side pane's desk.
    const outline = sheet.locator('.squisq-outline');
    await expect(outline).toBeVisible();
    expect(await outline.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );

    // Left open under the drawer, the sheet would take the next Back press.
    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'open');
    await expect(sheet).toHaveAttribute('data-state', 'closed');
  });

  test('mounts one editor for a newly created document', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await page.goto('/');
    const create = page.getByRole('button', { name: 'Create a document', exact: true });
    await expect(create).toBeVisible({ timeout: 30_000 });
    // The first-run card renders in the same commit that adopts the welcome
    // document, but that document's editor is lazy and can still be behind its
    // Suspense fallback here. Snapshotted before it mounts, the probe below
    // counts it as a mount of the new document: under load the welcome editor
    // lands a few hundred milliseconds after the card and the count reads 2.
    await expect(page.locator('.ProseMirror')).toHaveCount(1, { timeout: 30_000 });

    // Count every editor created from here on. A second mount replaced the
    // editor the person was already tapping, so on a slow phone their first
    // keystrokes landed at the top of the new document, splitting the title.
    await page.evaluate(() => {
      const probe = window as Window & { editorMounts?: number };
      const seen = new WeakSet<Element>(document.querySelectorAll('.ProseMirror'));
      probe.editorMounts = 0;
      new MutationObserver(() => {
        for (const editor of document.querySelectorAll('.ProseMirror')) {
          if (seen.has(editor)) continue;
          seen.add(editor);
          probe.editorMounts = (probe.editorMounts ?? 0) + 1;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await create.click();
    await page.getByRole('textbox', { name: 'Document name', exact: true }).fill('first-draft');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // Settled: the shell has adopted the new path, and the welcome document's
    // editor is gone. Tiptap destroys a replaced editor on a deferred tick, so
    // a second mount, had there been one, has happened by now.
    // By path rather than role: the closed drawer is outside the accessibility
    // tree on WebKit, and getByRole skips hidden elements.
    await expect(
      page.locator(
        '.db-tree-row[data-path="first-draft.md"], .db-tree-row[data-path="/first-draft.md"]',
      ),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ProseMirror')).toHaveCount(1);
    // By accessible name: the heading's text also carries Squisq's inline
    // block tag whenever the block is selected, as it is on WebKit here.
    await expect(
      page
        .locator('.ProseMirror')
        .getByRole('heading', { level: 1, name: 'first-draft', exact: true }),
    ).toBeVisible();

    const mounts = await page.evaluate(
      () => (window as Window & { editorMounts?: number }).editorMounts,
    );
    expect(mounts, 'creating a document mounted a throwaway editor first').toBe(1);
  });

  test('gives every shell control a reachable touch target', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await page.goto('/');
    const shell = page.locator('.db-shell');
    await expect(shell).toBeVisible();
    // Visibility can win the first WebKit frame before the form-factor effect
    // stamps the shell. Measuring in that frame reads the fine-pointer token
    // defaults (28px) rather than the settled coarse-pointer hit areas.
    await expect(shell).toHaveAttribute('data-db-pointer', 'coarse');

    const undersized = await page.evaluate(() => {
      const selectors = ['.db-tree-row', '.db-tree-more', '.db-explorer-btn'];
      const offenders: string[] = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          // ::after widens the hit area without moving the glyph, so measure
          // the union of the two.
          const after = getComputedStyle(element, '::after');
          const inset = Number.parseFloat(after.insetBlockStart || '0');
          const effectiveHeight = box.height - (Number.isFinite(inset) ? inset * 2 : 0);
          const effectiveWidth = box.width - (Number.isFinite(inset) ? inset * 2 : 0);
          if (effectiveHeight < 44 || effectiveWidth < 24) {
            offenders.push(
              `${selector} ${Math.round(effectiveWidth)}x${Math.round(effectiveHeight)}`,
            );
          }
        }
      }
      return offenders;
    });
    expect(undersized).toEqual([]);
  });

  test('keeps every text input above the iOS zoom threshold', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await page.goto('/');
    await expect(page.locator('.db-shell')).toBeVisible();
    // The first-run welcome covers the app; dismiss it to reach the drawer.
    const dismissWelcome = page.getByRole('button', { name: 'Dismiss welcome' });
    await expect(dismissWelcome).toBeVisible({ timeout: 30_000 });
    await dismissWelcome.click();
    // First run seeds the default workspace after the shell mounts, and the
    // picker loads its list asynchronously. Opened before then, the list
    // arrives mid-click: the new row pushes New Workspace down between press
    // and release, and the click lands on neither. The trigger names the
    // workspace only once that list has loaded.
    const picker = page.getByRole('button', { name: 'Switch workspace, current: My Documents' });
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await picker.click();
    await page.getByRole('button', { name: 'New Workspace' }).click();
    await expect(page.getByLabel('Workspace name')).toBeVisible();

    const fontSize = await page
      .getByLabel('Workspace name')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    // Below 16px, focusing the field makes iOS Safari zoom the whole page and
    // it never zooms back out.
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test('centres the Use-mode button on the Slideshow label at any text size', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    const trigger = page.getByRole('button', { name: 'Choose Use mode', exact: true });
    await expect(trigger).toBeVisible();
    // Android scales every font to the system text size and leaves padding
    // alone; scaling both font sizes reproduces that here.
    for (const zoom of [1, 1.15, 1.3]) {
      await page.locator('.db-shell').evaluate((shell, scale) => {
        for (const node of shell.querySelectorAll<HTMLElement>(
          '.squisq-toolbar-view-tab, .squisq-use-mode-trigger',
        )) {
          node.style.fontSize = `${13 * scale}px`;
        }
      }, zoom);
      const geometry = await trigger.evaluate((button) => {
        const label = document.querySelector('.squisq-toolbar-use-tab .squisq-toolbar-view-tab');
        if (!label) throw new Error('Slideshow tab not found');
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const box = button.querySelector('svg');
        if (!box) throw new Error('Use-mode glyph not found');
        const rect = box.getBoundingClientRect();
        return {
          offset: (rect.top + rect.bottom) / 2 - (text.top + text.bottom) / 2,
          border: Number.parseFloat(getComputedStyle(box).borderTopWidth),
        };
      });
      expect(Math.abs(geometry.offset), `at ${zoom * 100}% text`).toBeLessThanOrEqual(1);
      // A visible outline, so the arrow reads as a button.
      expect(geometry.border).toBeGreaterThanOrEqual(1);
    }
  });

  test('keeps the document controls on one row in a Use mode, with Export on screen', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    await page.locator('.squisq-toolbar-use-tab .squisq-toolbar-view-tab').click();
    await expect(page.locator('.squisq-toolbar > .squisq-preview-controls')).toBeVisible();

    const exportTrigger = page.getByRole('button', { name: 'Export and share', exact: true });
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('no viewport');
    const triggerBox = await exportTrigger.boundingBox();
    if (!triggerBox) throw new Error('Export trigger not laid out');
    // Export ends its row at the right edge rather than starting a row alone.
    expect(viewport.width - (triggerBox.x + triggerBox.width)).toBeLessThanOrEqual(2);
    const viewMenu = await page.locator('.squisq-toolbar > .squisq-view-menu').boundingBox();
    expect(viewMenu?.y).toBe(triggerBox.y);

    await exportTrigger.click();
    const menu = await page.locator('.db-toolbar-menu-dropdown').boundingBox();
    if (!menu) throw new Error('Export menu did not open');
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width + 1);
  });

  test('sizes Use-mode controls and rows like Write', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    const measure = async (selector: string) => {
      // Visible only: Squisq keeps a hidden measuring copy of the preview controls.
      const control = page.locator(selector).filter({ visible: true }).first();
      const box = await control.boundingBox();
      const glyph = await control.locator('svg').first().boundingBox();
      if (!box || !glyph) throw new Error(`${selector} is not laid out`);
      return { center: box.y + box.height / 2, height: box.height, glyph: glyph.width };
    };
    const write = await measure('.squisq-toolbar > .squisq-view-menu .squisq-toolbar-button');

    await page.locator('.squisq-toolbar-use-tab .squisq-toolbar-view-tab').click();
    await expect(page.locator('.squisq-toolbar > .squisq-preview-controls')).toBeVisible();
    // Squisq sizes these as a compact desktop cluster; on a phone they sat in
    // ~31px rows with 24px segments and a 14px print glyph.
    for (const selector of ['.squisq-preview-seg-btn', '.squisq-print-trigger']) {
      const control = await measure(selector);
      expect(Math.abs(control.center - write.center), selector).toBeLessThanOrEqual(1);
      expect(control.height, selector).toBeGreaterThanOrEqual(write.height);
    }
    expect((await measure('.squisq-print-trigger')).glyph).toBeCloseTo(write.glyph, 0);
    // The document controls wrap to their own row, a full Write row below.
    const documentRow = await measure('.squisq-toolbar > .squisq-view-menu .squisq-toolbar-button');
    expect(documentRow.center - write.center).toBeGreaterThanOrEqual(44);
  });

  test('never scrolls horizontally', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('keeps editor and drawer controls clear of phone cutouts', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    // Browser device emulation has no physical cutout. Supply the insets that
    // WKWebView receives on a phone, then measure the actual rendered chrome.
    for (const insets of [
      { width: 390, height: 844, top: 59, left: 0, right: 0, bottom: 34 },
      { width: 844, height: 390, top: 0, left: 59, right: 0, bottom: 21 },
    ]) {
      await page.setViewportSize({ width: insets.width, height: insets.height });
      await page.locator('.db-shell').evaluate((shell, safe) => {
        for (const edge of ['top', 'left', 'right', 'bottom'] as const)
          (shell as HTMLElement).style.setProperty(`--db-safe-${edge}`, `${safe[edge]}px`);
      }, insets);
      const toolbar = page.locator('.squisq-toolbar');
      await expect
        .poll(async () => Math.round((await toolbar.boundingBox())?.y ?? -1))
        .toBe(insets.top);
      const toolbarBox = await toolbar.boundingBox();
      const statusBox = await page.locator('.squisq-status-bar').boundingBox();
      if (!toolbarBox || !statusBox) throw new Error('Editor chrome is not laid out');
      expect(toolbarBox.x).toBeGreaterThanOrEqual(insets.left);
      expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(insets.width - insets.right + 1);
      expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(insets.height - insets.bottom + 1);

      await page.getByRole('button', { name: 'Show file list' }).click();
      const sidebarButton = page.locator('.db-shell-sidebar-header button').first();
      await expect(sidebarButton).toBeVisible();
      await expect
        .poll(async () => Math.round((await sidebarButton.boundingBox())?.y ?? -1))
        .toBeGreaterThanOrEqual(insets.top);
      await page
        .locator('.db-shell-scrim')
        .click({ position: { x: insets.width - 10, y: insets.height / 2 } });
      await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'closed');
    }
  });
});

test.describe('adaptive shell on a tablet', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('splits in landscape and drawers in portrait', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'iPad projects only');
    await openWelcomeDocument(page);

    const attributes = await layoutAttributes(page);
    expect(attributes.pointer).toBe('coarse');

    if (testInfo.project.name.includes('landscape')) {
      // 1194px wide: expanded, so both panes share the row and the resizer is
      // available.
      expect(attributes.width).toBe('expanded');
      expect(attributes.formFactor).toBe('tablet-landscape');
      expect(attributes.layout).toBe('split-pane');
      await expect(page.locator('.db-shell-sidebar-resizer')).toBeVisible();
      await expect(page.locator('.db-shell-scrim')).toHaveCount(0);
    } else {
      // 834px wide: above the 800px split floor but a touch device, so the
      // sidebar overlays rather than competing with the editor for width.
      expect(attributes.width).toBe('medium');
      expect(attributes.formFactor).toBe('tablet-portrait');
      expect(attributes.layout).toBe('single-pane');
      await expect(page.locator('.db-shell-sidebar-resizer')).toHaveCount(0);
    }
  });

  test('survives rotation without replacing the editor', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'iPad projects only');
    await openWelcomeDocument(page);

    await page.evaluate(() => {
      const editor = document.querySelector('.squisq-editor-shell');
      if (!editor) throw new Error('editor shell not found');
      (editor as HTMLElement).dataset.identityProbe = 'original';
    });

    const portrait = { width: 834, height: 1194 };
    const landscape = { width: 1194, height: 834 };
    const start = page.viewportSize() ?? portrait;
    const target = start.width > start.height ? portrait : landscape;

    await page.setViewportSize(target);
    await expect
      .poll(async () => (await layoutAttributes(page)).layout)
      .toBe(target.width > target.height ? 'split-pane' : 'single-pane');

    const survived = await page.evaluate(
      () =>
        document.querySelector('.squisq-editor-shell')?.getAttribute('data-identity-probe') ?? null,
    );
    expect(survived, 'rotating the device replaced the editor node').toBe('original');
  });
});
