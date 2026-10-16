/**
 * Affordance crawl — clicks every visible control in each major view of the
 * site shell, opens every menu it finds, activates every item in those menus,
 * and records what each action produced: a screenshot, the dialogs or menus
 * that appeared, downloads, file pickers, popups, native alert/confirm
 * prompts, URL changes, and console errors raised by that action alone.
 *
 * It complements the two existing evidence drivers rather than replacing them:
 * `live-ux-crawl.ts` captures a curated screenshot inventory and
 * `site-ship-review.ts` asserts the critical flows. This one exists to find the
 * controls nobody scripted — the toolbar icon that throws, the menu item that
 * does nothing, the dialog with no way out.
 *
 *   npm run ux:crawl -- --affordances               # build, preview, crawl
 *   npm run ux:crawl -- --affordances --no-build    # reuse packages/site/dist
 *
 * Or against an already-serving origin (PowerShell):
 *   $env:LIVE_UX_BASE_URL='http://localhost:5220'
 *   npx tsx e2e/site-affordance-crawl.ts reports/affordances
 *
 * Optional AFFORDANCE_SURFACES=desktop-slideshow,desktop-write,... and
 * AFFORDANCE_SCENARIOS=slides,caret,shortcuts,links (both default to all).
 *
 * Output: NNN-*.png, actions.json, and index.html — a contact sheet that puts
 * every screenshot beside the action that produced it. Like the other drivers
 * this is an audit, not a gate: a "no visible effect" row is a prompt to look,
 * not proof of a bug.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = (process.env.LIVE_UX_BASE_URL ?? 'http://127.0.0.1:5240').replace(/\/$/, '');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve(process.argv[2] ?? `reports/affordances-${STAMP}`);
const READY_TIMEOUT = 90_000;
const SETTLE_MS = 700;
/** Upper bound on items opened from one menu, so a long list cannot stall the run. */
const MAX_MENU_ITEMS = 30;

function listFilter(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
const SURFACE_FILTER = listFilter('AFFORDANCE_SURFACES');
const SCENARIO_FILTER = listFilter('AFFORDANCE_SCENARIOS');
/**
 * Record the editor document's outline after every action, so a crawl that
 * ends in a corrupted document also says which action corrupted it.
 */
const DOC_TRACE = process.env.AFFORDANCE_DOC_TRACE === '1';

/**
 * One line per top-level node with its direct children, read from Tiptap's
 * editor instance on the WYSIWYG surface. A string, not a function: tsx
 * injects a helper into named inner functions that the page doesn't have.
 */
const DOC_OUTLINE_SCRIPT = `(() => {
  const view = document.querySelector('.ProseMirror');
  const editor = view && view.editor;
  if (!editor) return null;
  const lines = [];
  editor.state.doc.forEach((node) => {
    const kids = [];
    node.forEach((child) => kids.push(child.type.name));
    const text = node.textContent.replace(/\\s+/g, ' ').slice(0, 40);
    lines.push(node.type.name + (kids.length ? '[' + kids.join(',') + ']' : '') + ' ' + JSON.stringify(text));
  });
  return lines;
})()`;

/** Overlays an action can open; their appearance is what a click is judged by. */
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.db-tree-context',
  '.db-ws-settings-dropdown',
  '.db-workspace-dropdown',
  '.db-app-menu-dropdown',
  '[data-squisq-video-export-modal]',
].join(', ');

/** Menu entries that destroy state are opened in a throwaway context. */
const DESTRUCTIVE = /\b(delete|remove|discard|reset|clear|erase)\b/i;

/** Controls that would navigate the crawl away from the app or end it. */
const SKIP_CONTROL = /^(Report issue|Docs|Terms|Privacy)$/i;

interface ActionEvents {
  console: string[];
  pageErrors: string[];
  downloads: string[];
  fileChoosers: number;
  popups: string[];
  nativeDialogs: string[];
}

interface ActionRecord {
  id: number;
  surface: string;
  path: string[];
  screenshot: string | null;
  urlBefore: string;
  urlAfter: string;
  opened: Array<{ role: string; label: string }>;
  menuItems?: string[];
  title?: string | null;
  disabled?: boolean;
  events: ActionEvents;
  verdict:
    | 'opened-overlay'
    | 'navigated'
    | 'side-effect'
    | 'changed-view'
    | 'no-visible-effect'
    | 'error';
  error?: string;
  ms: number;
  /** Document outline after the action (AFFORDANCE_DOC_TRACE=1). */
  docAfter?: string[] | null;
}

interface ScenarioRecord {
  name: string;
  status: 'completed' | 'failed';
  detail?: unknown;
  error?: string;
  screenshots: string[];
}

interface Surface {
  name: string;
  viewport: { width: number; height: number };
  mobile?: boolean;
  theme?: 'light' | 'dark';
  /** Bring a freshly loaded page to the state this surface audits. */
  prepare(page: Page): Promise<void>;
  /** Containers whose controls are crawled. */
  roots: string[];
}

const actions: ActionRecord[] = [];
const scenarios: ScenarioRecord[] = [];
let shotCounter = 0;
let current: ActionEvents = emptyEvents();

function emptyEvents(): ActionEvents {
  return {
    console: [],
    pageErrors: [],
    downloads: [],
    fileChoosers: 0,
    popups: [],
    nativeDialogs: [],
  };
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

async function persist(): Promise<void> {
  await writeFile(
    path.join(OUT_DIR, 'actions.json'),
    JSON.stringify(
      { baseUrl: BASE_URL, recordedAt: new Date().toISOString(), actions, scenarios },
      null,
      2,
    ),
  );
}

/** Park the pointer over the status bar so hover styling never reads as a change. */
async function parkPointer(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width / 2, viewport.height - 3);
}

async function pixels(page: Page): Promise<Buffer> {
  await parkPointer(page);
  return page.screenshot({ animations: 'disabled', caret: 'hide' });
}

async function shoot(page: Page, name: string, fullPage = false): Promise<string> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(3, '0')}-${slug(name)}.png`;
  await page.screenshot({
    path: path.join(OUT_DIR, file),
    fullPage,
    animations: 'disabled',
    caret: 'hide',
  });
  return file;
}

function wire(context: BrowserContext, page: Page): void {
  page.setDefaultTimeout(8_000);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      current.console.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (error) => current.pageErrors.push(error.message.slice(0, 300)));
  page.on('download', (download) => current.downloads.push(download.suggestedFilename()));
  page.on('filechooser', () => {
    current.fileChoosers += 1;
  });
  page.on('dialog', (dialog) => {
    current.nativeDialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 200)}`);
    void dialog.dismiss().catch(() => undefined);
  });
  context.on('page', (popup) => {
    current.popups.push(popup.url());
    void popup.close().catch(() => undefined);
  });
}

async function waitForShell(page: Page): Promise<void> {
  await page.locator('.db-shell').waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  // Not the status bar alone: "View options › Show status bar" hides it, and
  // that preference persists across the reloads this crawl performs.
  await page
    .locator('.squisq-status-item')
    .or(page.getByRole('toolbar', { name: 'Formatting toolbar' }))
    .or(page.getByRole('button', { name: 'Tour the welcome document' }))
    .first()
    .waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function openContext(
  browser: Browser,
  surface: Pick<Surface, 'viewport' | 'mobile' | 'theme'>,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: surface.viewport,
    colorScheme: surface.theme ?? 'light',
    isMobile: surface.mobile ?? false,
    hasTouch: surface.mobile ?? false,
    deviceScaleFactor: 1,
    acceptDownloads: true,
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  wire(context, page);
  return { context, page };
}

async function visibleOverlays(page: Page): Promise<Array<{ role: string; label: string }>> {
  return page.locator(OVERLAY_SELECTOR).evaluateAll((elements) =>
    elements
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
      })
      .map((element) => ({
        role: element.getAttribute('role') ?? element.className.toString().split(' ')[0],
        label:
          element.getAttribute('aria-label') ??
          (element.getAttribute('aria-labelledby')
            ? (document.getElementById(element.getAttribute('aria-labelledby') ?? '')
                ?.textContent ?? '')
            : (element.textContent ?? '').trim().slice(0, 60)),
      })),
  );
}

/**
 * Stamp every visible, enabled control under the given roots with a stable
 * `data-affordance` key (role|label|occurrence) and return the keys in DOM
 * order. Re-running after a reload re-stamps the same keys, which is how a
 * control is found again without holding a stale element handle.
 */
async function stampControls(
  page: Page,
  roots: string[],
  attribute: string,
): Promise<Array<{ key: string; label: string; title: string | null; disabled: boolean }>> {
  return page.evaluate(
    ({ roots, attribute }) => {
      const seen = new Map<string, number>();
      const results: Array<{
        key: string;
        label: string;
        title: string | null;
        disabled: boolean;
      }> = [];
      const selector =
        'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="checkbox"], [role="switch"], a[href], select, summary';
      for (const root of roots) {
        for (const container of Array.from(document.querySelectorAll(root))) {
          for (const element of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
            if (element.closest('.ProseMirror, .monaco-editor')) continue;
            const box = element.getBoundingClientRect();
            if (box.width < 2 || box.height < 2) continue;
            const style = getComputedStyle(element);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
            const label = (
              element.getAttribute('aria-label') ??
              element.getAttribute('title') ??
              element.innerText ??
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80);
            if (!label) continue;
            const base = `${role}|${label}`;
            const occurrence = seen.get(base) ?? 0;
            seen.set(base, occurrence + 1);
            const key = `${base}|${occurrence}`;
            element.setAttribute(attribute, key);
            if (!results.some((entry) => entry.key === key)) {
              results.push({
                key,
                label,
                title: element.getAttribute('title'),
                disabled:
                  (element as HTMLButtonElement).disabled ||
                  element.getAttribute('aria-disabled') === 'true',
              });
            }
          }
        }
      }
      return results;
    },
    { roots, attribute },
  );
}

function stamped(page: Page, attribute: string, key: string): Locator {
  return page.locator(`[${attribute}="${key.replace(/"/g, '\\"')}"]`).first();
}

async function dismiss(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await visibleOverlays(page)).length === 0) return true;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  for (const name of ['Close', 'Cancel', 'Close dialog', 'Close export dialog', 'Done']) {
    const button = page
      .locator(OVERLAY_SELECTOR)
      .getByRole('button', { name, exact: true })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
  return (await visibleOverlays(page)).length === 0;
}

function verdictFor(
  before: { url: string },
  after: { url: string; opened: Array<{ role: string; label: string }>; changed: boolean },
  events: ActionEvents,
): ActionRecord['verdict'] {
  if (events.pageErrors.length > 0) return 'error';
  if (after.opened.length > 0) return 'opened-overlay';
  if (after.url !== before.url) return 'navigated';
  if (
    events.downloads.length > 0 ||
    events.fileChoosers > 0 ||
    events.popups.length > 0 ||
    events.nativeDialogs.length > 0
  ) {
    return 'side-effect';
  }
  return after.changed ? 'changed-view' : 'no-visible-effect';
}

/**
 * Perform one action and record everything it caused. `act` does the
 * clicking; the screenshot is taken after the UI settles so it shows what a
 * person would see.
 */
async function record(
  page: Page,
  surface: string,
  actionPath: string[],
  act: () => Promise<void>,
  meta: { title?: string | null; disabled?: boolean } = {},
): Promise<ActionRecord> {
  current = emptyEvents();
  const started = Date.now();
  const urlBefore = page.url();
  const entry: ActionRecord = {
    id: actions.length + 1,
    surface,
    path: actionPath,
    screenshot: null,
    urlBefore,
    urlAfter: urlBefore,
    opened: [],
    events: current,
    verdict: 'no-visible-effect',
    ms: 0,
    ...meta,
  };
  try {
    // Pixel-identical before/after screens are the strongest available
    // signal of a control that does nothing; compare them, not the DOM.
    const before = await pixels(page);
    await act();
    await page.waitForTimeout(SETTLE_MS);
    const after = await pixels(page);
    entry.urlAfter = page.url();
    entry.opened = await visibleOverlays(page);
    entry.screenshot = `${String(++shotCounter).padStart(3, '0')}-${slug(`${surface}-${actionPath.join('-')}`)}.png`;
    await writeFile(path.join(OUT_DIR, entry.screenshot), after);
    entry.verdict = verdictFor(
      { url: urlBefore },
      { url: entry.urlAfter, opened: entry.opened, changed: !before.equals(after) },
      current,
    );
  } catch (error) {
    entry.verdict = 'error';
    entry.error = String(error).split('\n')[0].slice(0, 300);
    entry.screenshot = await shoot(page, `${surface}-${actionPath.join('-')}-error`).catch(
      () => null,
    );
  }
  entry.ms = Date.now() - started;
  if (DOC_TRACE) {
    entry.docAfter = (await page.evaluate(DOC_OUTLINE_SCRIPT).catch(() => null)) as string[] | null;
  }
  entry.events = current;
  actions.push(entry);
  say(`  [${entry.verdict}] ${surface} › ${actionPath.join(' › ')}`);
  await persist();
  return entry;
}

async function menuItemLabels(page: Page): Promise<string[]> {
  return page
    .locator(
      `:is(${OVERLAY_SELECTOR}) :is([role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"])`,
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) =>
          (element.getAttribute('aria-label') ?? (element as HTMLElement).innerText ?? '')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    );
}

/**
 * Click the menu item at `index` among the visible items. Items are addressed
 * by position because an item's text often joins a title and a description
 * that no single text match reproduces.
 */
async function clickMenuItem(page: Page, index: number): Promise<void> {
  const items = page.locator(
    `:is(${OVERLAY_SELECTOR}) :is([role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"])`,
  );
  const visible: Locator[] = [];
  for (const item of await items.all()) {
    if (await item.isVisible().catch(() => false)) visible.push(item);
  }
  const target = visible[index];
  if (!target) throw new Error(`menu item ${index} is not visible`);
  await target.click({ timeout: 5_000 });
}

async function crawlSurface(browser: Browser, surface: Surface): Promise<void> {
  say(`Surface: ${surface.name}`);
  const attribute = 'data-affordance';
  let { context, page } = await openContext(browser, surface);

  let homeUrl = '';
  const reset = async (fresh = false): Promise<void> => {
    if (fresh) {
      await context.close();
      ({ context, page } = await openContext(browser, surface));
    }
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForShell(page);
    await surface.prepare(page);
    await page.waitForTimeout(SETTLE_MS);
    homeUrl = page.url();
  };

  await reset();
  const baseline = await shoot(page, `${surface.name}-baseline`);
  actions.push({
    id: actions.length + 1,
    surface: surface.name,
    path: ['(baseline)'],
    screenshot: baseline,
    urlBefore: page.url(),
    urlAfter: page.url(),
    opened: [],
    events: emptyEvents(),
    verdict: 'no-visible-effect',
    ms: 0,
  });
  const controls = await stampControls(page, surface.roots, attribute);
  say(`  ${controls.length} controls`);
  await writeFile(
    path.join(OUT_DIR, `${surface.name}.controls.json`),
    JSON.stringify(controls, null, 2),
  );

  for (const control of controls) {
    if (SKIP_CONTROL.test(control.label)) continue;
    if (control.key.startsWith('a|')) continue; // links are checked by the links scenario
    if (control.disabled) {
      actions.push({
        id: actions.length + 1,
        surface: surface.name,
        path: [control.label],
        screenshot: null,
        urlBefore: page.url(),
        urlAfter: page.url(),
        opened: [],
        title: control.title,
        disabled: true,
        events: emptyEvents(),
        verdict: 'no-visible-effect',
        ms: 0,
      });
      continue;
    }
    // Every control starts from the surface's own state.
    if (!(await dismiss(page)) || page.url() !== homeUrl) {
      await reset();
    }
    await stampControls(page, surface.roots, attribute);
    const target = stamped(page, attribute, control.key);
    if (!(await target.isVisible().catch(() => false))) {
      await reset();
      await stampControls(page, surface.roots, attribute);
    }
    const result = await record(
      page,
      surface.name,
      [control.label],
      async () => {
        await stamped(page, attribute, control.key).click({ timeout: 5_000 });
      },
      { title: control.title },
    );
    if (result.verdict === 'changed-view' || result.verdict === 'navigated') {
      await reset();
      continue;
    }
    if (result.verdict !== 'opened-overlay') continue;
    const items = await menuItemLabels(page);
    if (items.length === 0) continue;
    result.menuItems = items;
    await persist();
    const indexed = items.map((label, index) => ({ label, index }));
    const ordered = [
      ...indexed.filter((item) => !DESTRUCTIVE.test(item.label)),
      ...indexed.filter((item) => DESTRUCTIVE.test(item.label)),
    ].slice(0, MAX_MENU_ITEMS);
    for (const { label: item, index } of ordered) {
      const destructive = DESTRUCTIVE.test(item);
      if (destructive) await reset(true);
      else if (!(await dismiss(page)) || page.url() !== homeUrl) await reset();
      await stampControls(page, surface.roots, attribute);
      const itemResult = await record(page, surface.name, [control.label, item], async () => {
        await stamped(page, attribute, control.key).click({ timeout: 5_000 });
        await page.waitForTimeout(300);
        await clickMenuItem(page, index);
      });
      // An item that changed the view (an inline rename box, a different
      // mode) would otherwise hide the opener from the next item.
      if (destructive) await reset(true);
      else if (itemResult.verdict === 'changed-view') await reset();
    }
    await reset();
  }
  await context.close();
}

async function startWriting(page: Page): Promise<void> {
  const cta = page.locator('.db-welcome-gateway-cta');
  if (await cta.isVisible().catch(() => false)) await cta.click();
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
  await page.locator('.ProseMirror').first().waitFor({ state: 'visible', timeout: 30_000 });
}

const DESKTOP_ROOTS = [
  'aside, [role="complementary"]',
  '[role="toolbar"]',
  '.squisq-status-bar, .db-shell-statusbar, footer',
  '[role="note"]',
  '[role="region"][aria-label="Document player"]',
];

const SURFACES: Surface[] = [
  {
    name: 'desktop-slideshow',
    viewport: { width: 1440, height: 900 },
    prepare: async () => undefined,
    roots: DESKTOP_ROOTS,
  },
  {
    name: 'desktop-write',
    viewport: { width: 1440, height: 900 },
    prepare: startWriting,
    roots: DESKTOP_ROOTS,
  },
  {
    name: 'desktop-source',
    viewport: { width: 1440, height: 900 },
    prepare: async (page) => {
      await startWriting(page);
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.locator('.monaco-editor').first().waitFor({ state: 'visible', timeout: 30_000 });
    },
    roots: ['[role="toolbar"]'],
  },
  {
    name: 'phone-write',
    viewport: { width: 390, height: 844 },
    mobile: true,
    prepare: async (page) => {
      const tour = page.getByRole('button', { name: 'Tour the welcome document' });
      if (await tour.isVisible().catch(() => false)) await tour.click();
      await page.getByRole('tab', { name: 'Write', exact: true }).click();
      await page.locator('.ProseMirror').first().waitFor({ state: 'visible', timeout: 30_000 });
    },
    roots: ['[role="toolbar"]', '.squisq-status-bar, footer', 'header'],
  },
  {
    name: 'phone-files',
    viewport: { width: 390, height: 844 },
    mobile: true,
    prepare: async () => undefined,
    roots: ['aside, [role="complementary"]'],
  },
];

// ---------------------------------------------------------------------------
// Scenarios: flows a click-everything crawl cannot reach on its own.
// ---------------------------------------------------------------------------

async function scenario(name: string, run: (shots: string[]) => Promise<unknown>): Promise<void> {
  const shots: string[] = [];
  say(`Scenario: ${name}`);
  try {
    const detail = await run(shots);
    scenarios.push({ name, status: 'completed', detail, screenshots: shots });
  } catch (error) {
    scenarios.push({
      name,
      status: 'failed',
      error: String(error).split('\n')[0].slice(0, 400),
      screenshots: shots,
    });
    say(`  ! ${name}: ${String(error).split('\n')[0]}`);
  }
  await persist();
}

/** Walk every slide of the welcome deck — the first thing a visitor sees. */
async function slidesScenario(browser: Browser): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await scenario(`welcome-slides-${theme}`, async (shots) => {
      const { context, page } = await openContext(browser, {
        viewport: { width: 1440, height: 900 },
        theme,
      });
      try {
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await waitForShell(page);
        const dismissTip = page.getByRole('button', { name: 'Dismiss welcome tip' });
        if (await dismissTip.isVisible().catch(() => false)) await dismissTip.click();
        const counter = page.getByRole('button', { name: /Choose slide, current/ });
        const total = Number((await counter.innerText()).split('/')[1]?.trim() ?? '0');
        const next = page.getByRole('button', { name: 'Next slide' });
        for (let index = 1; index <= total; index++) {
          // Slide bodies reveal in a staggered fade that takes ~2.5s.
          await page.waitForTimeout(3_000);
          shots.push(await shoot(page, `slide-${theme}-${String(index).padStart(2, '0')}`));
          if (index < total) await next.click();
        }
        return { total };
      } finally {
        await context.close();
      }
    });
  }
}

/**
 * Text typed immediately after creating a document must land where the
 * person expects. Repeated because the failure this guards is a race.
 */
async function caretScenario(browser: Browser): Promise<void> {
  for (const profile of [
    { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
    { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
  ]) {
    await scenario(`caret-after-create-${profile.name}`, async (shots) => {
      const outcomes: Array<{
        attempt: number;
        markdown: string;
        ok: boolean;
        selection: Array<{ step: string; node: string; offset: number; text: string }>;
      }> = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        const { context, page } = await openContext(browser, profile);
        try {
          await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
          await waitForShell(page);
          const name = `caret-${attempt}`;
          if (profile.mobile) {
            await page.getByRole('button', { name: 'Create a document', exact: true }).click();
            await page.getByRole('textbox', { name: 'Document name', exact: true }).fill(name);
            await page.getByRole('button', { name: 'Create', exact: true }).click();
          } else {
            const cta = page.locator('.db-welcome-gateway-cta');
            if (await cta.isVisible().catch(() => false)) await cta.click();
            await page.getByRole('button', { name: 'New File', exact: true }).click();
            await page.getByRole('textbox', { name: 'New file name' }).fill(`${name}.md`);
            await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
          }
          await page.getByRole('tab', { name: 'Write', exact: true }).click();
          const editor = page.locator('.ProseMirror').first();
          await editor.waitFor({ state: 'visible' });
          // What a person does: tap/click at the end of the existing text, then type.
          const box = await editor.boundingBox();
          if (!box) throw new Error('editor has no box');
          const selection: Array<{ step: string; node: string; offset: number; text: string }> = [];
          const where = async (step: string): Promise<void> => {
            selection.push({
              step,
              ...(await page.evaluate(() => {
                const current = window.getSelection();
                const anchor = current?.anchorNode;
                return {
                  node: anchor?.parentElement?.tagName ?? anchor?.nodeName ?? 'none',
                  offset: current?.anchorOffset ?? -1,
                  text: (anchor?.textContent ?? '').slice(0, 40),
                };
              })),
            });
          };
          await where('before-click');
          await page.mouse.click(box.x + box.width - 8, box.y + 24);
          await where('after-click');
          await page.waitForTimeout(600);
          await where('after-600ms');
          await page.keyboard.press('End');
          await where('after-End');
          await page.keyboard.press('Enter');
          await page.keyboard.type('Typed straight after creating the document.', { delay: 15 });
          await page.waitForTimeout(800);
          await page.getByRole('tab', { name: 'Source', exact: true }).click();
          await page.locator('.monaco-editor').first().waitFor({ state: 'visible' });
          // Monaco renders spaces as NBSP; normalise before comparing.
          const markdown = (
            await page.locator('.monaco-editor .view-lines').first().innerText()
          ).replace(/\u00a0/g, ' ');
          const ok =
            markdown.includes('Typed straight after creating the document.') &&
            !/caret-\d[^\n]*Typed/.test(markdown);
          outcomes.push({ attempt, markdown: markdown.slice(0, 300), ok, selection });
          if (!ok || attempt === 1)
            shots.push(await shoot(page, `caret-${profile.name}-${attempt}`));
        } finally {
          await context.close();
        }
      }
      return outcomes;
    });
  }
}

/** Keyboard shortcuts the shell advertises. */
async function shortcutsScenario(browser: Browser): Promise<void> {
  await scenario('shell-shortcuts', async (shots) => {
    const { context, page } = await openContext(browser, {
      viewport: { width: 1440, height: 900 },
    });
    const results: Array<{
      keys: string;
      opened: Array<{ role: string; label: string }>;
      changed: boolean;
    }> = [];
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForShell(page);
      await startWriting(page);
      for (const keys of [
        'Control+p',
        'Control+f',
        'Control+Shift+f',
        'Control+Shift+e',
        'Control+\\',
        'Control+s',
        'F1',
        'Shift+?',
      ]) {
        await page.locator('.ProseMirror').first().click();
        const before = await pixels(page);
        await page.keyboard.press(keys);
        await page.waitForTimeout(SETTLE_MS);
        const changed = !before.equals(await pixels(page));
        const opened = await visibleOverlays(page);
        results.push({ keys, opened, changed });
        shots.push(await shoot(page, `shortcut-${keys}`));
        await dismiss(page);
        if (keys === 'Control+\\') await page.keyboard.press('Control+\\');
      }
      return results;
    } finally {
      await context.close();
    }
  });
}

/** Every link in the welcome document and shell chrome resolves. */
async function linksScenario(browser: Browser): Promise<void> {
  await scenario('welcome-links', async () => {
    const { context, page } = await openContext(browser, {
      viewport: { width: 1440, height: 900 },
    });
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForShell(page);
      await startWriting(page);
      const anchors = await page.locator('a[href]').evaluateAll((elements) =>
        elements.map((element) => ({
          href: (element as HTMLAnchorElement).href,
          text: (element as HTMLElement).innerText.trim().slice(0, 60),
          inDocument: !!element.closest('.ProseMirror'),
        })),
      );
      const checked: Array<Record<string, unknown>> = [];
      for (const anchor of anchors) {
        if (!/^https?:/.test(anchor.href)) {
          checked.push({ ...anchor, status: 'non-http' });
          continue;
        }
        try {
          const response = await context.request.get(anchor.href, {
            timeout: 20_000,
            maxRedirects: 5,
          });
          checked.push({ ...anchor, status: response.status(), finalUrl: response.url() });
          await response.dispose();
        } catch (error) {
          checked.push({ ...anchor, status: 'error', error: String(error).slice(0, 160) });
        }
      }
      return checked;
    } finally {
      await context.close();
    }
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) =>
    character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : '&quot;',
  );
}

async function writeIndex(): Promise<void> {
  const rows = actions
    .map((action) => {
      const flags = [
        action.events.pageErrors.length ? `pageerror×${action.events.pageErrors.length}` : '',
        action.events.console.filter((line) => line.startsWith('error')).length
          ? `console-error×${action.events.console.filter((line) => line.startsWith('error')).length}`
          : '',
        action.events.downloads.length ? `download: ${action.events.downloads.join(', ')}` : '',
        action.events.fileChoosers ? 'file chooser' : '',
        action.events.popups.length ? `popup: ${action.events.popups.join(', ')}` : '',
        action.events.nativeDialogs.length
          ? `native: ${action.events.nativeDialogs.join(' | ')}`
          : '',
        action.disabled ? 'disabled' : '',
        action.error ?? '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<figure class="${action.verdict}"><figcaption><b>${escapeHtml(action.surface)}</b> › ${escapeHtml(
        action.path.join(' › '),
      )}<br><span class="v">${action.verdict}</span> ${escapeHtml(flags)}${
        action.opened.length
          ? `<br>opened: ${escapeHtml(action.opened.map((o) => `${o.role} “${o.label}”`).join(', '))}`
          : ''
      }</figcaption>${
        action.screenshot
          ? `<a href="${action.screenshot}"><img loading="lazy" src="${action.screenshot}"></a>`
          : ''
      }</figure>`;
    })
    .join('\n');
  const scenarioRows = scenarios
    .map(
      (entry) =>
        `<section><h2>${escapeHtml(entry.name)} — ${entry.status}</h2>${
          entry.error ? `<p>${escapeHtml(entry.error)}</p>` : ''
        }<details><summary>detail</summary><pre>${escapeHtml(
          JSON.stringify(entry.detail ?? null, null, 2),
        )}</pre></details><div class="grid">${entry.screenshots
          .map(
            (shot) =>
              `<a href="${shot}"><img loading="lazy" src="${shot}"><span>${shot}</span></a>`,
          )
          .join('')}</div></section>`,
    )
    .join('\n');
  await writeFile(
    path.join(OUT_DIR, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Affordance crawl</title><style>
body{font:13px system-ui;margin:16px;background:#fafafa}figure{display:inline-block;width:360px;margin:6px;vertical-align:top;background:#fff;border:1px solid #ddd;padding:6px}
figure img,.grid img{width:100%}figure.error{border-color:#c00}figure.no-visible-effect{border-color:#e0a000}.v{font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}.grid a{font-size:11px;color:#555}
</style><h1>Affordance crawl — ${escapeHtml(BASE_URL)}</h1><p>${actions.length} actions, ${
      actions.filter((a) => a.verdict === 'error').length
    } errors, ${actions.filter((a) => a.verdict === 'no-visible-effect').length} with no visible effect.</p>${scenarioRows}<h2>Actions</h2>${rows}`,
  );
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  say(`Affordance crawl of ${BASE_URL} -> ${OUT_DIR}`);
  const browser = await chromium.launch();
  try {
    const wanted = (name: string, filter: string[]): boolean =>
      filter.length === 0 || filter.includes(name);
    if (wanted('slides', SCENARIO_FILTER)) await slidesScenario(browser);
    if (wanted('caret', SCENARIO_FILTER)) await caretScenario(browser);
    if (wanted('shortcuts', SCENARIO_FILTER)) await shortcutsScenario(browser);
    if (wanted('links', SCENARIO_FILTER)) await linksScenario(browser);
    for (const surface of SURFACES) {
      if (!wanted(surface.name, SURFACE_FILTER)) continue;
      try {
        await crawlSurface(browser, surface);
      } catch (error) {
        say(`  ! surface ${surface.name} aborted: ${String(error).split('\n')[0]}`);
      }
    }
  } finally {
    await persist();
    await writeIndex();
    await browser.close();
  }
  const errors = actions.filter((action) => action.verdict === 'error').length;
  say(`Done: ${actions.length} actions (${errors} errors), ${scenarios.length} scenarios.`);
  say(`Contact sheet: ${path.join(OUT_DIR, 'index.html')}`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
