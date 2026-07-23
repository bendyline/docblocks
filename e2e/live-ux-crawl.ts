/**
 * Live-site UX crawl — captures a comprehensive screenshot inventory of the
 * deployed site (https://docblocks.com by default) for visual UX review,
 * along with a health log (console errors, page errors, failed requests,
 * service-worker state, load metrics, deployed version).
 *
 * This is NOT a Playwright test — it is a standalone driver script:
 *
 *   npx tsx e2e/live-ux-crawl.ts [outputDir]
 *   LIVE_UX_BASE_URL=http://localhost:5220 npx tsx e2e/live-ux-crawl.ts
 *
 * Output: <outputDir>/NN-<name>.png screenshots plus manifest.json and
 * health.json. Default outputDir is reports/ux-live-site-<stamp>/ (reports/
 * is gitignored, so captures stay local).
 *
 * Every step is guarded: a failing capture is recorded in manifest.skipped
 * and the crawl continues, so one missing selector never sinks the run.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildSharedDocumentUrl,
  createSharedDocumentArchive,
} from '../packages/react/src/Export/shared-document.js';

const BASE_URL = (process.env.LIVE_UX_BASE_URL ?? 'https://docblocks.com').replace(/\/$/, '');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const OUT_DIR = process.argv[2] ?? path.join('reports', `ux-live-site-${STAMP}`);
const READY_TIMEOUT = 60_000;

interface ShotEntry {
  file: string;
  name: string;
  description: string;
  url: string;
  title: string;
  viewport: string;
}

interface SkipEntry {
  name: string;
  error: string;
}

interface ConsoleEntry {
  phase: string;
  type: string;
  text: string;
  url: string;
}

interface RequestIssue {
  phase: string;
  url: string;
  status: number | string;
}

const manifest: { baseUrl: string; startedAt: string; shots: ShotEntry[]; skipped: SkipEntry[] } = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  shots: [],
  skipped: [],
};

const health: {
  consoleIssues: ConsoleEntry[];
  pageErrors: ConsoleEntry[];
  requestIssues: RequestIssue[];
  serviceWorker: unknown;
  deployedVersion: string | null;
  firstLoad: unknown;
} = {
  consoleIssues: [],
  pageErrors: [],
  requestIssues: [],
  serviceWorker: null,
  deployedVersion: null,
  firstLoad: null,
};

let currentPhase = 'boot';
let shotCounter = 0;

// Optional phase filter: LIVE_UX_PHASES=app-desktop-dark,marketing re-runs a
// subset. Phase keys: app-desktop-dark, app-desktop-light, app-mobile-dark,
// app-mobile-light, seo-bootstrap, marketing.
const PHASE_FILTER = (process.env.LIVE_UX_PHASES ?? '')
  .split(',')
  .map((phase) => phase.trim())
  .filter(Boolean);

function phaseEnabled(name: string): boolean {
  return PHASE_FILTER.length === 0 || PHASE_FILTER.includes(name);
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function wirePage(page: Page): void {
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' || type === 'warning') {
      health.consoleIssues.push({
        phase: currentPhase,
        type,
        text: message.text().slice(0, 500),
        url: page.url(),
      });
    }
  });
  page.on('pageerror', (error) => {
    health.pageErrors.push({
      phase: currentPhase,
      type: 'pageerror',
      text: String(error).slice(0, 500),
      url: page.url(),
    });
  });
  page.on('requestfailed', (request) => {
    // Aborted requests are usually deliberate (navigation, our own routing).
    const failure = request.failure()?.errorText ?? 'failed';
    if (failure.includes('ERR_ABORTED')) return;
    health.requestIssues.push({ phase: currentPhase, url: request.url(), status: failure });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      health.requestIssues.push({
        phase: currentPhase,
        url: response.url(),
        status: response.status(),
      });
    }
  });
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    manifest.skipped.push({ name, error: String(error).slice(0, 400) });
    say(`  ! skipped: ${name} — ${String(error).split('\n')[0]}`);
  }
}

async function shoot(
  page: Page,
  name: string,
  description: string,
  options: { fullPage?: boolean; settleMs?: number } = {},
): Promise<void> {
  await page.waitForTimeout(options.settleMs ?? 400);
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(2, '0')}-${name}.png`;
  await page.screenshot({
    path: path.join(OUT_DIR, file),
    fullPage: options.fullPage ?? false,
    animations: 'disabled',
    caret: 'hide',
  });
  const viewport = page.viewportSize();
  manifest.shots.push({
    file,
    name,
    description,
    url: page.url(),
    title: await page.title().catch(() => ''),
    viewport: viewport ? `${viewport.width}x${viewport.height}` : 'unknown',
  });
  say(`  + ${file}`);
}

async function waitForAppReady(page: Page): Promise<void> {
  await page.locator('.db-shell').waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  await page.locator('.db-explorer-toolbar').waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  await page
    .locator('.db-tree-row', { hasText: 'aboutDocBlocks' })
    .waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  await page.waitForFunction(
    () => /aboutdocblocks\.md$/i.test(decodeURIComponent(window.location.hash)),
    undefined,
    { timeout: READY_TIMEOUT },
  );
  await page
    .locator('.squisq-status-item')
    .first()
    .waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function dismissOpenLayer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

async function newAppContext(
  browser: Browser,
  options: {
    theme: 'light' | 'dark';
    viewport: { width: number; height: number };
    mobile?: boolean;
  },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport,
    colorScheme: options.theme,
    locale: 'en-US',
    isMobile: options.mobile ?? false,
    hasTouch: options.mobile ?? false,
    deviceScaleFactor: options.mobile ? 2 : 1,
  });
  await context.addInitScript((theme) => {
    window.localStorage.setItem('docblocks:themePreference', theme);
  }, options.theme);
  const page = await context.newPage();
  wirePage(page);
  return { context, page };
}

async function crawlAppDesktopDark(browser: Browser): Promise<void> {
  currentPhase = 'app-desktop-dark';
  say('Phase: app desktop dark');
  const { context, page } = await newAppContext(browser, {
    theme: 'dark',
    viewport: { width: 1440, height: 900 },
  });

  await step('first load + gateway (dark)', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    health.firstLoad = await page.evaluate(() => {
      const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
        resourceCount: resources.length,
        transferredKb: Math.round(
          resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024,
        ),
      };
    });
    health.deployedVersion = await page
      .locator('.db-shell-sidebar-footer a', { hasText: 'Report issue' })
      .getAttribute('href')
      .then((href) => {
        if (!href) return null;
        const body = new URL(href).searchParams.get('body') ?? '';
        return body.match(/- DocBlocks: (.+)$/m)?.[1] ?? null;
      })
      .catch(() => null);
    await page
      .locator('.db-welcome-gateway')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => say('  (welcome gateway did not appear)'));
    await shoot(page, 'app-first-run-gateway-dark', 'First visit: welcome gateway over Play view');
  });

  await step('service worker state', async () => {
    health.serviceWorker = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (registrations.length === 0) return 'none registered';
      return registrations.map((registration) => ({
        scope: registration.scope,
        state: registration.active?.state ?? registration.installing?.state ?? 'unknown',
      }));
    });
  });

  await step('editor after Start writing (dark)', async () => {
    await page.locator('.db-welcome-gateway-cta').click();
    await page
      .locator('[contenteditable="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    await shoot(page, 'app-editor-welcome-dark', 'Welcome document in edit mode after CTA');
  });

  await step('editor scrolled mid-document (dark)', async () => {
    await page.locator('main.db-shell-editor-area').hover();
    await page.mouse.wheel(0, 1400);
    await shoot(
      page,
      'app-editor-welcome-scrolled-dark',
      'Welcome doc mid-scroll: body typography',
    );
    await page.mouse.wheel(0, -3000);
  });

  await step('app menu (dark)', async () => {
    await page.locator('.db-app-menu-btn').click();
    await page.locator('.db-app-menu-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'app-menu-open-dark', 'App menu dropdown open');
  });

  await step('about dialog (dark)', async () => {
    await page.locator('.db-app-menu-dropdown').getByText('About').click();
    await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'about-dialog-dark', 'About dialog');
    await dismissOpenLayer(page);
  });

  await step('settings dialog (dark)', async () => {
    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page
      .getByRole('dialog', { name: 'Settings' })
      .waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'settings-dialog-dark', 'Settings dialog: theme, accent, typography');
    await dismissOpenLayer(page);
  });

  await step('workspace dropdown (dark)', async () => {
    await page.locator('.db-workspace-picker-btn').click();
    await page.locator('.db-workspace-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'workspace-dropdown-dark', 'Workspace picker dropdown');
    await dismissOpenLayer(page);
  });

  await step('workspace gear menu + settings dialog (dark)', async () => {
    // The gear opens a dropdown menu (Settings / Rename / Download / Remove),
    // not a dialog directly.
    await page.locator('.db-ws-settings-btn').click();
    await page.locator('.db-ws-settings-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'workspace-gear-menu-dark', 'Workspace gear dropdown menu');
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'workspace-settings-dialog-dark', 'Workspace settings dialog');
    await dismissOpenLayer(page);
  });

  await step('new file input (dark)', async () => {
    await page.getByRole('button', { name: 'New File' }).click();
    await page.locator('.db-new-item-input').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'explorer-new-file-input-dark', 'Inline new-file input in the explorer');
    await page.locator('.db-new-item-input').fill('ux-review-notes');
    await page.locator('.db-new-item-add').click();
    await page
      .locator('.db-tree-row', { hasText: 'ux-review-notes' })
      .waitFor({ state: 'visible', timeout: 10_000 });
  });

  await step('empty new document (dark)', async () => {
    await page.locator('.db-tree-row', { hasText: 'ux-review-notes' }).click();
    await page.waitForTimeout(800);
    await shoot(page, 'app-editor-empty-doc-dark', 'Freshly created empty document in the editor');
  });

  await step('tree context menu (dark)', async () => {
    const row = page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' });
    await row.hover();
    await row.locator('.db-tree-more').click();
    await page.locator('.db-tree-context').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'tree-context-menu-dark', 'File context menu (More actions)');
    await dismissOpenLayer(page);
  });

  await step('export menu (dark)', async () => {
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export...' }).waitFor({ timeout: 5_000 });
    await shoot(page, 'export-menu-dark', 'Export and share menu open');
  });

  await step('export dialog (dark)', async () => {
    await page.getByRole('menuitem', { name: 'Export...' }).click();
    await page
      .getByRole('dialog', { name: 'Export Document' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await shoot(page, 'export-dialog-dark', 'Export Document dialog with format choices');
    await dismissOpenLayer(page);
  });

  await step('export video dialog (dark)', async () => {
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export video...' }).click();
    await page
      .locator('[data-squisq-video-export-modal]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await shoot(page, 'export-video-dialog-dark', 'Export Video dialog');
    await dismissOpenLayer(page);
  });

  await step('source view (dark)', async () => {
    await page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).click();
    await page.waitForTimeout(600);
    await page.locator('[role="tab"][data-view="raw"]').click();
    await page.locator('[data-testid="raw-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
    await shoot(page, 'editor-source-view-dark', 'Source (raw Markdown) view with Monaco');
    await page.locator('[role="tab"][data-view="wysiwyg"]').click();
  });

  await step('sidebar collapsed (dark)', async () => {
    const resizer = page.getByRole('separator', { name: 'Resize sidebar' });
    const box = await resizer.boundingBox();
    if (!box) throw new Error('sidebar resizer not found');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(100, box.y + box.height / 2);
    await page.mouse.up();
    await shoot(
      page,
      'sidebar-collapsed-dark',
      'Sidebar dragged closed; Show file list affordance',
    );
    await page.getByRole('button', { name: /Show file list|Back to files/ }).click();
    await shoot(page, 'sidebar-reopened-dark', 'State after clicking Show file list');
  });

  await step('shared document flow (dark)', async () => {
    const archive = await createSharedDocumentArchive(
      '# Q3 launch checklist\n\nA document shared with you via a DocBlocks link.\n\n- [ ] Review copy\n- [ ] Confirm pricing table\n',
      'q3-launch-checklist.md',
    );
    const sharedUrl = buildSharedDocumentUrl(page.url(), archive, null);
    await page.evaluate((url) => {
      window.history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, sharedUrl);
    await page
      .locator('.db-workspace-picker-label', { hasText: 'Shared document' })
      .waitFor({ state: 'visible', timeout: 15_000 });
    await shoot(
      page,
      'shared-doc-received-dark',
      'Opening a shared-document link (temp workspace)',
    );
    await page.getByRole('button', { name: 'Move this into a workspace' }).click();
    await page
      .getByRole('form', { name: 'Move this into a workspace' })
      .waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'shared-doc-move-form-dark', 'Move shared document into a workspace form');
    await dismissOpenLayer(page);
  });

  await step('new workspace creation (dark)', async () => {
    // Runs last within the doc-dependent steps: "New Workspace" creates and
    // switches to an auto-named workspace immediately, abandoning the
    // welcome document.
    await page.locator('.db-workspace-picker-btn').click();
    await page
      .locator('.db-workspace-dropdown')
      .getByRole('button', { name: 'New Workspace' })
      .click();
    await shoot(page, 'workspace-new-result-dark', 'What appears after clicking New Workspace');
  });

  await step('rename workspace flow (dark)', async () => {
    await page.locator('.db-ws-settings-btn').click();
    await page.locator('.db-ws-settings-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('menuitem', { name: 'Rename workspace' }).click();
    await page.waitForTimeout(400);
    await shoot(page, 'workspace-rename-flow-dark', 'Rename workspace flow');
    await dismissOpenLayer(page);
  });

  await step('remove workspace flow (dark)', async () => {
    await page.locator('.db-ws-settings-btn').click();
    await page.locator('.db-ws-settings-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('menuitem', { name: 'Remove workspace' }).click();
    await page.waitForTimeout(500);
    await shoot(page, 'workspace-remove-flow-dark', 'Remove workspace flow (confirmation?)');
    await dismissOpenLayer(page);
  });

  await step('accent switch to purple (dark)', async () => {
    await page.evaluate(() => {
      window.localStorage.setItem('docblocks:accentColor', 'purple');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.db-shell').waitFor({ state: 'visible', timeout: READY_TIMEOUT });
    await page.waitForTimeout(1_500);
    await shoot(page, 'app-accent-purple-dark', 'Shell with the purple accent palette');
  });

  await context.close();
}

async function crawlAppDesktopLight(browser: Browser): Promise<void> {
  currentPhase = 'app-desktop-light';
  say('Phase: app desktop light');
  const { context, page } = await newAppContext(browser, {
    theme: 'light',
    viewport: { width: 1440, height: 900 },
  });

  await step('first load + gateway (light)', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await page
      .locator('.db-welcome-gateway')
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => undefined);
    await shoot(page, 'app-first-run-gateway-light', 'First visit in light theme');
  });

  await step('editor (light)', async () => {
    await page.locator('.db-welcome-gateway-cta').click();
    await page
      .locator('[contenteditable="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    await shoot(page, 'app-editor-welcome-light', 'Welcome document editing, light theme');
  });

  await step('app menu (light)', async () => {
    await page.locator('.db-app-menu-btn').click();
    await page.locator('.db-app-menu-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'app-menu-open-light', 'App menu dropdown, light theme');
  });

  await step('settings dialog (light)', async () => {
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page
      .getByRole('dialog', { name: 'Settings' })
      .waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'settings-dialog-light', 'Settings dialog, light theme');
    await dismissOpenLayer(page);
  });

  await step('workspace dropdown (light)', async () => {
    await page.locator('.db-workspace-picker-btn').click();
    await page.locator('.db-workspace-dropdown').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'workspace-dropdown-light', 'Workspace dropdown, light theme');
    await dismissOpenLayer(page);
  });

  await step('export dialog (light)', async () => {
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export...' }).click();
    await page
      .getByRole('dialog', { name: 'Export Document' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await shoot(page, 'export-dialog-light', 'Export Document dialog, light theme');
    await dismissOpenLayer(page);
  });

  await step('tree context menu (light)', async () => {
    const row = page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' });
    await row.hover();
    await row.locator('.db-tree-more').click();
    await page.locator('.db-tree-context').waitFor({ state: 'visible', timeout: 5_000 });
    await shoot(page, 'tree-context-menu-light', 'File context menu, light theme');
    await dismissOpenLayer(page);
  });

  await context.close();
}

async function crawlAppMobile(browser: Browser, theme: 'light' | 'dark'): Promise<void> {
  currentPhase = `app-mobile-${theme}`;
  say(`Phase: app mobile ${theme}`);
  const { context, page } = await newAppContext(browser, {
    theme,
    viewport: { width: 390, height: 844 },
    mobile: true,
  });

  await step(`mobile first load (${theme})`, async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.db-shell').waitFor({ state: 'visible', timeout: READY_TIMEOUT });
    await page.waitForTimeout(2_500);
    await shoot(page, `mobile-first-run-${theme}`, `Mobile 390px first visit, ${theme} theme`);
  });

  await step(`mobile editor (${theme})`, async () => {
    // Mobile first-run intentionally stays in the file pane and explains
    // the product there. Follow the pane-local tour CTA; retain the row tap
    // fallback so the crawl can still audit restored/pre-migration profiles.
    const tour = page.getByRole('button', { name: 'Tour the welcome document' });
    if (await tour.isVisible().catch(() => false)) {
      await tour.tap();
    } else {
      await page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).tap();
    }
    await page.waitForTimeout(1_500);
    await shoot(
      page,
      `mobile-doc-opened-${theme}`,
      `Mobile welcome document after leaving the file-pane first run, ${theme}`,
    );
    const writeTab = page.getByRole('tab', { name: 'Write' });
    await writeTab.waitFor({ state: 'visible', timeout: 20_000 });
    await writeTab.click();
    await page
      .locator('[contenteditable="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    await shoot(page, `mobile-editor-${theme}`, `Mobile editor after opening Write, ${theme}`);
  });

  if (theme === 'dark') {
    await step('mobile file list (dark)', async () => {
      const showFiles = page.getByRole('button', { name: 'Show file list' });
      await showFiles.waitFor({ state: 'visible', timeout: 5_000 });
      await showFiles.click();
      await shoot(page, 'mobile-file-list-dark', 'Mobile file list open');
      await page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).tap();
      await page
        .getByRole('button', { name: 'Export and share' })
        .waitFor({ state: 'visible', timeout: 20_000 });
    });

    await step('mobile export menu (dark)', async () => {
      await page.getByRole('button', { name: 'Export and share' }).click();
      await page.getByRole('menuitem', { name: 'Export...' }).waitFor({ timeout: 5_000 });
      await shoot(page, 'mobile-export-menu-dark', 'Mobile export menu');
      await dismissOpenLayer(page);
    });

    await step('mobile settings (dark)', async () => {
      const menuButton = page.locator('.db-app-menu-btn');
      if (!(await menuButton.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Show file list' }).click();
      }
      await menuButton.click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
      await page
        .getByRole('dialog', { name: 'Settings' })
        .waitFor({ state: 'visible', timeout: 5_000 });
      await shoot(page, 'mobile-settings-dialog-dark', 'Mobile settings dialog');
      await dismissOpenLayer(page);
    });
  }

  await context.close();
}

async function crawlSeoBootstrap(browser: Browser, theme: 'light' | 'dark'): Promise<void> {
  currentPhase = `seo-bootstrap-${theme}`;
  say(`Phase: SEO bootstrap shell ${theme}`);
  const { context, page } = await newAppContext(browser, {
    theme,
    viewport: { width: 1440, height: 900 },
  });
  await context.route('**/assets/*.js', (route) => route.abort());

  await step(`seo bootstrap (${theme})`, async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    await shoot(
      page,
      `landing-seo-bootstrap-${theme}`,
      'Static pre-React app shell (what crawlers and slow connections see)',
      { fullPage: true },
    );
  });

  await context.close();
}

async function crawlMarketingPages(browser: Browser): Promise<void> {
  currentPhase = 'marketing-desktop';
  say('Phase: marketing pages (desktop)');
  const routes: Array<{ slug: string; name: string }> = [
    { slug: '/desktop/', name: 'desktop' },
    { slug: '/vscode/', name: 'vscode' },
    { slug: '/cli/', name: 'cli' },
    { slug: '/formats/', name: 'formats' },
    { slug: '/docs/', name: 'docs' },
    { slug: '/privacy/', name: 'privacy' },
    { slug: '/terms/', name: 'terms' },
  ];

  const { context, page } = await newAppContext(browser, {
    theme: 'light',
    viewport: { width: 1440, height: 900 },
  });

  for (const route of routes) {
    await step(`marketing ${route.name} (light)`, async () => {
      await page.goto(`${BASE_URL}${route.slug}`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await shoot(page, `page-${route.name}-light`, `${route.slug} full page, light`, {
        fullPage: true,
      });
    });
  }

  await step('404 page (light)', async () => {
    await page.goto(`${BASE_URL}/this-page-does-not-exist-xyz/`, { waitUntil: 'load' });
    await shoot(page, 'page-404-light', 'Not-found page', { fullPage: true });
  });

  await context.close();

  const dark = await newAppContext(browser, {
    theme: 'dark',
    viewport: { width: 1440, height: 900 },
  });
  for (const route of routes.slice(0, 2).concat(routes.filter((r) => r.name === 'docs'))) {
    await step(`marketing ${route.name} (dark)`, async () => {
      await dark.page.goto(`${BASE_URL}${route.slug}`, { waitUntil: 'load' });
      await dark.page.evaluate(() => document.fonts.ready.then(() => undefined));
      await shoot(dark.page, `page-${route.name}-dark`, `${route.slug} full page, dark`, {
        fullPage: true,
      });
    });
  }
  await dark.context.close();

  currentPhase = 'marketing-mobile';
  say('Phase: marketing pages (mobile)');
  const mobile = await newAppContext(browser, {
    theme: 'light',
    viewport: { width: 390, height: 844 },
    mobile: true,
  });
  for (const route of routes) {
    await step(`marketing ${route.name} (mobile)`, async () => {
      await mobile.page.goto(`${BASE_URL}${route.slug}`, { waitUntil: 'load' });
      await mobile.page.evaluate(() => document.fonts.ready.then(() => undefined));
      await shoot(mobile.page, `mobile-page-${route.name}`, `${route.slug} full page, mobile`, {
        fullPage: true,
      });
    });
  }
  await mobile.context.close();
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  say(`Crawling ${BASE_URL} -> ${OUT_DIR}`);
  const browser = await chromium.launch();

  if (phaseEnabled('app-desktop-dark')) await crawlAppDesktopDark(browser);
  if (phaseEnabled('app-desktop-light')) await crawlAppDesktopLight(browser);
  if (phaseEnabled('app-mobile-dark')) await crawlAppMobile(browser, 'dark');
  if (phaseEnabled('app-mobile-light')) await crawlAppMobile(browser, 'light');
  if (phaseEnabled('seo-bootstrap')) {
    await crawlSeoBootstrap(browser, 'dark');
    await crawlSeoBootstrap(browser, 'light');
  }
  if (phaseEnabled('marketing')) await crawlMarketingPages(browser);

  await browser.close();

  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(OUT_DIR, 'health.json'), JSON.stringify(health, null, 2));
  say(
    `Done: ${manifest.shots.length} screenshots, ${manifest.skipped.length} skipped steps, ` +
      `${health.consoleIssues.length} console issues, ${health.requestIssues.length} request issues.`,
  );
  say(`Manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
