/**
 * New-user journey — writes one realistic document through the toolbar the way
 * a first-time visitor would, then looks at everything that document becomes.
 *
 * The other drivers each answer a narrower question: `live-ux-crawl.ts` is a
 * curated screenshot inventory, `site-affordance-crawl.ts` clicks every control
 * once, and `site-ship-review.ts` asserts critical flows on documents it pastes
 * into Source view. None of them does what a person does: build a document out
 * of the Insert menu, keep typing after each thing they inserted, flip through
 * every way of viewing it, export it, and open the exported files. This does.
 *
 *   npm run ux:crawl -- --journey               # build, preview, run
 *   npm run ux:crawl -- --journey --no-build    # reuse packages/site/dist
 *
 * Or against an already-serving origin (PowerShell):
 *   $env:LIVE_UX_BASE_URL='https://docblocks.com'
 *   npx tsx e2e/site-journey-review.ts reports/journey
 *
 * Optional JOURNEY_PHASES=author,caret,shell,modes,looks,exports,render,import
 * (default all). `render` and `import` reuse the files `exports` saved, so a
 * later run may name them alone to re-render an existing output folder.
 *
 *   author   Create a document from the welcome screen and add every Insert
 *            item under its own heading, at a person's pace.
 *   caret    In a scratch document per Insert item: where typing lands straight
 *            after inserting it at the end of a document, and whether the
 *            keyboard or a click below it reaches a new paragraph under it.
 *   shell    Keyboard shortcuts sheet (menu item, F1, ?), quick open, find,
 *            and the share link, on the authored document.
 *   modes    Every Use mode and Write mode on that document; every slide.
 *   looks    Every document theme and every transform, first slides.
 *   exports  Every Export format with the dialog's defaults, then video.
 *   render   Exports rendered to PNG for review: PDF pages through pdf.js;
 *            Word and PowerPoint through LibreOffice when it is installed;
 *            HTML and EPUB in the browser; MP4 as a frame tile through FFmpeg.
 *   import   Drops the exported files back onto the file pane of a fresh
 *            profile, the only import path the web app has.
 *
 * Output: NNN-*.png, journey.json (steps, findings, health), authored.md,
 * downloads/, rendered/ and index.html, a contact sheet. Like the other
 * drivers this is an audit, not a gate: read the findings and look at the
 * screenshots before reaching a verdict.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const BASE_URL = (process.env.LIVE_UX_BASE_URL ?? 'http://127.0.0.1:5240').replace(/\/$/, '');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve(process.argv[2] ?? `reports/journey-${STAMP}`);
const DOWNLOADS = path.join(OUT_DIR, 'downloads');
const RENDERED = path.join(OUT_DIR, 'rendered');
const FIXTURES = path.join(OUT_DIR, 'fixtures');
const SUPPORTED_PHASES = [
  'author',
  'caret',
  'shell',
  'modes',
  'looks',
  'exports',
  'render',
  'import',
] as const;
type Phase = (typeof SUPPORTED_PHASES)[number];
const PHASES = (process.env.JOURNEY_PHASES ?? SUPPORTED_PHASES.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean) as Phase[];
if (PHASES.some((name) => !SUPPORTED_PHASES.includes(name))) {
  throw new Error(`JOURNEY_PHASES must contain only: ${SUPPORTED_PHASES.join(',')}`);
}

const READY_TIMEOUT = 90_000;
/** A person does not act in the frame a menu closes; keys sent that fast hit the old caret. */
const PERSON_PAUSE_MS = 350;
const KEY_DELAY_MS = 12;
const DOCUMENT_NAME = 'Offsite plan';
const MAX_SLIDES = 60;
/** Rendering is for looking, not archiving: enough pages to judge a format. */
const MAX_RENDERED_PAGES = 12;
const VIDEO_EXPORT_TIMEOUT = 600_000;
const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

interface StepRecord {
  name: string;
  status: 'completed' | 'failed';
  ms: number;
  screenshots: string[];
  detail?: unknown;
  error?: string;
}
interface Finding {
  severity: 'high' | 'medium' | 'low';
  area: string;
  message: string;
  step?: string;
  evidence?: unknown;
}
interface HealthEntry {
  step: string;
  kind: string;
  text: string;
}

const steps: StepRecord[] = [];
const findings: Finding[] = [];
const health: HealthEntry[] = [];
let currentStep = 'startup';
let currentShots: string[] = [];
let shotCounter = 0;

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
function find(
  severity: Finding['severity'],
  area: string,
  message: string,
  evidence?: unknown,
): void {
  findings.push({ severity, area, message, step: currentStep, evidence });
  say(`  ! ${severity} ${area}: ${message}`);
}
async function persist(): Promise<void> {
  await writeFile(
    path.join(OUT_DIR, 'journey.json'),
    JSON.stringify(
      { baseUrl: BASE_URL, recordedAt: new Date().toISOString(), steps, findings, health },
      null,
      2,
    ),
  );
}
function watch(page: Page): void {
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) =>
    health.push({ step: currentStep, kind: 'pageerror', text: error.message }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error') {
      health.push({ step: currentStep, kind: 'console', text: message.text().slice(0, 600) });
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      health.push({
        step: currentStep,
        kind: 'http',
        text: `${String(response.status())} ${response.url()}`,
      });
    }
  });
}
async function shoot(page: Page, name: string, fullPage = false): Promise<string> {
  shotCounter += 1;
  const file = `${String(shotCounter).padStart(3, '0')}-${slug(name)}.png`;
  // Fonts that never finish loading must not cost the screenshot; the stall is
  // reported by whichever step measured it.
  await page
    .screenshot({ path: path.join(OUT_DIR, file), fullPage, timeout: 30_000 })
    .catch((error: unknown) => {
      health.push({ step: currentStep, kind: 'screenshot', text: String(error).slice(0, 300) });
    });
  currentShots.push(file);
  return file;
}
async function step(
  name: string,
  page: Page | null,
  action: () => Promise<unknown>,
): Promise<boolean> {
  currentStep = name;
  currentShots = [];
  const started = Date.now();
  let ok = true;
  try {
    const detail = await action();
    steps.push({
      name,
      status: 'completed',
      ms: Date.now() - started,
      screenshots: currentShots,
      detail,
    });
    say(`  ok   ${name}`);
  } catch (error) {
    ok = false;
    if (page) await shoot(page, `${name}-failure`).catch(() => undefined);
    steps.push({
      name,
      status: 'failed',
      ms: Date.now() - started,
      screenshots: currentShots,
      error: String(error).slice(0, 1200),
    });
    find('high', 'journey', `${name} failed: ${String(error).split('\n')[0]?.slice(0, 220) ?? ''}`);
  }
  await persist();
  return ok;
}

// ---------------------------------------------------------------------------
// In-page scripts. Strings, not functions: tsx wraps named inner functions in a
// helper the page does not have.
// ---------------------------------------------------------------------------

/** Top-level blocks of the Write document, plus where focus and the caret are. */
const DOCUMENT_STATE_SCRIPT = `(() => {
  const root = document.querySelector('.ProseMirror');
  if (!root) return { blocks: [], lastEmptyParagraph: false, caretBlock: -1, focus: 'no editor' };
  const children = Array.from(root.children);
  const describe = (node) => {
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\\s+/)[0] : '';
    return node.tagName.toLowerCase() + (cls ? '.' + cls : '') +
      (node.getAttribute('data-type') ? '[' + node.getAttribute('data-type') + ']' : '');
  };
  const selection = getSelection();
  const anchor = selection && selection.anchorNode;
  const caretBlock = anchor ? children.findIndex((child) => child.contains(anchor)) : -1;
  const last = children[children.length - 1];
  const active = document.activeElement;
  const activeLabel = active
    ? active.tagName.toLowerCase() +
      (active.getAttribute('aria-label') ? '[' + active.getAttribute('aria-label').slice(0, 50) + ']' : '') +
      (typeof active.className === 'string' && active.className ? '.' + active.className.trim().split(/\\s+/)[0] : '')
    : 'none';
  return {
    blocks: children.map((child) => ({
      kind: describe(child),
      text: (child.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      height: Math.round(child.getBoundingClientRect().height),
    })),
    lastEmptyParagraph: Boolean(last && last.tagName === 'P' && (last.textContent || '').trim() === ''),
    caretBlock,
    caretInLast: Boolean(last && anchor && last.contains(anchor)),
    focus: activeLabel,
    // The document itself, not a field inside one of its widgets.
    focusInEditor: active === root,
  };
})()`;

/** Sideways overflow of the page and of visible dialogs. */
const OVERFLOW_SCRIPT = `(() => {
  const found = [];
  const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (over > 2) found.push('page scrolls sideways by ' + over + 'px');
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    const rect = dialog.getBoundingClientRect();
    if (rect.width < 1) continue;
    if (rect.right > innerWidth + 2 || rect.left < -2) found.push('dialog wider than the viewport');
    if (rect.bottom > innerHeight + 2 || rect.top < -2) found.push('dialog taller than the viewport');
  }
  return found;
})()`;

/**
 * Scroll the Write document to 'top', to 'bottom', or down by a number of
 * pixels. The scroller is the nearest ancestor that actually scrolls; an
 * ancestor that merely clips also has more content than height.
 */
const SCROLL_DOCUMENT_SCRIPT = `((to) => {
  let node = document.querySelector('.ProseMirror');
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 4) break;
    node = node.parentElement;
  }
  const scroller = node || document.scrollingElement;
  if (to === 'top') scroller.scrollTop = 0;
  else if (to === 'bottom') scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop += to;
  return {
    top: Math.round(scroller.scrollTop),
    page: scroller.clientHeight,
    atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
  };
})`;
interface ScrollState {
  top: number;
  page: number;
  atEnd: boolean;
}
async function scrollDocument(page: Page, to: 'top' | 'bottom' | number): Promise<ScrollState> {
  return (await page.evaluate(
    `${SCROLL_DOCUMENT_SCRIPT}(${typeof to === 'number' ? String(to) : `'${to}'`})`,
  )) as ScrollState;
}

/**
 * Start sampling the Write document every 50 ms: how many widgets it has, how
 * many of them are drawn, how many say they are still rendering, and how tall
 * the document is. STOP returns the samples.
 */
const STABILITY_START_SCRIPT = `(() => {
  window.__journeySamples = [];
  const started = performance.now();
  const sample = () => {
    const root = document.querySelector('.ProseMirror');
    if (!root) return;
    const hosts = Array.from(root.querySelectorAll('[class*="widget-host"], [class*="-host"]'));
    const text = root.textContent || '';
    window.__journeySamples.push({
      t: Math.round(performance.now() - started),
      widgets: hosts.length,
      drawn: hosts.filter((host) => host.getBoundingClientRect().height > 20).length,
      pending: text.split('Rendering Mermaid diagram').length + text.split('Loading code editor').length - 2,
      height: Math.round(root.getBoundingClientRect().height),
    });
  };
  sample();
  window.__journeyTimer = setInterval(sample, 50);
})()`;
const STABILITY_STOP_SCRIPT = `(() => {
  clearInterval(window.__journeyTimer);
  return window.__journeySamples;
})()`;
interface StabilitySample {
  t: number;
  widgets: number;
  drawn: number;
  pending: number;
  height: number;
}

interface DocumentState {
  blocks: Array<{ kind: string; text: string; height: number }>;
  lastEmptyParagraph: boolean;
  caretBlock: number;
  caretInLast?: boolean;
  focus: string;
  focusInEditor?: boolean;
}
async function documentState(page: Page): Promise<DocumentState> {
  return (await page.evaluate(DOCUMENT_STATE_SCRIPT)) as DocumentState;
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

async function newContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    locale: 'en-US',
    acceptDownloads: true,
    // Offline installation is measured by site-ship-review. Left on, every
    // fresh profile here would precache the whole app (over 100 MB) and compete
    // with the lazy chunks this journey is waiting for.
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  watch(page);
  return { context, page };
}
async function waitForShell(page: Page): Promise<void> {
  await page.locator('.db-shell').waitFor({ state: 'visible', timeout: READY_TIMEOUT });
  await page
    .getByRole('button', { name: 'Create a document', exact: true })
    .or(page.getByRole('toolbar', { name: 'Formatting toolbar' }))
    .first()
    .waitFor({ state: 'visible', timeout: READY_TIMEOUT });
}
function editor(page: Page) {
  return page.locator('.ProseMirror').first();
}
function toolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'Formatting toolbar' });
}
async function pause(page: Page, ms = PERSON_PAUSE_MS): Promise<void> {
  await page.waitForTimeout(ms);
}
async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: KEY_DELAY_MS });
}
async function closeOverlays(page: Page): Promise<void> {
  // The find bar replaces the formatting toolbar while it is open, and Escape
  // only closes it from inside its own field.
  const findBox = page.getByPlaceholder('Find in document');
  if (await findBox.isVisible().catch(() => false)) {
    await findBox.focus();
    await page.keyboard.press('Escape');
    await pause(page, 250);
  }
  const open = page.locator('[role="dialog"]:visible, [role="menu"]:visible');
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await open.count()) === 0) return;
    if (attempt < 2) {
      await page.keyboard.press('Escape');
    } else {
      // Escape closes nothing while focus is outside the dialog.
      const close = page
        .locator('[role="dialog"]:visible')
        .last()
        .getByRole('button', { name: /^(Close|Cancel)/ })
        .first();
      if (await close.isVisible().catch(() => false)) await close.click();
    }
    await pause(page, 250);
  }
}
/**
 * Switch to the writing tab unless it is showing; clicking the selected tab
 * opens its mode menu. The tab is the first of the three and takes the name of
 * its mode, so it reads "Blocks" or "Timeline" after one of those was chosen.
 */
async function showWrite(page: Page): Promise<void> {
  const tab = page.getByRole('tablist', { name: 'Editor view' }).getByRole('tab').first();
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await editor(page).waitFor({ state: 'visible', timeout: 30_000 });
}
async function openInsert(page: Page, item: string): Promise<void> {
  await toolbar(page).getByRole('button', { name: 'Insert', exact: true }).click();
  await pause(page, 250);
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await pause(page);
}
/**
 * Click a toolbar button and give focus time to return to the document. Keys
 * sent within ~60 ms of the click lose their first character, a gap no hand
 * moving from mouse to keyboard can produce.
 */
async function clickToolbar(page: Page, name: string): Promise<void> {
  await toolbar(page).getByRole('button', { name, exact: true }).click();
  await pause(page);
}
/** Items of an open menu, whichever menu role the component gave them. */
function menuChoice(page: Page, startsWith: string) {
  return (
    page
      .locator(
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]',
      )
      // An item's title and description join with no space between them
      // ("SlideshowPresent designed slides…"), so a word boundary never matches.
      .filter({ hasText: new RegExp(`^\\s*${startsWith}(?![a-z])`) })
      .first()
  );
}

/** Scroll the document to its end and click the blank space under the last block. */
async function clickBelowLastBlock(page: Page, double = false): Promise<void> {
  await scrollDocument(page, 'bottom');
  await pause(page, 300);
  const last = await page.locator('.ProseMirror > *').last().boundingBox();
  const box = await editor(page).boundingBox();
  if (!last || !box) return;
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const x = box.x + 120;
  const y = Math.min(last.y + last.height + 30, viewport.height - 40);
  if (double) await page.mouse.dblclick(x, y);
  else await page.mouse.click(x, y);
  await pause(page, 300);
}

/** A small PNG and a CSV for the file choosers, made here so the driver needs no assets. */
async function makeFixtures(browser: Browser): Promise<{ image: string; csv: string }> {
  await mkdir(FIXTURES, { recursive: true });
  const image = path.join(FIXTURES, 'harbour.png');
  const csv = path.join(FIXTURES, 'budget.csv');
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.setContent(
    `<body style="margin:0;display:grid;place-items:center;height:100vh;font:600 56px Georgia,serif;
      color:#fff;background:linear-gradient(135deg,#1d4e6b,#e07a3f)">Harbour at dusk</body>`,
  );
  await page.screenshot({ path: image });
  await page.close();
  await writeFile(csv, 'Item,Cost\nVenue,1200\nCatering,800\nTravel,650\n');
  return { image, csv };
}

// ---------------------------------------------------------------------------
// Phase: author
// ---------------------------------------------------------------------------

interface InsertPlan {
  key: string;
  heading: string;
  /** The sentence that opens the section; the item is inserted after it. */
  intro: string;
  /** A block object (not inline text), so the caret phase checks it too. */
  block: boolean;
  /** Choose the item from the Insert menu and whatever follows it. */
  insert: (page: Page) => Promise<unknown>;
  /** What a person then types into it, if anything. */
  fill?: (page: Page) => Promise<void>;
}

function insertPlans(fixtures: { image: string; csv: string }): InsertPlan[] {
  return [
    {
      key: 'link',
      heading: 'Getting there',
      intro: 'The venue is twenty minutes from the station.',
      block: false,
      insert: async (page) => {
        await type(page, ' Directions are on the ');
        await openInsert(page, 'Link');
        const dialog = page.getByRole('dialog', { name: 'Insert link' });
        await dialog.getByRole('textbox', { name: 'Text' }).fill('venue map');
        await dialog.getByRole('textbox', { name: 'URL' }).fill('https://example.com/venue');
        await shoot(page, 'insert-link-dialog');
        await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
        await pause(page);
        await type(page, ' page.');
        return undefined;
      },
    },
    {
      key: 'table',
      heading: 'Budget',
      intro: 'What we expect to spend.',
      block: true,
      insert: async (page) => openInsert(page, 'Table'),
      // Fill the first two rows the way a person does: type, Tab, type.
      fill: async (page) => {
        for (const cell of ['Item', 'Cost', 'Notes', 'Venue', '1200', 'Deposit paid']) {
          await type(page, cell);
          await page.keyboard.press('Tab');
        }
      },
    },
    {
      key: 'task-list',
      heading: 'To do',
      intro: 'Before we leave.',
      block: true,
      // The list starts as one empty item with the caret in it.
      insert: async (page) => {
        await openInsert(page, 'Task List');
        await type(page, 'Book the venue');
        return undefined;
      },
    },
    {
      key: 'chart',
      heading: 'Spending',
      intro: 'Where the money goes.',
      block: true,
      insert: async (page) => {
        await openInsert(page, 'Chart');
        await shoot(page, 'insert-chart-types');
        await page.getByRole('menuitem', { name: 'Insert Column chart' }).click();
        return undefined;
      },
    },
    {
      key: 'diagram',
      heading: 'How the day flows',
      intro: 'One day at a glance.',
      block: true,
      insert: async (page) => openInsert(page, 'Diagram'),
    },
    {
      key: 'mermaid',
      heading: 'Decision path',
      intro: 'How we choose the workshop topics.',
      block: true,
      insert: async (page) => {
        await openInsert(page, 'Complex Diagram (Mermaid)');
        await shoot(page, 'insert-mermaid-types');
        await page.getByRole('menuitem', { name: 'Insert Flowchart Mermaid diagram' }).click();
        return undefined;
      },
    },
    {
      key: 'tree',
      heading: 'Team structure',
      intro: 'Who is coming.',
      block: true,
      insert: async (page) => openInsert(page, 'Tree'),
    },
    {
      key: 'timeline',
      heading: 'Schedule',
      intro: 'The key moments.',
      block: true,
      insert: async (page) => openInsert(page, 'Timeline'),
    },
    {
      key: 'drawing',
      heading: 'Room sketch',
      intro: 'How the room is laid out.',
      block: true,
      insert: async (page) => openInsert(page, 'Drawing'),
    },
    {
      key: 'layout',
      heading: 'Highlights',
      intro: 'Three things to remember.',
      block: true,
      insert: async (page) => openInsert(page, 'Layout'),
    },
    {
      key: 'code',
      heading: 'Packing script',
      intro: 'For the engineers.',
      block: true,
      insert: async (page) => {
        await openInsert(page, 'Insert Code Snippet');
        await page.getByRole('menuitem', { name: 'Insert Python code snippet' }).click();
        return undefined;
      },
    },
    {
      key: 'emoji',
      heading: 'Mood',
      intro: 'A note on spirit.',
      block: false,
      insert: async (page) => {
        await type(page, ' We are looking forward to it ');
        const fonts: string[] = [];
        const onRequest = (request: { resourceType: () => string; url: () => string }): void => {
          if (request.resourceType() === 'font') fonts.push(request.url());
        };
        page.on('request', onRequest);
        const started = Date.now();
        await openInsert(page, 'Emoji');
        // How long the picker keeps the page waiting on fonts.
        const fontsReadyMs = await page
          .waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 60_000 })
          .then(() => Date.now() - started)
          .catch(() => -1);
        page.off('request', onRequest);
        await shoot(page, 'insert-emoji-picker');
        const picker = page.getByRole('dialog', { name: 'Insert emoji' });
        const aria = await picker.ariaSnapshot().catch(() => '');
        const emoji = picker
          .getByRole('button')
          .or(picker.getByRole('option'))
          .or(picker.getByRole('gridcell'))
          .filter({ hasText: /\p{Extended_Pictographic}/u })
          .first();
        if (await emoji.isVisible().catch(() => false)) await emoji.click();
        else {
          find('medium', 'insert', 'Emoji picker offered no emoji this driver could choose', {
            picker: aria.slice(0, 900),
          });
        }
        if (fontsReadyMs < 0 || fontsReadyMs > 3000) {
          find(
            'low',
            'performance',
            fontsReadyMs < 0
              ? 'Opening Insert, Emoji left fonts loading for over 60 s'
              : `Opening Insert, Emoji kept fonts loading for ${String(fontsReadyMs)} ms`,
            fonts,
          );
        }
        return { fontsReadyMs, fonts, picker: aria.slice(0, 900) };
      },
    },
    {
      key: 'online-video',
      heading: 'Last year',
      intro: 'For anyone who missed it.',
      block: true,
      insert: async (page) => {
        await openInsert(page, 'Online Video (YouTube, Vimeo, etc.)');
        const dialog = page.getByRole('dialog', { name: 'Insert video' });
        await dialog
          .getByRole('textbox', { name: /Video link or embed code/ })
          .fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
        await dialog
          .getByRole('textbox', { name: 'Title (optional)' })
          .fill('Last year in two minutes');
        await shoot(page, 'insert-video-dialog');
        await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
        return undefined;
      },
    },
    {
      key: 'image',
      heading: 'The venue',
      intro: 'Where we are staying.',
      block: true,
      insert: async (page) => {
        const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
        await openInsert(page, 'Image/Media');
        await (await chooser).setFiles(fixtures.image);
        await pause(page, 1500);
        return undefined;
      },
    },
    {
      key: 'file',
      heading: 'Attachments',
      intro: 'The numbers behind the plan.',
      block: true,
      insert: async (page) => {
        const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
        await openInsert(page, 'File');
        await (await chooser).setFiles(fixtures.csv);
        await pause(page, 1500);
        return undefined;
      },
    },
  ];
}

async function authorPhase(page: Page, fixtures: { image: string; csv: string }): Promise<void> {
  say('Phase: author');
  await step('author:create', page, async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await waitForShell(page);
    await shoot(page, 'welcome');
    await page.getByRole('button', { name: 'Create a document', exact: true }).click();
    await page.getByRole('textbox', { name: 'Document name', exact: true }).fill(DOCUMENT_NAME);
    await shoot(page, 'create-dialog');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    // The first thing a person does is type, often before the document has
    // finished opening: start the moment the dialog closes.
    const sentence = 'Two days by the water to plan next year together.';
    await page.getByRole('dialog', { name: 'New document' }).waitFor({ state: 'hidden' });
    await type(page, sentence);
    await page.waitForFunction((name) => document.title.startsWith(name), DOCUMENT_NAME, {
      timeout: 20_000,
    });
    await page
      .waitForFunction(
        (text) => document.querySelector('.ProseMirror')?.textContent?.includes(text) ?? false,
        sentence,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    await pause(page);
    const typed = await documentState(page);
    const body = typed.blocks
      .slice(1)
      .map((block) => block.text)
      .join(' ');
    const inTitle = typed.blocks[0]?.text.includes('Two days') ?? false;
    if (inTitle) find('high', 'first-task', 'Typing straight after Create landed in the title');
    else if (!body.includes(sentence)) {
      find(
        'high',
        'first-task',
        body
          ? `Typing straight after Create lost keystrokes: kept "${body.slice(0, 80)}"`
          : 'Typing straight after Create was lost',
      );
    }
    await shoot(page, 'first-sentence');
    return { focusAfterTyping: typed.focus, blocksAfterTyping: typed.blocks };
  });

  await step('author:formatting', page, async () => {
    await page.keyboard.press('Enter');
    // Toolbar heading, then Markdown-style lists and a quote, with a bold phrase.
    await clickToolbar(page, 'Heading 2');
    await type(page, 'Agenda');
    await page.keyboard.press('Enter');
    await type(page, '- Arrive and settle in');
    await page.keyboard.press('Enter');
    await type(page, 'Workshop on the ');
    await page.keyboard.press('Control+B');
    await type(page, 'product roadmap');
    await page.keyboard.press('Control+B');
    await page.keyboard.press('Enter');
    await type(page, 'Dinner at the harbour');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await type(page, '1. Confirm numbers');
    await page.keyboard.press('Enter');
    await type(page, 'Order transport');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await type(page, '> Bring something warm; evenings are cold.');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await pause(page);
    const state = await documentState(page);
    const kinds = state.blocks.map((block) => block.kind.split('.')[0]);
    const heading = state.blocks.find((block) => block.kind.startsWith('h2'));
    if (heading?.text !== 'Agenda') {
      find(
        'medium',
        'authoring',
        'The Heading 2 button did not produce the heading typed after it',
        {
          heading,
        },
      );
    }
    for (const [tag, label] of [
      ['ul', 'a "- " bullet list'],
      ['ol', 'a "1. " numbered list'],
      ['blockquote', 'a "> " quote'],
    ] as const) {
      if (!kinds.includes(tag)) {
        find('medium', 'authoring', `Typing ${label} did not produce <${tag}>`, kinds);
      }
    }
    await shoot(page, 'formatting');
    return { blocks: state.blocks };
  });

  const plans = insertPlans(fixtures);
  await step('author:outline', page, async () => {
    // Every section first: a heading and its opening sentence. Planning the
    // outline and then filling it in is an ordinary way to write, and it keeps
    // each inserted object above some text. The caret phase shows why that
    // matters: under several objects nothing reaches a new paragraph once they
    // are the last thing in the document.
    for (const plan of plans) {
      await type(page, `## ${plan.heading}`);
      await page.keyboard.press('Enter');
      await type(page, plan.intro);
      await page.keyboard.press('Enter');
    }
    await type(page, '## Wrap-up');
    await page.keyboard.press('Enter');
    await type(page, 'See you there.');
    await pause(page, 900);
    const state = await documentState(page);
    const headings = state.blocks.filter((block) => block.kind.startsWith('h2')).length;
    if (headings < plans.length + 2) {
      find('medium', 'authoring', 'Typing "## " did not turn every outline line into a heading', {
        headings,
        expected: plans.length + 2,
      });
    }
    await shoot(page, 'outline');
    return { blocks: state.blocks.length, headings };
  });

  for (const plan of plans) {
    await step(`author:insert-${plan.key}`, page, async () => {
      await closeOverlays(page);
      const intro = editor(page).locator('p', { hasText: plan.intro }).first();
      await intro.scrollIntoViewIfNeeded();
      await intro.click();
      await page.keyboard.press('End');
      await pause(page, 250);
      const before = await documentState(page);
      const detail = await plan.insert(page);
      await pause(page, 900);
      const inserted = await documentState(page);
      if (plan.fill) await plan.fill(page);
      await pause(page, 600);
      const after = await documentState(page);
      const file = await shoot(page, `insert-${plan.key}`);
      const overflow = (await page.evaluate(OVERFLOW_SCRIPT)) as string[];
      if (overflow.length > 0) {
        find('medium', 'layout', `After inserting ${plan.key}: ${overflow.join('; ')}`);
      }
      const kinds = (state: DocumentState): string =>
        state.blocks.map((block) => block.kind).join('|');
      if (plan.block && kinds(after) === kinds(before)) {
        find('medium', 'authoring', `Inserting ${plan.key} added no block to the document`, {
          screenshot: file,
        });
      }
      const at = after.blocks.findIndex((block) => block.text.includes(plan.intro));
      return {
        focusAfterInsert: inserted.focus,
        // The section as it now reads: its opening sentence and what follows.
        section: after.blocks.slice(Math.max(at, 0), Math.max(at, 0) + 6),
        detail,
      };
    });
    await closeOverlays(page);
  }

  await step('author:closing-paragraph', page, async () => {
    const closing = editor(page).locator('p', { hasText: 'See you there.' }).first();
    await closing.scrollIntoViewIfNeeded();
    await closing.click();
    await page.keyboard.press('End');
    await pause(page, 250);
    await type(page, ' Bring a friend.');
    await pause(page, 1200);
    const state = await documentState(page);
    await shoot(page, 'document-end');
    return { blockCount: state.blocks.length, blocks: state.blocks };
  });

  await step('author:typing-stability', page, async () => {
    // Everything above the caret should hold still while a person types below it.
    await pause(page, 6000);
    await page.evaluate(STABILITY_START_SCRIPT);
    await pause(page, 400);
    await type(page, ' More.');
    await pause(page, 4000);
    const samples = (await page.evaluate(STABILITY_STOP_SCRIPT)) as StabilitySample[];
    const heights = samples.map((sample) => sample.height);
    const drawn = samples.map((sample) => sample.drawn);
    const widgets = Math.max(...samples.map((sample) => sample.widgets));
    const result = {
      samples: samples.length,
      widgets,
      drawnMin: Math.min(...drawn),
      drawnMax: Math.max(...drawn),
      heightMin: Math.min(...heights),
      heightMax: Math.max(...heights),
      pendingSamples: samples.filter((sample) => sample.pending > 0).length,
      changes: samples
        .filter(
          (sample, index) =>
            index === 0 ||
            sample.height !== samples[index - 1]?.height ||
            sample.drawn !== samples[index - 1]?.drawn,
        )
        .slice(0, 30),
    };
    if (result.heightMax - result.heightMin > 40 || result.drawnMin < result.drawnMax) {
      find(
        'high',
        'authoring',
        `Typing one short word at the end of the document changed its height by ${String(result.heightMax - result.heightMin)} px and left ${String(result.drawnMin)} to ${String(result.drawnMax)} of ${String(widgets)} widgets drawn`,
        result.changes,
      );
    }
    if (result.pendingSamples > 0) {
      find(
        'medium',
        'authoring',
        `Widgets went back to a "rendering" placeholder while typing elsewhere (${String(result.pendingSamples)} of ${String(result.samples)} samples)`,
      );
    }
    await shoot(page, 'after-typing');
    return result;
  });

  await step('author:undo-redo', page, async () => {
    await page.keyboard.press('Control+Z');
    await pause(page);
    const undone = await documentState(page);
    await page.keyboard.press('Control+Shift+Z');
    await pause(page);
    const redone = await documentState(page);
    const sentence = (state: DocumentState): boolean =>
      state.blocks.some((block) => block.text.includes('More.'));
    if (sentence(undone)) find('medium', 'authoring', 'Ctrl+Z did not undo the last sentence');
    if (!sentence(redone))
      find('medium', 'authoring', 'Ctrl+Shift+Z did not restore the last sentence');
    return { undone: !sentence(undone), redone: sentence(redone) };
  });

  await step('author:reload-persists', page, async () => {
    await pause(page, 1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForShell(page);
    await editor(page).waitFor({ state: 'visible', timeout: 30_000 });
    await pause(page, 1500);
    const state = await documentState(page);
    if (!state.blocks.some((block) => block.text.includes('Bring a friend.'))) {
      find('high', 'persistence', 'The authored document did not survive a reload');
    }
    await shoot(page, 'after-reload');
    return { blocks: state.blocks.length };
  });

  await step('author:whole-document', page, async () => {
    // The whole Write view, top to bottom, a screen at a time.
    let state = await scrollDocument(page, 'top');
    let screens = 0;
    // A document should be one height however far down it is scrolled. When
    // widgets out of view stop being drawn, everything below them moves up and
    // the page shifts under the reader.
    const heights: Array<{ scrollTop: number; height: number; drawn: number; widgets: number }> =
      [];
    while (screens < 30) {
      await pause(page, 600);
      screens += 1;
      await shoot(page, `write-screen-${String(screens).padStart(2, '0')}`);
      await page.evaluate(STABILITY_START_SCRIPT);
      const [sample] = (await page.evaluate(STABILITY_STOP_SCRIPT)) as StabilitySample[];
      if (sample) {
        heights.push({
          scrollTop: state.top,
          height: sample.height,
          drawn: sample.drawn,
          widgets: sample.widgets,
        });
      }
      if (state.atEnd) break;
      state = await scrollDocument(page, state.page - 80);
    }
    const all = heights.map((entry) => entry.height);
    const spread = Math.max(...all) - Math.min(...all);
    if (spread > 100) {
      find(
        'high',
        'authoring',
        `The document's height changed by ${String(spread)} px while scrolling through it (${String(Math.min(...all))} to ${String(Math.max(...all))} px): content out of view stops being drawn, so the page shifts under the reader`,
        heights,
      );
    }
    return { screens, heights };
  });
}

// ---------------------------------------------------------------------------
// Phase: caret
// ---------------------------------------------------------------------------

/** Where a marker typed into the document ended up, relative to the inserted object. */
function landing(state: DocumentState, marker: string): string {
  const index = state.blocks.findIndex((block) => block.text.includes(marker));
  if (index < 0) return 'nowhere';
  const block = state.blocks[index];
  // A generated title (Column chart, Drawing, Layout) is selected on insert so
  // the first keystroke names the block; that replaces it outright.
  if (block?.kind.startsWith('h') && block.text === marker) return 'names it';
  const ownParagraph = block?.kind.startsWith('p') && block.text === marker;
  if (!ownParagraph) return `inside ${block?.kind.split('.')[0] ?? '?'}`;
  const lastObject = state.blocks.reduce(
    (found, candidate, position) =>
      !candidate.kind.startsWith('p') ||
      (candidate.text !== '' && candidate.text !== marker && candidate.text !== 'Intro.')
        ? position
        : found,
    -1,
  );
  return index > lastObject ? 'below' : 'above';
}

async function scratchDocument(page: Page, name: string): Promise<void> {
  await closeOverlays(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill(`${name}.md`);
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  await page.waitForFunction((title) => document.title.startsWith(title), name, {
    timeout: 20_000,
  });
  await pause(page, 700);
  await editor(page).click();
  await pause(page, 250);
  await type(page, 'Intro.');
  await page.keyboard.press('Enter');
  await pause(page, 250);
}

async function caretPhase(page: Page, fixtures: { image: string; csv: string }): Promise<void> {
  say('Phase: caret');
  const gestures: Array<{ key: string; label: string; run: () => Promise<void> }> = [
    { key: 'type', label: 'typing straight away', run: async () => undefined },
    {
      key: 'keys',
      label: 'Ctrl+End, Enter, Enter',
      run: async () => {
        await page.keyboard.press('Control+End');
        await pause(page, 200);
        await page.keyboard.press('Enter');
        await pause(page, 150);
        await page.keyboard.press('Enter');
      },
    },
    { key: 'click', label: 'clicking below it', run: async () => clickBelowLastBlock(page) },
    {
      key: 'double-click',
      label: 'double-clicking below it',
      run: async () => clickBelowLastBlock(page, true),
    },
  ];
  const blockPlans = insertPlans(fixtures).filter(
    (plan) => plan.block && !['image', 'file', 'online-video'].includes(plan.key),
  );
  for (const plan of blockPlans) {
    await step(`caret:${plan.key}`, page, async () => {
      const result: Record<string, string> = {};
      let objectKinds = '';
      for (const gesture of gestures) {
        await scratchDocument(page, `caret-${plan.key}-${gesture.key}`);
        await plan.insert(page);
        await pause(page, 900);
        const inserted = await documentState(page);
        objectKinds = inserted.blocks
          .slice(1)
          .map((block) => block.kind.split('.')[0])
          .join(' ');
        const objectBlocks = inserted.blocks.filter((block) => !block.kind.startsWith('p')).length;
        await gesture.run();
        await pause(page, 300);
        await type(page, 'ZZMARK');
        await pause(page, 400);
        const after = await documentState(page);
        const survivors = after.blocks.filter((block) => !block.kind.startsWith('p')).length;
        result[gesture.key] =
          survivors < objectBlocks ? 'DELETED the object' : landing(after, 'ZZMARK');
        if (gesture.key === 'click' || gesture.key === 'double-click') {
          await shoot(page, `caret-${plan.key}-${gesture.key}`);
        }
      }
      if (result.keys !== 'below' && result.click !== 'below') {
        find(
          'high',
          'authoring',
          `Nothing reaches a new paragraph under a ${plan.key} at the end of a document: Ctrl+End, Enter lands ${result.keys ?? '?'} and clicking below it lands ${result.click ?? '?'}`,
          result,
        );
      }
      if (result['double-click'] === 'DELETED the object') {
        find(
          'high',
          'authoring',
          `Double-clicking below a ${plan.key} at the end of a document and typing deletes it`,
          result,
        );
      }
      if (result.type === 'above' || result.type?.startsWith('inside h')) {
        find(
          'low',
          'authoring',
          `Typing straight after inserting a ${plan.key} lands ${result.type === 'above' ? 'above it' : 'in its generated heading'}`,
          result,
        );
      }
      // With the caret in the first of three paragraphs, does the object land
      // at the caret or somewhere else?
      await scratchDocument(page, `caret-${plan.key}-position`);
      await type(page, 'Middle.');
      await page.keyboard.press('Enter');
      await type(page, 'End.');
      await editor(page).locator('p', { hasText: 'Intro.' }).first().click();
      await page.keyboard.press('End');
      await pause(page, 250);
      await plan.insert(page);
      await pause(page, 900);
      const placed = await documentState(page);
      const order = placed.blocks.map((block) =>
        ['Intro.', 'Middle.', 'End.'].includes(block.text) ? block.text : block.kind.split('.')[0],
      );
      const firstObject = order.findIndex(
        (entry) => !['Intro.', 'Middle.', 'End.', 'p'].includes(entry ?? ''),
      );
      result.position =
        firstObject < 0
          ? 'not found'
          : firstObject < order.indexOf('Middle.')
            ? 'at the caret'
            : firstObject < order.indexOf('End.')
              ? 'after the next paragraph'
              : 'at the end of the section';
      if (result.position !== 'at the caret') {
        find(
          'low',
          'authoring',
          `Insert puts a ${plan.key} ${result.position}, not at the caret (by design for heading-based blocks, which own the paragraphs after them)`,
          order,
        );
      }
      return { inserted: objectKinds, ...result, order: order.join(' | ') };
    });
  }
  await step('caret:return-to-document', page, async () => {
    await closeOverlays(page);
    await page
      .getByRole('treeitem', { name: new RegExp(DOCUMENT_NAME) })
      .first()
      .click();
    await page.waitForFunction((name) => document.title.startsWith(name), DOCUMENT_NAME, {
      timeout: 20_000,
    });
    await pause(page, 1200);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Phase: shell
// ---------------------------------------------------------------------------

async function shellPhase(page: Page): Promise<void> {
  say('Phase: shell');
  /** Click to visible, the first time each lazily loaded surface is opened. */
  const firstOpenMs: Record<string, number> = {};
  await step('shell:keyboard-shortcuts', page, async () => {
    await closeOverlays(page);
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const opened: Record<string, boolean> = {};
    const openMs: Record<string, number> = {};
    const check = async (name: string, open: () => Promise<void>): Promise<void> => {
      await open();
      const started = Date.now();
      opened[name] = await sheet
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      openMs[name] = Date.now() - started;
      if (opened[name]) {
        await shoot(page, `shortcuts-via-${name}`);
        // A sheet that opens and then closes by itself reads as "did nothing".
        await pause(page, 1500);
        if (!(await sheet.isVisible().catch(() => false))) {
          find(
            'medium',
            'shell',
            `The keyboard shortcuts sheet opened by ${name} closed by itself`,
          );
        }
      }
      await closeOverlays(page);
    };
    await check('menu', async () => {
      await page.locator('.db-app-menu-btn').click();
      await page.getByRole('menuitem', { name: /^Keyboard shortcuts/ }).click();
    });
    await check('f1', async () => page.keyboard.press('F1'));
    await check('question-mark', async () => {
      // "?" is a letter while the caret is in the document.
      await page.locator('.db-app-menu-btn').focus();
      await page.keyboard.press('Shift+?');
    });
    firstOpenMs['Keyboard shortcuts'] = openMs.menu ?? 0;
    if (!opened.menu) {
      find(
        'high',
        'shell',
        'The app menu item "Keyboard shortcuts" showed nothing for 5 s',
        opened,
      );
    }
    if (!opened.f1) {
      find(
        'medium',
        'shell',
        'F1, the key the menu advertises for keyboard shortcuts, opens nothing',
        opened,
      );
    }
    return { opened, openMs };
  });

  await step('shell:quick-open-and-find', page, async () => {
    await closeOverlays(page);
    await editor(page).locator('h1').first().click();
    const pressed = Date.now();
    await page.keyboard.press('Control+p');
    // Its code loads on first use; on a cold CDN that alone can take seconds.
    const quickOpen = await page
      .getByRole('dialog', { name: 'Go to document' })
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    firstOpenMs['Go to document (Ctrl+P)'] = Date.now() - pressed;
    await shoot(page, 'quick-open');
    await closeOverlays(page);
    await editor(page).locator('h1').first().click();
    await page.keyboard.press('Control+f');
    await pause(page, 700);
    const findBox = page.getByPlaceholder('Find in document');
    const findOpen = await findBox.isVisible().catch(() => false);
    if (findOpen) await findBox.fill('venue');
    await pause(page, 500);
    await shoot(page, 'find');
    await closeOverlays(page);
    if (!quickOpen) find('medium', 'shell', 'Ctrl+P did not open Go to document within 8 s');
    if (!findOpen) find('medium', 'shell', 'Ctrl+F did not open Find in document');
    return { quickOpen, findOpen };
  });

  await step('shell:share-link', page, async () => {
    await closeOverlays(page);
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: /^Share link/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Share document' });
    const started = Date.now();
    const opened = await dialog
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    firstOpenMs['Share link'] = Date.now() - started;
    // The link is built after the dialog opens.
    await dialog
      .getByText(/\d[\d,]* characters/)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    await shoot(page, 'share-link');
    if (!opened) {
      const said = (await page.locator('[role="alert"], [role="status"]').allInnerTexts())
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 400);
      find('high', 'share', 'Share link opened nothing for the authored document', { said });
      return { opened, said };
    }
    const text = (await dialog.innerText()).replace(/\s+/g, ' ');
    const characters = /([\d,]+) characters/.exec(text)?.[1] ?? null;
    await closeOverlays(page);
    return { opened, characters, notice: text.slice(0, 500) };
  });

  await step('shell:version-history', page, async () => {
    await closeOverlays(page);
    await clickToolbar(page, 'Version history');
    await pause(page, 600);
    await shoot(page, 'version-history');
    const panel =
      (await page.locator('body').innerText()).match(/Version history[\s\S]{0,400}/)?.[0] ?? '';
    await closeOverlays(page);
    return { panel: panel.replace(/\s+/g, ' ').slice(0, 400) };
  });

  await step('shell:first-open-latency', page, async () => {
    // Without the service worker (blocked here, and still installing for most of
    // a real first visit) each of these waits on its own chunk from the CDN.
    const slow = Object.entries(firstOpenMs).filter(([, ms]) => ms > 1000);
    if (slow.length > 0) {
      find(
        'medium',
        'performance',
        `First open with no feedback: ${slow.map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)} s`).join(', ')}`,
        firstOpenMs,
      );
    }
    return firstOpenMs;
  });
}

// ---------------------------------------------------------------------------
// Phase: modes
// ---------------------------------------------------------------------------

const USE_MODES = ['Slideshow', 'Flashcards', 'Video', 'Page', 'Dashboard', 'Document', 'Narrate'];

async function chooseMode(
  page: Page,
  chooser: 'Choose Use mode' | 'Choose Write mode',
  mode: string,
): Promise<void> {
  await closeOverlays(page);
  await toolbar(page).getByRole('button', { name: chooser, exact: true }).click();
  await pause(page, 250);
  await menuChoice(page, mode).click();
  await pause(page, 1500);
}

async function walkSlides(page: Page, prefix: string, limit = MAX_SLIDES): Promise<string[]> {
  const counter = page.getByRole('button', { name: /Choose slide, current/ });
  const next = page.getByRole('button', { name: 'Next slide' });
  const labels: string[] = [];
  for (let index = 0; index < limit; index++) {
    const label =
      (await counter.getAttribute('aria-label').catch(() => null)) ?? `slide ${String(index + 1)}`;
    if (labels.includes(label)) break;
    labels.push(label);
    await shoot(page, `${prefix}-${String(index + 1).padStart(2, '0')}`);
    if (!(await next.isEnabled().catch(() => false))) break;
    await next.click();
    await pause(page, 700);
  }
  return labels;
}

async function modesPhase(page: Page): Promise<void> {
  say('Phase: modes');
  for (const mode of USE_MODES) {
    await step(`modes:use-${slug(mode)}`, page, async () => {
      await chooseMode(page, 'Choose Use mode', mode);
      await shoot(page, `use-${mode}`);
      const overflow = (await page.evaluate(OVERFLOW_SCRIPT)) as string[];
      if (overflow.length > 0) find('medium', 'layout', `${mode}: ${overflow.join('; ')}`);
      if (mode === 'Slideshow') return { slides: await walkSlides(page, 'slide') };
      if (mode === 'Video') {
        await pause(page, 4000);
        await shoot(page, 'use-video-after-4s');
        return undefined;
      }
      // Long modes: two more screens down.
      for (let screen = 1; screen <= 2; screen++) {
        await page.mouse.move(820, 500);
        await page.mouse.wheel(0, 800);
        await pause(page, 500);
        await shoot(page, `use-${mode}-scrolled-${String(screen)}`);
      }
      return undefined;
    });
  }
  for (const mode of ['Blocks', 'Timeline']) {
    await step(`modes:write-${slug(mode)}`, page, async () => {
      await showWrite(page);
      await chooseMode(page, 'Choose Write mode', mode);
      await shoot(page, `write-${mode}`);
      return undefined;
    });
  }
  await step('modes:source', page, async () => {
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    await page.locator('.monaco-editor').first().waitFor({ state: 'visible', timeout: 45_000 });
    await pause(page, 800);
    await shoot(page, 'source');
    return undefined;
  });
  await step('modes:back-to-write', page, async () => {
    await showWrite(page);
    await chooseMode(page, 'Choose Write mode', 'Write');
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Phase: looks
// ---------------------------------------------------------------------------

async function documentSettings(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await closeOverlays(page);
  await showWrite(page);
  await toolbar(page).getByRole('button', { name: 'Document settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Document settings' });
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}
async function openSlideshow(page: Page): Promise<void> {
  await chooseMode(page, 'Choose Use mode', 'Slideshow');
  await page.getByRole('button', { name: /Choose slide, current/ }).waitFor({ timeout: 30_000 });
}

async function looksPhase(page: Page): Promise<void> {
  say('Phase: looks');
  let themes: string[] = [];
  let transforms: string[] = [];
  await step('looks:inventory', page, async () => {
    const dialog = await documentSettings(page);
    transforms = (
      await dialog.getByRole('combobox', { name: 'Transform' }).locator('option').allTextContents()
    )
      .map((name) => name.trim())
      .filter((name) => name && name !== 'None');
    await dialog.getByRole('button', { name: 'Theme' }).click();
    await pause(page, 600);
    await shoot(page, 'theme-picker');
    const picker = page.locator('[role="listbox"], [role="menu"]').last();
    themes = (await picker.getByRole('option').or(picker.getByRole('menuitem')).allTextContents())
      .map((name) => name.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const aria = await picker.ariaSnapshot().catch(() => '');
    await closeOverlays(page);
    return { themes, transforms, picker: aria.slice(0, 1500) };
  });

  for (const theme of themes) {
    await step(`looks:theme-${slug(theme)}`, page, async () => {
      const dialog = await documentSettings(page);
      await dialog.getByRole('button', { name: 'Theme' }).click();
      const picker = page.locator('[role="listbox"], [role="menu"]').last();
      await picker
        .getByRole('option')
        .or(picker.getByRole('menuitem'))
        .filter({ hasText: theme.split(' ')[0] ?? theme })
        .first()
        .click();
      await pause(page);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await pause(page, 900);
      await shoot(page, `theme-${theme}-write`);
      await openSlideshow(page);
      await walkSlides(page, `theme-${slug(theme)}-slide`, 3);
      return undefined;
    });
  }
  for (const transform of transforms) {
    await step(`looks:transform-${slug(transform)}`, page, async () => {
      const dialog = await documentSettings(page);
      await dialog.getByRole('combobox', { name: 'Transform' }).selectOption({ label: transform });
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await pause(page, 900);
      await openSlideshow(page);
      return { slides: await walkSlides(page, `transform-${slug(transform)}-slide`, 4) };
    });
  }
  await step('looks:reset', page, async () => {
    const dialog = await documentSettings(page);
    await dialog.getByRole('combobox', { name: 'Transform' }).selectOption({ label: 'None' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await pause(page, 600);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Phase: exports
// ---------------------------------------------------------------------------

const EXPORT_FORMATS: ReadonlyArray<readonly [label: string, extension: string]> = [
  ['Markdown', 'md'],
  ['PDF', 'pdf'],
  ['Word', 'docx'],
  ['PowerPoint', 'pptx'],
  ['EPUB', 'epub'],
  ['HTML', 'html'],
];

async function exportsPhase(page: Page): Promise<void> {
  say('Phase: exports');
  await mkdir(DOWNLOADS, { recursive: true });
  await step('exports:dialog', page, async () => {
    await closeOverlays(page);
    await showWrite(page);
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export document...' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export Document' });
    await dialog.waitFor();
    await shoot(page, 'export-dialog');
    await dialog.locator('summary').first().click();
    await pause(page);
    await shoot(page, 'export-dialog-more-formats');
    const aria = await dialog.ariaSnapshot();
    await closeOverlays(page);
    return { dialog: aria.slice(0, 2500) };
  });

  for (const [label, extension] of EXPORT_FORMATS) {
    await step(`exports:${extension}`, page, async () => {
      await closeOverlays(page);
      await page.getByRole('button', { name: 'Export and share' }).click();
      await page.getByRole('menuitem', { name: 'Export document...' }).click();
      const dialog = page.getByRole('dialog', { name: 'Export Document' });
      await dialog.getByRole('radio', { name: label, exact: true }).click();
      await pause(page);
      const started = Date.now();
      const pending = page.waitForEvent('download', { timeout: 120_000 });
      await dialog.getByRole('button', { name: /Save .* to Downloads/ }).click();
      try {
        const download = await pending;
        const destination = path.join(DOWNLOADS, `${slug(DOCUMENT_NAME)}.${extension}`);
        await download.saveAs(destination);
        const bytes = (await stat(destination)).size;
        const ms = Date.now() - started;
        if (extension === 'md') {
          await writeFile(path.join(OUT_DIR, 'authored.md'), await readFile(destination));
        }
        // Whatever the dialog says once the file is saved: warnings, omissions.
        const message = (await dialog.innerText().catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 900);
        await shoot(page, `export-${extension}-done`);
        return {
          file: path.basename(destination),
          suggested: download.suggestedFilename(),
          bytes,
          ms,
          message,
        };
      } catch (error) {
        const message = (await dialog.innerText().catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 1200);
        await shoot(page, `export-${extension}-blocked`);
        find('high', 'export', `${label} export produced no file`, { message });
        throw new Error(
          `${label} export produced no download. Dialog said: ${message || String(error)}`,
        );
      }
    });
    await closeOverlays(page);
  }

  await step('exports:mp4', page, async () => {
    await closeOverlays(page);
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export video...' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export Video' });
    await dialog.waitFor({ timeout: 30_000 });
    await dialog
      .getByRole('button', { name: 'Export Video', exact: true })
      .waitFor({ timeout: 60_000 });
    await shoot(page, 'export-video-dialog');
    const summary = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 600);
    const started = Date.now();
    await dialog.getByRole('button', { name: 'Export Video', exact: true }).click();
    await pause(page, 5000);
    await shoot(page, 'export-video-progress');
    const save = page.getByRole('button', { name: 'Save MP4 to Downloads', exact: true });
    try {
      await save.waitFor({ timeout: VIDEO_EXPORT_TIMEOUT });
    } catch (error) {
      const message = (await dialog.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 1200);
      await shoot(page, 'export-video-blocked');
      find('high', 'export', 'Video export never offered a file', { message });
      throw new Error(`Video export never finished. Dialog said: ${message || String(error)}`);
    }
    const renderMs = Date.now() - started;
    await shoot(page, 'export-video-complete');
    const pending = page.waitForEvent('download', { timeout: 60_000 });
    await save.click();
    const destination = path.join(DOWNLOADS, `${slug(DOCUMENT_NAME)}.mp4`);
    await (await pending).saveAs(destination);
    const close = page.getByRole('button', { name: 'Close export dialog' });
    if (await close.isVisible().catch(() => false)) await close.click();
    return {
      file: path.basename(destination),
      bytes: (await stat(destination)).size,
      renderMs,
      summary,
    };
  });
  await closeOverlays(page);
}

// ---------------------------------------------------------------------------
// Phase: render
// ---------------------------------------------------------------------------

/** Render a PDF's first pages to PNG with pdf.js running in a routed origin. */
async function renderPdf(browser: Browser, pdf: string, prefix: string): Promise<string[]> {
  let pdfjsRoot: string;
  try {
    pdfjsRoot = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
  } catch {
    say('  (pdfjs-dist is not installed; the PDF was saved but not rendered)');
    return ['skipped: pdfjs-dist is not installed'];
  }
  const origin = 'https://render.invalid';
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  await page.route(`${origin}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>render</title>',
      });
    } else if (name === '/pdf.mjs' || name === '/pdf.worker.mjs') {
      await route.fulfill({
        contentType: 'text/javascript',
        body: await readFile(
          path.join(pdfjsRoot, 'build', name.slice(1).replace('.mjs', '.min.mjs')),
        ),
      });
    } else if (name === '/doc.pdf') {
      await route.fulfill({ contentType: 'application/pdf', body: await readFile(pdf) });
    } else {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  const written: string[] = [];
  try {
    await page.goto(`${origin}/`);
    const pages = (await page.evaluate(`(async () => {
      const pdfjs = await import('${origin}/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '${origin}/pdf.worker.mjs';
      window.__doc = await pdfjs.getDocument('${origin}/doc.pdf').promise;
      return window.__doc.numPages;
    })()`)) as number;
    for (let number = 1; number <= Math.min(pages, MAX_RENDERED_PAGES); number++) {
      const data = (await page.evaluate(`(async () => {
        const page = await window.__doc.getPage(${String(number)});
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1100 / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        return canvas.toDataURL('image/png');
      })()`)) as string;
      const file = `${prefix}-p${String(number).padStart(2, '0')}.png`;
      await writeFile(path.join(RENDERED, file), Buffer.from(data.split(',')[1] ?? '', 'base64'));
      written.push(file);
    }
    return [`${String(pages)} pages`, ...written];
  } finally {
    await context.close();
  }
}

function findSoffice(): string | null {
  const candidates = [
    process.env.SOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? null
  );
}

/** Convert an Office file to PDF with a throwaway LibreOffice profile. */
async function officeToPdf(soffice: string, file: string): Promise<string> {
  const profile = pathToFileURL(path.join(RENDERED, '.soffice-profile')).href;
  await execFileAsync(
    soffice,
    [
      `-env:UserInstallation=${profile}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      RENDERED,
      file,
    ],
    { timeout: 180_000 },
  );
  return path.join(RENDERED, `${path.basename(file, path.extname(file))}.pdf`);
}

async function renderPhase(browser: Browser): Promise<void> {
  say('Phase: render');
  await mkdir(RENDERED, { recursive: true });
  const base = path.join(DOWNLOADS, slug(DOCUMENT_NAME));
  const soffice = findSoffice();

  if (existsSync(`${base}.pdf`)) {
    await step('render:pdf', null, async () => renderPdf(browser, `${base}.pdf`, 'pdf'));
  }
  for (const extension of ['docx', 'pptx']) {
    if (!existsSync(`${base}.${extension}`)) continue;
    await step(`render:${extension}`, null, async () => {
      if (!soffice) {
        say(`  (LibreOffice not found; set SOFFICE_PATH to render .${extension})`);
        return 'skipped: LibreOffice not found';
      }
      const pdf = await officeToPdf(soffice, `${base}.${extension}`);
      return renderPdf(browser, pdf, extension);
    });
  }
  if (existsSync(`${base}.html`)) {
    await step('render:html', null, async () => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(pathToFileURL(`${base}.html`).href);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(RENDERED, 'html-top.png') });
      await page.screenshot({ path: path.join(RENDERED, 'html-full.png'), fullPage: true });
      await context.close();
      if (errors.length > 0)
        find('medium', 'export', 'Exported HTML raised script errors when opened', errors);
      return ['html-top.png', 'html-full.png'];
    });
  }
  if (existsSync(`${base}.epub`)) {
    await step('render:epub', null, async () => {
      // fflate and pdf.js arrive with Squisq rather than as dependencies of
      // this repo, so both are looked up when needed and skipped when absent.
      const fflate = await import('fflate').catch(() => null);
      if (!fflate) return 'skipped: fflate is not installed';
      const entries = fflate.unzipSync(new Uint8Array(await readFile(`${base}.epub`)));
      const folder = path.join(RENDERED, 'epub');
      for (const [name, bytes] of Object.entries(entries)) {
        if (name.endsWith('/')) continue;
        const target = path.join(folder, name);
        if (!target.startsWith(folder)) continue;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const chapters = Object.keys(entries)
        .filter((name) => /\.x?html$/i.test(name) && !/nav|toc/i.test(name))
        .sort();
      const context = await browser.newContext({ viewport: { width: 760, height: 1000 } });
      const page = await context.newPage();
      const written: string[] = [];
      for (const [index, chapter] of chapters.slice(0, 6).entries()) {
        await page.goto(pathToFileURL(path.join(folder, chapter)).href);
        await page.waitForTimeout(600);
        const file = `epub-${String(index + 1).padStart(2, '0')}.png`;
        await page.screenshot({ path: path.join(RENDERED, file), fullPage: true });
        written.push(file);
      }
      await context.close();
      return { files: Object.keys(entries).length, chapters, written };
    });
  }
  if (existsSync(`${base}.mp4`)) {
    await step('render:mp4', null, async () => {
      try {
        const probe = await execFileAsync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_name,width,height,r_frame_rate',
          '-of',
          'json',
          `${base}.mp4`,
        ]);
        const info = JSON.parse(probe.stdout) as { format?: { duration?: string } };
        const duration = Number(info.format?.duration ?? 0);
        const every = Math.max(duration / 16, 0.5);
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i',
            `${base}.mp4`,
            '-vf',
            `fps=1/${every.toFixed(3)},scale=480:-1,tile=4x4`,
            '-frames:v',
            '1',
            path.join(RENDERED, 'mp4-frames.png'),
          ],
          { timeout: 180_000 },
        );
        return { duration, info, written: ['mp4-frames.png'] };
      } catch (error) {
        say('  (FFmpeg not available; the MP4 was saved but not sampled)');
        return `skipped: ${String(error).split('\n')[0] ?? ''}`;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Phase: import
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  md: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  csv: 'text/csv',
};

async function dropFile(page: Page, selector: string, file: string): Promise<void> {
  const name = path.basename(file);
  const type = MIME[path.extname(file).slice(1)] ?? 'application/octet-stream';
  const base64 = (await readFile(file)).toString('base64');
  const transfer = await page.evaluateHandle(
    ([fileName, mime, data]) => {
      const bytes = Uint8Array.from(atob(data ?? ''), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], fileName ?? 'file', { type: mime }));
      return dataTransfer;
    },
    [name, type, base64],
  );
  for (const event of ['dragenter', 'dragover', 'drop']) {
    await page.dispatchEvent(selector, event, { dataTransfer: transfer });
    await page.waitForTimeout(150);
  }
}

async function importPhase(
  browser: Browser,
  fixtures: { image: string; csv: string },
): Promise<void> {
  say('Phase: import');
  const { context, page } = await newContext(browser);
  try {
    await step('import:affordances', page, async () => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForShell(page);
      await page.getByRole('button', { name: 'Tour the welcome document' }).click();
      await editor(page).waitFor({ state: 'visible', timeout: 30_000 });
      await pause(page, 800);
      // What on screen tells a person they can bring a file in?
      const labels = (await page
        .locator('button, [role="menuitem"], a')
        .evaluateAll((nodes) =>
          nodes
            .map((node) =>
              `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`.trim(),
            )
            .filter((label) => /import|open|upload|drop/i.test(label)),
        )) as string[];
      const visibleText = await page.locator('body').innerText();
      const hint = /drop|drag/i.test(visibleText);
      if (!hint && !labels.some((label) => /import|open (a )?file|upload/i.test(label))) {
        find(
          'medium',
          'import',
          'Nothing on screen says a file can be imported: no Import or Open file control and no drop hint',
          labels,
        );
      }
      return { controlsMentioningImport: labels, dropHintOnScreen: hint };
    });

    const base = path.join(DOWNLOADS, slug(DOCUMENT_NAME));
    const candidates = [
      ...['md', 'docx', 'pdf', 'pptx', 'html'].map((extension) => `${base}.${extension}`),
      fixtures.csv,
    ].filter((file) => existsSync(file));
    for (const file of candidates) {
      const extension = path.extname(file).slice(1);
      await step(`import:${extension}`, page, async () => {
        await closeOverlays(page);
        // A row's text is its name followed by its age ("planNow", "plan1m ago").
        const names = async (): Promise<string[]> =>
          (
            await page
              .locator('[role="treeitem"] .db-tree-name, [role="treeitem"]')
              .allTextContents()
          )
            .map((row) => row.replace(/(Now|\d+[smhd] ago)$/, '').trim())
            .filter(Boolean);
        const before = await names();
        const started = Date.now();
        await dropFile(page, '.db-file-explorer', file);
        // Converting a Word, PDF or PowerPoint file takes several seconds.
        let added: string[] = [];
        while (Date.now() - started < 45_000) {
          await pause(page, 1000);
          added = (await names()).filter((row) => !before.includes(row));
          if (added.length > 0) break;
        }
        const arrivedMs = Date.now() - started;
        const dialog = page.getByRole('dialog').last();
        const message = (await dialog.isVisible().catch(() => false))
          ? (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 800)
          : '';
        await shoot(page, `import-${extension}`);
        let opened: string | null = null;
        if (added.length === 0) {
          find(
            'medium',
            'import',
            `Dropping a .${extension} file on the file pane added nothing in 45 s`,
            {
              message,
            },
          );
        } else {
          if (arrivedMs > 5000) {
            find(
              'low',
              'import',
              `A dropped .${extension} file took ${(arrivedMs / 1000).toFixed(0)} s to appear in the file list`,
            );
          }
          // Open what arrived and look at it.
          await closeOverlays(page);
          const row = page
            .getByRole('treeitem')
            .filter({ hasText: added[0] ?? '' })
            .first();
          await row.click().catch(() => undefined);
          await pause(page, 4000);
          opened = await page.title();
          await shoot(page, `import-${extension}-opened`);
        }
        const state = await documentState(page).catch(() => null);
        return {
          added,
          arrivedMs,
          message,
          opened,
          blocks: state?.blocks.slice(0, 14),
        };
      });
    }
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Contact sheet
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

async function writeIndex(): Promise<void> {
  const rendered = existsSync(RENDERED)
    ? (await readdir(RENDERED)).filter((name) => name.endsWith('.png')).sort()
    : [];
  const rows = steps
    .map((record) => {
      const shots = record.screenshots
        .map((file) => `<a href="${file}"><img loading="lazy" src="${file}" alt=""></a>`)
        .join('');
      const body =
        record.status === 'failed' ? (record.error ?? '') : JSON.stringify(record.detail ?? '');
      return `<section class="${record.status}"><h2>${escapeHtml(record.name)} <small>${record.status} · ${String(record.ms)} ms</small></h2><pre>${escapeHtml(body.slice(0, 1400))}</pre><div class="shots">${shots}</div></section>`;
    })
    .join('\n');
  const findingRows = findings
    .map(
      (finding) =>
        `<li class="${finding.severity}"><b>${finding.severity}</b> ${escapeHtml(finding.area)} — ${escapeHtml(finding.message)} <small>${escapeHtml(finding.step ?? '')}</small></li>`,
    )
    .join('\n');
  const renderedRows = rendered
    .map(
      (file) =>
        `<a href="rendered/${file}"><img loading="lazy" src="rendered/${file}" alt="${file}"></a>`,
    )
    .join('');
  await writeFile(
    path.join(OUT_DIR, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Journey review</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#f4f1ea;color:#222}
h1{margin:0 0 4px}h2{font-size:15px;margin:0 0 6px}small{font-weight:400;color:#666}
section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0}
section.failed{border-color:#c0392b}pre{white-space:pre-wrap;font-size:11px;color:#555;max-height:120px;overflow:auto;margin:0 0 8px}
.shots{display:flex;flex-wrap:wrap;gap:8px}.shots img{width:340px;border:1px solid #ccc}
li.high b{color:#c0392b}li.medium b{color:#b9770e}li.low b{color:#555}
</style>
<h1>New-user journey</h1><p>${escapeHtml(BASE_URL)} · ${new Date().toISOString()}</p>
<h2>Findings (${String(findings.length)})</h2><ul>${findingRows}</ul>
${rows}
<section><h2>Rendered exports</h2><div class="shots">${renderedRows}</div></section>`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  say(`Journey review of ${BASE_URL} -> ${OUT_DIR}`);
  const browser = await chromium.launch();
  try {
    const fixtures = await makeFixtures(browser);
    const needsDocument = PHASES.some((name) =>
      ['author', 'caret', 'shell', 'modes', 'looks', 'exports'].includes(name),
    );
    if (needsDocument) {
      const { context, page } = await newContext(browser);
      try {
        // Later phases need the authored document; it lives in this profile.
        await authorPhase(page, fixtures);
        if (PHASES.includes('caret')) await caretPhase(page, fixtures);
        if (PHASES.includes('shell')) await shellPhase(page);
        if (PHASES.includes('modes')) await modesPhase(page);
        if (PHASES.includes('looks')) await looksPhase(page);
        if (PHASES.includes('exports')) await exportsPhase(page);
      } finally {
        await context.close();
      }
    }
    if (PHASES.includes('render')) await renderPhase(browser);
    if (PHASES.includes('import')) await importPhase(browser, fixtures);
  } finally {
    await browser.close();
    const pageErrors = health.filter((entry) => entry.kind === 'pageerror');
    if (pageErrors.length > 0) {
      findings.push({
        severity: 'high',
        area: 'health',
        message: `${String(pageErrors.length)} uncaught page error(s) during the journey`,
        evidence: pageErrors.slice(0, 10),
      });
    }
    await persist();
    await writeIndex();
  }
  const failed = steps.filter((record) => record.status === 'failed').length;
  const high = findings.filter((finding) => finding.severity === 'high').length;
  say(
    `Done: ${String(steps.length)} steps (${String(failed)} failed), ${String(findings.length)} findings (${String(high)} high), ${String(shotCounter)} screenshots.`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
