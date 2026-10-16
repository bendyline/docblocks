/**
 * Evidence collection for a live or preview site ship review. This deliberately
 * uses fresh browser contexts: it never attaches to a person's browser profile.
 *
 * PowerShell:
 *   $env:LIVE_UX_BASE_URL='https://docblocks.com'
 *   npx tsx e2e/site-ship-review.ts reports/site-review
 *
 * Optional SHIP_REVIEW_PHASES=pages,app,sharing,video,mobile,browsers; defaults to all six.
 * Run the existing ux:crawl as well for the wider shell screenshot inventory. This is an audit,
 * not a release gate: inspect results.json, including failed steps and axe's
 * incomplete checks, and review the screenshots before reaching a verdict.
 */
import { chromium, firefox, webkit, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = (process.env.LIVE_UX_BASE_URL ?? 'http://127.0.0.1:5240').replace(/\/$/, '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(process.argv[2] ?? `reports/site-review-${stamp}`);
const supportedPhases = ['pages', 'app', 'sharing', 'video', 'mobile', 'browsers'];
const phases = (process.env.SHIP_REVIEW_PHASES ?? supportedPhases.join(','))
  .split(',')
  .map((name) => name.trim());
if (phases.some((name) => !supportedPhases.includes(name))) {
  throw new Error(`SHIP_REVIEW_PHASES must contain only: ${supportedPhases.join(',')}`);
}
const results: Array<Record<string, unknown>> = [];
const health: Array<Record<string, unknown>> = [];
const links = new Map<string, Set<string>>();
let phase = 'startup';

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}
function watch(page: Page): void {
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => health.push({ phase, kind: 'pageerror', error: error.message }));
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type()))
      health.push({ phase, kind: message.type(), text: message.text() });
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      health.push({ phase, kind: 'http', status: response.status(), url: response.url() });
  });
  page.on('requestfailed', (request) =>
    health.push({ phase, kind: 'requestfailed', url: request.url(), error: request.failure() }),
  );
}
async function persist(): Promise<void> {
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ base, recordedAt: new Date().toISOString(), results, health }, null, 2),
  );
}
async function step(name: string, page: Page, action: () => Promise<unknown>): Promise<void> {
  phase = name;
  const started = Date.now();
  try {
    const detail = await action();
    results.push({ name, status: 'completed', ms: Date.now() - started, detail });
    say(`CAPTURED ${name} (inspect assertions, axe results, and screenshot)`);
  } catch (error) {
    results.push({ name, status: 'failed', ms: Date.now() - started, error: String(error) });
    await page
      .screenshot({ path: path.join(output, `${name}-failure.png`), animations: 'disabled' })
      .catch(() => undefined);
    say(`FAIL ${name}: ${String(error).slice(0, 180)}`);
  }
  await persist();
}
async function capture(page: Page, name: string, scan = true, fullPage = false): Promise<unknown> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage,
    animations: 'disabled',
    caret: 'hide',
  });
  const dom = await page.locator('body').ariaSnapshot();
  await writeFile(path.join(output, `${name}.aria.txt`), dom);
  const metrics = await page.evaluate(() => ({
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((e) => ({
      level: e.tagName,
      text: e.textContent,
    })),
    brokenImages: Array.from(document.images)
      .filter((e) => e.complete && e.naturalWidth === 0)
      .map((e) => e.src),
    controls: Array.from(
      document.querySelectorAll<HTMLElement>(
        'button,a,input,select,textarea,[role="tab"],[role="radio"]',
      ),
    )
      .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)
      .map((e) => ({
        tag: e.tagName,
        text: e.innerText,
        label: e.getAttribute('aria-label'),
        title: e.getAttribute('title'),
        role: e.getAttribute('role'),
        href: e.getAttribute('href'),
        width: Math.round(e.getBoundingClientRect().width),
        height: Math.round(e.getBoundingClientRect().height),
      })),
  }));
  let axe: unknown = null;
  if (scan) {
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    axe = {
      violations: report.violations,
      incomplete: report.incomplete,
      passes: report.passes.length,
    };
    await writeFile(path.join(output, `${name}.axe.json`), JSON.stringify(axe, null, 2));
  }
  await writeFile(path.join(output, `${name}.metrics.json`), JSON.stringify(metrics, null, 2));
  return { screenshot: `${name}.png`, metrics, axe };
}
async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  if (await cancel.isVisible()) await cancel.click();
}
async function ready(page: Page): Promise<void> {
  await page.locator('.db-shell').waitFor({ timeout: 60_000 });
  await page.locator('.squisq-status-item').first().waitFor({ timeout: 60_000 });
}
/**
 * Let the browser deliver the selectionchange a click or caret key queued.
 * ProseMirror reads the caret from that event, so a key pressed in the same
 * millisecond acts on the previous selection: a speed no person reaches, and
 * a split title no person would see.
 */
async function settleSelection(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
}
async function createDocument(
  page: Page,
  name: string,
  text: string,
  mobile = false,
): Promise<void> {
  if (mobile) {
    await page.getByRole('button', { name: 'Create a document', exact: true }).click();
    await page.getByRole('textbox', { name: 'Document name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'New File', exact: true }).click();
    await page.getByRole('textbox', { name: 'New file name' }).fill(`${name}.md`);
    await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
    await expect(page.getByRole('treeitem', { name: new RegExp(name) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
  const editor = page.locator('.ProseMirror');
  await expect(editor).toHaveText(mobile ? name : '');
  if (mobile) {
    // Preserve the heading seeded by the creation dialog. Use keyboard input
    // rather than replacing the contenteditable DOM of a structured document.
    await editor.click();
    await settleSelection(page);
    await page.keyboard.press('Control+End');
    await settleSelection(page);
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(text);
  } else {
    await editor.fill(text);
  }
  await expect(editor).toContainText(text);
  // Reload is the durable-save assertion. Merely seeing text in the editor or
  // clicking two file rows back-to-back does not establish a completed transition.
  await page.reload();
  await ready(page);
  await expect(page.locator('.ProseMirror')).toContainText(text);
}
async function exportDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Export and share' }).click();
  await page.getByRole('menuitem', { name: 'Export document...' }).click();
  await page.getByRole('dialog', { name: 'Export Document' }).waitFor();
}

await mkdir(output, { recursive: true });
await mkdir(path.join(output, 'downloads'), { recursive: true });
const browser = await chromium.launch();
try {
  if (phases.includes('pages')) {
    const routes = [
      '/web/',
      '/desktop/',
      '/vscode/',
      '/cli/',
      '/formats/',
      '/docs/',
      '/privacy/',
      '/terms/',
    ];
    for (const profile of [
      { name: 'desktop-light', width: 1440, height: 1000, theme: 'light' as const },
      { name: 'desktop-dark', width: 1440, height: 1000, theme: 'dark' as const },
      { name: 'phone-light', width: 390, height: 844, theme: 'light' as const },
      { name: 'phone-small', width: 320, height: 640, theme: 'light' as const },
    ]) {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        colorScheme: profile.theme,
        isMobile: profile.width < 500,
        hasTouch: profile.width < 500,
      });
      const page = await context.newPage();
      watch(page);
      for (const route of routes) {
        const name = `${profile.name}-${route.split('/')[1]}`;
        await step(name, page, async () => {
          const response = await page.goto(`${base}${route}`, { waitUntil: 'load' });
          expect(response?.status()).toBe(200);
          if (route === '/desktop/') {
            await page
              .getByText('Finding the latest installers…')
              .waitFor({ state: 'hidden', timeout: 25_000 });
          }
          const anchors = await page.locator('a[href]').evaluateAll((elements) =>
            elements.map((e) => ({
              href: (e as HTMLAnchorElement).href,
              text: (e as HTMLElement).innerText,
            })),
          );
          for (const anchor of anchors) {
            if (!/^https?:/.test(anchor.href)) continue;
            const sources = links.get(anchor.href) ?? new Set<string>();
            sources.add(route);
            links.set(anchor.href, sources);
          }
          return {
            response: response?.status(),
            ...((await capture(page, name, true, true)) as object),
          };
        });
      }
      if (profile.name === 'desktop-light') {
        await step('not-found', page, async () => {
          const response = await page.goto(`${base}/ship-review-missing-page/`);
          return {
            status: response?.status(),
            ...((await capture(page, 'not-found', true, true)) as object),
          };
        });
      }
      await context.close();
    }
    const linkChecks: Array<Record<string, unknown>> = [];
    const context = await browser.newContext();
    for (const [href, sources] of links) {
      try {
        const url = new URL(href);
        const response = await context.request.head(href, { timeout: 20_000 });
        linkChecks.push({
          href,
          sources: [...sources],
          status: response.status(),
          finalUrl: response.url(),
          internal: url.origin === new URL(base).origin,
        });
        await response.dispose();
      } catch (error) {
        linkChecks.push({ href, sources: [...sources], error: String(error) });
      }
    }
    await writeFile(path.join(output, 'links.json'), JSON.stringify(linkChecks, null, 2));
    await context.close();
  }
  if (phases.includes('app')) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    watch(page);
    await step('fresh-app', page, async () => {
      await page.goto(base);
      await ready(page);
      return capture(page, 'fresh-app');
    });
    await step('start-writing', page, async () => {
      await page.locator('.db-welcome-gateway-cta').click();
      await page.locator('[contenteditable="true"]').first().waitFor();
      return capture(page, 'start-writing');
    });
    for (const name of [
      'Insert',
      'More actions',
      'Version history',
      'Custom layouts',
      'View options',
      'Document settings',
      'Attachments',
      'Choose Use mode',
    ]) {
      await step(`control-${name.replaceAll(' ', '-')}`, page, async () => {
        const toolbar = page.getByRole('toolbar', { name: 'Formatting toolbar' });
        const control = toolbar
          .getByRole('button', { name, exact: true })
          .or(toolbar.getByRole('checkbox', { name, exact: true }));
        await control.click();
        const detail = await capture(page, `control-${name.replaceAll(' ', '-')}`);
        await dismiss(page);
        if (name === 'Attachments') await control.click();
        return detail;
      });
    }
    await step('create-and-edit', page, async () => {
      await createDocument(page, 'ship-review', 'Ship review persistence marker.');
      await page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).click();
      await expect(page.locator('.ProseMirror')).toContainText('Write in plain Markdown');
      await page.locator('.db-tree-row', { hasText: 'ship-review' }).click();
      await expect(page.locator('[contenteditable="true"]').first()).toContainText(
        'Ship review persistence marker.',
      );
      await page.reload();
      await ready(page);
      await expect(page.locator('[contenteditable="true"]').first()).toContainText(
        'Ship review persistence marker.',
      );
      return capture(page, 'persisted-document');
    });
    await step('source-round-trip', page, async () => {
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      // Monaco may expose an offscreen textarea when Chromium uses EditContext.
      // Click the visible text surface and send ordinary user keystrokes.
      await page.locator('.monaco-editor .view-lines').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(
        '# Ship review\n\nPersistence marker and **bold text**.\n\n## Checklist\n\n- First item\n- Second item\n\n| Item | Status |\n| --- | --- |\n| Export | Ready |\n\n```js\nconst answer = 42;\n```\n',
      );
      await page.getByRole('tab', { name: 'Write', exact: true }).click();
      await expect(page.locator('[contenteditable="true"]').first()).toContainText(
        'Persistence marker',
      );
      await expect(page.locator('[contenteditable="true"] strong')).toContainText('bold text');
      await expect(page.locator('[contenteditable="true"]').first()).not.toContainText(
        'Ship review persistence marker.',
      );
      return capture(page, 'source-round-trip');
    });
    for (const [label, extension] of [
      ['Markdown', 'md'],
      ['Word', 'docx'],
      ['PDF', 'pdf'],
      ['PowerPoint', 'pptx'],
      ['EPUB', 'epub'],
      ['HTML', 'html'],
    ]) {
      await step(`download-${extension}`, page, async () => {
        await dismiss(page);
        await exportDialog(page);
        const dialog = page.getByRole('dialog', { name: 'Export Document' });
        await dialog.getByRole('radio', { name: label, exact: true }).click();
        await capture(page, `export-options-${extension}`, false);
        const pending = page.waitForEvent('download', { timeout: 60_000 });
        await dialog.getByRole('button', { name: /Save .* to Downloads/ }).click();
        const download = await pending;
        const name = download.suggestedFilename();
        await download.saveAs(path.join(output, 'downloads', name));
        const bytes = await readFile(path.join(output, 'downloads', name));
        expect(bytes.length).toBeGreaterThan(20);
        expect(name.endsWith(`.${extension}`)).toBe(true);
        return {
          name,
          bytes: bytes.length,
          prefix: bytes.subarray(0, 12).toString('hex'),
          failure: await download.failure(),
        };
      });
    }
    await step('rename-file-keyboard', page, async () => {
      await dismiss(page);
      const row = page.locator('.db-tree-row', { hasText: 'ship-review' });
      await row.click();
      await row.press('F2');
      const input = page.locator('.db-tree-rename-input');
      await input.fill('ship-review-renamed.md');
      await input.press('Enter');
      await expect(page.locator('.db-tree-row', { hasText: 'ship-review-renamed' })).toBeVisible();
      await expect(page).toHaveURL(/ship-review-renamed\.md$/);
      await page.reload();
      await ready(page);
      await expect(page.locator('[contenteditable="true"]').first()).toContainText(
        'Persistence marker',
      );
      return capture(page, 'renamed-document');
    });
    await step('workspace-backup', page, async () => {
      await page.locator('.db-ws-settings-btn').click();
      const pending = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: 'Back up this workspace', exact: true }).click();
      const download = await pending;
      await download.saveAs(path.join(output, 'downloads', download.suggestedFilename()));
      return { name: download.suggestedFilename(), failure: await download.failure() };
    });
    await step('settings-keyboard-and-preferences', page, async () => {
      await page.locator('.db-app-menu-btn').click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await dialog.getByRole('radio', { name: 'Dark', exact: true }).check();
      await dialog.getByRole('slider', { name: 'Text size' }).fill('20');
      const detail = await capture(page, 'settings-dark');
      const escapes: string[] = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        if (!(await dialog.evaluate((e) => e.contains(document.activeElement))))
          escapes.push(await page.evaluate(() => document.activeElement?.outerHTML ?? 'none'));
      }
      await page.keyboard.press('Escape');
      const focus = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'),
        text: document.activeElement?.textContent?.slice(0, 80),
      }));
      await page.reload();
      await ready(page);
      return {
        detail,
        tabEscapes: escapes,
        focusAfterEscape: focus,
        theme: await page.locator('html').getAttribute('data-db-theme'),
        font: await page
          .locator('.squisq-editor-shell')
          .evaluate((e) => getComputedStyle(e).getPropertyValue('--squisq-write-text-size')),
      };
    });
    await step('offline-reload', page, async () => {
      await page.waitForFunction(
        () => !!navigator.serviceWorker?.controller,
        {},
        { timeout: 30_000 },
      );
      await context.setOffline(true);
      try {
        await page.reload();
        await ready(page);
        await expect(page.locator('[contenteditable="true"]').first()).toContainText(
          'Persistence marker',
        );
        return capture(page, 'offline-reload', false);
      } finally {
        await context.setOffline(false);
      }
    });
    await context.close();
  }
  if (phases.includes('sharing')) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const recipientContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    watch(page);
    const recipient = await recipientContext.newPage();
    watch(recipient);
    try {
      await page.goto(base);
      await ready(page);
      await page.locator('.db-welcome-gateway-cta').click();
      await createDocument(page, 'share-review', 'Shared document verification.');
      const openShare = async () => {
        await page.getByRole('button', { name: 'Export and share' }).click();
        await page.getByRole('menuitem', { name: 'Share link with content embedded...' }).click();
        await page.getByRole('button', { name: 'Copy link', exact: true }).click();
        return page.evaluate(() => navigator.clipboard.readText());
      };
      await step('share-text-round-trip', recipient, async () => {
        const url = await openShare();
        await recipient.goto(url);
        await ready(recipient);
        await expect(recipient.locator('.ProseMirror')).toContainText(
          'Shared document verification.',
        );
        return capture(recipient, 'shared-text-recipient');
      });
      await step('share-keyboard-containment', page, async () => {
        const dialog = page.getByRole('dialog', { name: 'Share document' });
        await capture(page, 'share-dialog');
        const focus: Array<{ inside: boolean; tag?: string; label?: string | null }> = [];
        try {
          await dialog.getByRole('button', { name: /Copy link|Copied/, exact: true }).focus();
          for (let i = 0; i < 16; i++) {
            await page.keyboard.press('Tab');
            focus.push(
              await page.evaluate(() => ({
                inside: !!document.activeElement?.closest('[role="dialog"]'),
                tag: document.activeElement?.tagName,
                label: document.activeElement?.getAttribute('aria-label'),
              })),
            );
          }
          await writeFile(path.join(output, 'share-focus.json'), JSON.stringify(focus, null, 2));
          expect(
            focus.filter((item) => !item.inside),
            'Tab must remain in the share dialog',
          ).toHaveLength(0);
          return { focus };
        } finally {
          await page.keyboard.press('Escape');
        }
      });
      await step('share-image-omission', recipient, async () => {
        // Synthetic local media; no personal files or external images are used.
        const dataUrl = await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 240;
          canvas.height = 120;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas is unavailable');
          context.fillStyle = '#175bb8';
          context.fillRect(0, 0, 240, 120);
          context.fillStyle = 'white';
          context.font = '18px sans-serif';
          context.fillText('Review image', 24, 66);
          return canvas.toDataURL('image/png');
        });
        await page.locator('.ProseMirror').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.press('Enter');
        await page
          .locator('.squisq-toolbar input[type="file"]')
          .first()
          .setInputFiles({
            name: 'review-image.png',
            mimeType: 'image/png',
            buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
          });
        await expect(page.locator('.ProseMirror img')).toHaveJSProperty('naturalWidth', 240);
        await page.reload();
        await ready(page);
        await expect(page.locator('.ProseMirror img')).toHaveJSProperty('naturalWidth', 240);
        await capture(page, 'shared-image-source', false);
        const url = await openShare();
        await expect(page.getByRole('dialog', { name: 'Share document' })).toContainText(
          'Images are excluded from share links.',
        );
        await recipient.goto(url);
        await ready(recipient);
        await expect(recipient.locator('.ProseMirror')).toContainText(
          'Shared document verification.',
        );
        await capture(recipient, 'shared-image-recipient');
        await expect(recipient.locator('.ProseMirror img')).toHaveCount(0);
        await expect(recipient.getByRole('img', { name: /Image unavailable/ })).toHaveCount(0);
        await expect(recipient.locator('.ProseMirror')).toContainText('review image');
        await page.reload();
        await ready(page);
        await expect(page.locator('.ProseMirror img')).toHaveJSProperty('naturalWidth', 240);
      });
    } finally {
      await context.close();
      await recipientContext.close();
    }
  }
  if (phases.includes('video')) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    watch(page);
    try {
      await page.goto(base);
      await ready(page);
      await page.locator('.db-welcome-gateway-cta').click();
      await createDocument(page, 'video-review', 'Video review.');
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.locator('.monaco-editor .view-lines').click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(
        '# Video review\n\nA clear opening sentence.\n\n## Second section\n\n- First item\n- Second item\n',
      );
      await page.getByRole('tab', { name: 'Write', exact: true }).click();
      await expect(page.locator('.ProseMirror')).toContainText('A clear opening sentence.');
      for (const animations of ['enabled', 'disabled']) {
        await step(`video-${animations}`, page, async () => {
          try {
            await page.getByRole('button', { name: 'Export and share' }).click();
            await page.getByRole('menuitem', { name: 'Export video...' }).click();
            await page.getByRole('dialog', { name: 'Export Video' }).waitFor({ timeout: 30_000 });
            await page.getByRole('combobox', { name: 'Animations and transitions' }).selectOption({
              label: animations === 'enabled' ? 'Enabled' : 'Disabled — smaller files',
            });
            await capture(page, `video-${animations}-options`, false);
            await page.getByRole('button', { name: 'Export Video', exact: true }).click();
            await page
              .getByRole('button', { name: 'Save MP4 to Downloads', exact: true })
              .waitFor({ timeout: 60_000 });
            await capture(page, `video-${animations}-complete`, false);
            const pending = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Save MP4 to Downloads', exact: true }).click();
            const download = await pending;
            const destination = path.join(output, 'downloads', `video-${animations}.mp4`);
            await download.saveAs(destination);
            const bytes = await readFile(destination);
            expect(bytes.length).toBeGreaterThan(1000);
            expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
            return { file: destination, bytes: bytes.length, requiresVisualReview: true };
          } finally {
            const close = page.getByRole('button', { name: 'Close export dialog' });
            if (await close.isVisible()) await close.click();
          }
        });
      }
    } finally {
      await context.close();
    }
  }
  if (phases.includes('mobile')) {
    for (const profile of [
      { name: 'phone', width: 390, height: 844 },
      { name: 'small-phone', width: 320, height: 640 },
      { name: 'tablet', width: 768, height: 1024 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      watch(page);
      await step(`${profile.name}-edit-export`, page, async () => {
        await page.goto(base);
        await ready(page);
        await createDocument(page, 'mobile-review', 'Mobile review text.', true);
        const editor = await capture(page, `${profile.name}-editing`);
        await exportDialog(page);
        const dialog = await capture(page, `${profile.name}-export`);
        await page.getByRole('radio', { name: 'Markdown', exact: true }).click();
        const pending = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Save MD to Downloads', exact: true }).click();
        const download = await pending;
        const destination = path.join(output, 'downloads', `${profile.name}.md`);
        await download.saveAs(destination);
        // The heading seeded by the creation dialog must survive intact. A bare
        // containment check passed while the typed text had split the heading
        // into "# mobile-revi" and "# Mobile review text.ew".
        expect(await readFile(destination, 'utf8')).toMatch(
          /^# mobile-review\s*\n\s*\nMobile review text\.\s*$/,
        );
        return { editor, dialog, download: download.suggestedFilename() };
      });
      await context.close();
    }
  }
  if (phases.includes('browsers')) {
    for (const engine of [
      { name: 'firefox', type: firefox },
      { name: 'webkit', type: webkit },
    ]) {
      const engineBrowser = await engine.type.launch();
      try {
        const engineContext = await engineBrowser.newContext({
          viewport: { width: 1280, height: 900 },
        });
        const page = await engineContext.newPage();
        watch(page);
        await step(`${engine.name}-persistence`, page, async () => {
          await page.goto(base);
          await ready(page);
          await page.locator('.db-welcome-gateway-cta').click();
          await createDocument(page, 'browser-review', 'Browser persistence check');
          await page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).click();
          await expect(page.locator('.ProseMirror')).toContainText('Write in plain Markdown');
          await page.locator('.db-tree-row', { hasText: 'browser-review' }).click();
          await expect(page.locator('.ProseMirror')).toContainText('Browser persistence check');
          await page.reload();
          await ready(page);
          await expect(page.locator('.ProseMirror')).toContainText('Browser persistence check');
          return capture(page, `${engine.name}-persisted`);
        });
      } finally {
        await engineBrowser.close();
      }
    }
  }
} finally {
  await persist();
  await browser.close();
}
say(`Evidence saved to ${output}`);
const failed = results.filter((result) => result.status === 'failed').length;
say(
  `${results.length} steps recorded; ${failed} failed. Completed captures are not an accessibility pass.`,
);
if (failed > 0) process.exitCode = 1;
