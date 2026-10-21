/**
 * Pages crawl — the static pages around the app: product, docs, legal, and
 * not-found. `live-ux-crawl.ts`, `site-affordance-crawl.ts`, and
 * `site-ship-review.ts` start at `/` and audit the editor shell; they visit
 * these pages from a fixed list and click nothing on them. This driver
 * discovers every page from the sitemap and from the pages' own links, and
 * audits each one at seven viewport/theme profiles.
 *
 * Per page and profile: an above-the-fold and a full-page screenshot;
 * horizontal overflow and the innermost elements causing it; clipped and
 * horizontally scrolling boxes; broken, unlabeled, or upscaled images; phone
 * tap targets under 24 px and text under 12 px; layout shift; console, CSP,
 * and request failures; and axe at WCAG 2.1 AA on three profiles. Per page:
 * search and social metadata, every link and fragment, every in-page control
 * clicked, and a keyboard pass (skip link, focus indicator, obscured focus).
 * For /desktop/: the primary download per detected platform, the fallback
 * when the GitHub API fails, and whether each installer URL resolves. For the
 * origin: redirects, the 404 status, robots, sitemap, icons, social image,
 * web manifest, and certificate expiry.
 *
 *   npm run ux:crawl -- --pages                     # build, preview, crawl
 *   LIVE_UX_BASE_URL=https://docblocks.com npm run ux:crawl -- --pages reports/pages
 *
 * Optional PAGES_PROFILES=desktop-light,phone-light,... and
 * PAGES_PHASES=origin,pages,keyboard,interactions,downloads,links (both
 * default to all).
 *
 * Output: NNN-*.png, pages.json, findings.json, and index.html — a contact
 * sheet with the findings first and one row per page, one column per
 * profile. Findings are heuristics for triage, not verdicts: look at the
 * screenshot before calling anything a bug.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

const BASE_URL = (process.env.LIVE_UX_BASE_URL ?? 'http://127.0.0.1:5240').replace(/\/$/, '');
const BASE = new URL(BASE_URL);
const LIVE = !['localhost', '127.0.0.1', '[::1]'].includes(BASE.hostname);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve(process.argv[2] ?? `reports/pages-${STAMP}`);
const NAV_TIMEOUT = 45_000;
/** /desktop/ fills its download grid from the GitHub releases API after `load`. */
const DOWNLOADS_TIMEOUT = 25_000;
/** WCAG 2.2 SC 2.5.8 minimum; links inside running text are exempt. */
const MIN_TARGET_PX = 24;
const MIN_TEXT_PX = 12;
/** Tab stops walked per page before giving up on reaching the end. */
const MAX_TAB_STOPS = 90;
/** The editor lives at `/`; the other drivers audit it, so only its static head is checked. */
const APP_PATH = '/';
const MISSING_PATH = '/pages-crawl-missing-page/';
/**
 * The not-found page as visitors meet it. GitHub Pages answers a missing path
 * with 404.html and a 404 status; `vite preview` answers with a blank page of
 * its own, so a local run audits the file itself.
 */
const NOT_FOUND_PAGE = LIVE ? MISSING_PATH : '/404.html';
const NOT_FOUND_STATUS = LIVE ? 404 : 200;
const PRODUCTION_ORIGIN = 'https://docblocks.com';

/**
 * tsx compiles with esbuild's keepNames, which wraps every named function in
 * a `__name(...)` call. Functions passed to page.evaluate run in the page,
 * where that helper does not exist, so give the page a pass-through first.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((target) => target);';

/**
 * Cumulative layout shift since navigation, read back by collectMetrics, with
 * the elements behind each of the largest shifts so a finding names its cause.
 */
const CLS_SCRIPT = `(() => {
  window.__pagesCrawlCls = 0;
  window.__pagesCrawlShifts = [];
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return node ? node.nodeName : '?';
    const classes = Array.from(node.classList).slice(0, 2).join('.');
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : classes ? '.' + classes : '');
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__pagesCrawlCls += entry.value;
        window.__pagesCrawlShifts.push({
          value: Math.round(entry.value * 1000) / 1000,
          atMs: Math.round(entry.startTime),
          sources: (entry.sources || []).slice(0, 3).map((source) =>
            describe(source.node) + ' moved ' +
            Math.round(source.currentRect.y - source.previousRect.y) + 'px, height ' +
            Math.round(source.previousRect.height) + '->' + Math.round(source.currentRect.height)),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
})();`;

type Severity = 'high' | 'medium' | 'low';

interface Finding {
  severity: Severity;
  area: string;
  page?: string;
  profile?: string;
  message: string;
  evidence?: unknown;
  screenshot?: string;
}

interface Profile {
  name: string;
  width: number;
  height: number;
  theme: 'light' | 'dark';
  mobile: boolean;
  scale: number;
  axe: boolean;
}

/**
 * Small phones render at 1x: a 320 px page is the tallest capture, and at 2x
 * it passes the 16k-pixel screenshot limit Chromium can stitch.
 */
const PROFILES: Profile[] = [
  {
    name: 'desktop-light',
    width: 1440,
    height: 900,
    theme: 'light',
    mobile: false,
    scale: 1,
    axe: true,
  },
  {
    name: 'desktop-dark',
    width: 1440,
    height: 900,
    theme: 'dark',
    mobile: false,
    scale: 1,
    axe: true,
  },
  { name: 'laptop', width: 1024, height: 768, theme: 'light', mobile: false, scale: 1, axe: false },
  { name: 'tablet', width: 768, height: 1024, theme: 'light', mobile: true, scale: 2, axe: false },
  {
    name: 'phone-light',
    width: 390,
    height: 844,
    theme: 'light',
    mobile: true,
    scale: 2,
    axe: true,
  },
  {
    name: 'phone-dark',
    width: 390,
    height: 844,
    theme: 'dark',
    mobile: true,
    scale: 2,
    axe: false,
  },
  {
    name: 'small-phone',
    width: 320,
    height: 640,
    theme: 'light',
    mobile: true,
    scale: 1,
    axe: false,
  },
];

function listFilter(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
const PROFILE_FILTER = listFilter('PAGES_PROFILES');
const PHASE_FILTER = listFilter('PAGES_PHASES');
const phaseEnabled = (name: string): boolean =>
  PHASE_FILTER.length === 0 || PHASE_FILTER.includes(name);
const activeProfiles = PROFILES.filter(
  (profile) => PROFILE_FILTER.length === 0 || PROFILE_FILTER.includes(profile.name),
);

interface LinkRef {
  href: string;
  raw: string;
  text: string;
  target: string | null;
  rel: string | null;
}

interface PageMetrics {
  title: string;
  viewportWidth: number;
  scrollWidth: number;
  overflow: Array<{ selector: string; left: number; right: number }>;
  scrollers: Array<{ selector: string; clientWidth: number; scrollWidth: number }>;
  clipped: Array<{ selector: string; clientWidth: number; scrollWidth: number; text: string }>;
  brokenImages: string[];
  missingAlt: string[];
  upscaledImages: Array<{ src: string; natural: number; needed: number }>;
  smallTargets: Array<{ selector: string; text: string; width: number; height: number }>;
  tinyText: Array<{ selector: string; px: number; text: string }>;
  headings: Array<{ level: number; text: string }>;
  ids: string[];
  links: LinkRef[];
  navCurrent: string[];
  brandImage: string | null;
  bodyBackground: string;
  bodyLuminance: number;
  layoutShift: number;
  layoutShiftSources: Array<{ value: number; atMs: number; sources: string[] }>;
}

interface AxeSummary {
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    nodes: number;
    targets: string[];
  }>;
  incomplete: number;
  passes: number;
}

interface EventSink {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
}

interface PageCapture {
  path: string;
  profile: string;
  status: number | null;
  fold: string | null;
  full: string | null;
  metrics: PageMetrics | null;
  axe: AxeSummary | null;
  events: EventSink;
  ms: number;
  error?: string;
}

interface HeadMeta {
  title: string;
  description: string | null;
  robots: string | null;
  viewport: string | null;
  canonical: string | null;
  lang: string;
  ogTitle: string | null;
  ogDescription: string | null;
  ogUrl: string | null;
  ogImage: string | null;
  ogImageAlt: string | null;
  twitterCard: string | null;
  themeColor: string[];
  icon: string | null;
  appleTouchIcon: string | null;
  manifest: string | null;
  csp: string | null;
  h1: string[];
}

interface FocusState {
  tag: string;
  key: string;
  text: string;
  href: string | null;
  indicator: boolean;
  outline: string;
  boxShadow: string;
  inViewport: boolean;
  obscuredBy: string | null;
  isSkipLink: boolean;
  inMain: boolean;
}

interface KeyboardResult {
  path: string;
  profile: string;
  firstStop: FocusState | null;
  skipLinkVisible: boolean | null;
  skipLinkMovesFocus: boolean | null;
  stops: FocusState[];
  reachedEnd: boolean;
  screenshots: string[];
  error?: string;
}

interface InteractionResult {
  path: string;
  profile: string;
  control: string;
  kind: 'fragment' | 'control';
  hash?: string;
  targetFound?: boolean;
  targetTop?: number | null;
  landed?: boolean;
  changed?: boolean;
  screenshot: string | null;
  error?: string;
}

interface DownloadScenario {
  name: string;
  expect: string | null;
  label: string | null;
  sub: string | null;
  href: string | null;
  ariaLabel: string | null;
  detected: string[];
  items: Array<{ label: string; href: string; size: string }>;
  fallbackVisible: boolean;
  loadingVisible: boolean;
  version: string | null;
  screenshots: string[];
  error?: string;
}

interface LinkCheck {
  href: string;
  sources: string[];
  texts: string[];
  kind: 'internal' | 'fragment' | 'external' | 'other';
  status: number | string | null;
  finalUrl?: string;
  note?: string;
}

interface OriginCheck {
  name: string;
  url: string;
  ok: boolean;
  detail: unknown;
}

const findings: Finding[] = [];
const captures: PageCapture[] = [];
const heads = new Map<string, HeadMeta>();
const keyboardResults: KeyboardResult[] = [];
const interactions: InteractionResult[] = [];
const downloadScenarios: DownloadScenario[] = [];
const linkChecks: LinkCheck[] = [];
const originChecks: OriginCheck[] = [];
const installerChecks: Array<{ href: string; status: number | string; bytes: number | null }> = [];
let pagePaths: string[] = [];
let shotCounter = 0;
let sink: EventSink = emptySink();

function emptySink(): EventSink {
  return { console: [], pageErrors: [], failedRequests: [] };
}

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'root'
  );
}

function note(finding: Finding): void {
  findings.push(finding);
}

/**
 * Report what a phase without per-page captures raised, then start a clean
 * sink, so its errors are attributed to the phase rather than to whichever
 * page was captured last.
 */
function flushPhaseEvents(phase: string): void {
  for (const error of sink.pageErrors) {
    note({ severity: 'high', area: 'script', profile: phase, message: `Uncaught error: ${error}` });
  }
  for (const line of sink.console) {
    note({ severity: 'medium', area: 'console', profile: phase, message: line });
  }
  sink = emptySink();
}

async function persist(): Promise<void> {
  await writeFile(
    path.join(OUT_DIR, 'pages.json'),
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        recordedAt: new Date().toISOString(),
        pages: pagePaths,
        captures,
        heads: Object.fromEntries(heads),
        keyboard: keyboardResults,
        interactions,
        downloads: downloadScenarios,
        installers: installerChecks,
        links: linkChecks,
        origin: originChecks,
      },
      null,
      2,
    ),
  );
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

function wire(page: Page): void {
  page.setDefaultTimeout(10_000);
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    // The not-found page's own 404 is the status this crawl asks for.
    if (message.location().url.includes(MISSING_PATH) && /status of 404/.test(message.text())) {
      return;
    }
    sink.console.push(`${message.type()}: ${message.text().slice(0, 400)}`);
  });
  page.on('pageerror', (error) => sink.pageErrors.push(error.message.slice(0, 400)));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    if (!failure.includes('ERR_ABORTED')) sink.failedRequests.push(`${failure} ${request.url()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes(MISSING_PATH)) {
      sink.failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
}

/**
 * The GitHub releases API allows 60 unauthenticated requests an hour per IP,
 * and every fresh context on /desktop/ spends one. Answer repeat requests
 * from the first response so the crawl measures the page, not the quota;
 * the `api-live` download scenario still goes to the network.
 */
const apiCache = new Map<
  string,
  { status: number; headers: Record<string, string>; body: Buffer }
>();

async function cacheGitHubApi(context: BrowserContext): Promise<void> {
  await context.route('https://api.github.com/**', async (route) => {
    try {
      const url = route.request().url();
      let cached = apiCache.get(url);
      if (!cached) {
        const response = await route.fetch();
        cached = {
          status: response.status(),
          headers: response.headers(),
          body: await response.body(),
        };
        if (response.ok()) apiCache.set(url, cached);
      }
      await route.fulfill({ status: cached.status, headers: cached.headers, body: cached.body });
    } catch {
      // The page navigated or its context closed mid-request (the head phase
      // moves on at domcontentloaded); nothing is waiting for this answer.
      await route.abort().catch(() => undefined);
    }
  });
}

async function openContext(
  browser: Browser,
  profile: Pick<Profile, 'width' | 'height' | 'theme' | 'mobile' | 'scale'>,
  options: {
    userAgent?: string;
    initScript?: string;
    cacheApi?: boolean;
    reducedMotion?: boolean;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    colorScheme: profile.theme,
    isMobile: profile.mobile,
    hasTouch: profile.mobile,
    deviceScaleFactor: profile.scale,
    locale: 'en-US',
    userAgent: options.userAgent,
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
    // These pages register no service worker, and `/` precaching the editor
    // would compete with every measurement taken here.
    serviceWorkers: 'block',
  });
  await context.addInitScript(NAME_SHIM);
  await context.addInitScript(CLS_SCRIPT);
  if (options.initScript) await context.addInitScript(options.initScript);
  if (options.cacheApi !== false) await cacheGitHubApi(context);
  const page = await context.newPage();
  wire(page);
  return { context, page };
}

/** Fonts, plus the /desktop/ download grid, which removes its placeholder when it settles. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
  await page
    .locator('[data-dl-loading]')
    .waitFor({ state: 'detached', timeout: DOWNLOADS_TIMEOUT })
    .catch(() => undefined);
}

async function open(page: Page, pagePath: string): Promise<number | null> {
  const response = await page.goto(`${BASE_URL}${pagePath}`, {
    waitUntil: 'load',
    timeout: NAV_TIMEOUT,
  });
  await page.evaluate(NAME_SHIM);
  await settle(page);
  return response?.status() ?? null;
}

// ---------------------------------------------------------------------------
// In-page collectors. These run in the browser; see NAME_SHIM.
// ---------------------------------------------------------------------------

function collectMetrics(options: {
  minTarget: number;
  minText: number;
  mobile: boolean;
}): PageMetrics {
  const viewportWidth = document.documentElement.clientWidth;
  function describe(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.body && parts.length < 4) {
      const tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${tag}#${node.id}`);
        break;
      }
      const classes = Array.from(node.classList).slice(0, 2).join('.');
      parts.unshift(classes ? `${tag}.${classes}` : tag);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function shown(element: Element): boolean {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  }
  function luminance(color: string): number {
    const channels = (color.match(/[\d.]+/g) ?? ['255', '255', '255']).slice(0, 3).map(Number);
    const [r, g, b] = channels.map((value) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const everything = Array.from(document.body.querySelectorAll<HTMLElement>('*'));

  // Overflow: an element past the viewport edge that no ancestor below
  // <body> clips. Clipping on <body>/<html> hides content rather than fixing
  // it, so it does not excuse the element.
  const overflowing = everything.filter((element) => {
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return false;
    if (box.right <= viewportWidth + 1 && box.left >= -1) return false;
    if (getComputedStyle(element).position === 'fixed') return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      if (getComputedStyle(parent).overflowX !== 'visible') return false;
    }
    return true;
  });
  const overflow = overflowing
    .filter((element) => !overflowing.some((other) => other !== element && element.contains(other)))
    .slice(0, 15)
    .map((element) => {
      const box = element.getBoundingClientRect();
      return {
        selector: describe(element),
        left: Math.round(box.left),
        right: Math.round(box.right),
      };
    });

  const scrollers: PageMetrics['scrollers'] = [];
  const clipped: PageMetrics['clipped'] = [];
  for (const element of everything) {
    if (element.clientWidth === 0 || element.scrollWidth <= element.clientWidth + 1) continue;
    if (!shown(element)) continue;
    const overflowX = getComputedStyle(element).overflowX;
    const entry = {
      selector: describe(element),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
    if (overflowX === 'auto' || overflowX === 'scroll') scrollers.push(entry);
    else if (overflowX === 'hidden' || overflowX === 'clip') {
      clipped.push({ ...entry, text: (element.innerText ?? '').trim().slice(0, 80) });
    }
  }

  const brokenImages: string[] = [];
  const missingAlt: string[] = [];
  const upscaledImages: PageMetrics['upscaledImages'] = [];
  for (const image of Array.from(document.images)) {
    const source = image.currentSrc || image.src;
    if (image.complete && image.naturalWidth === 0) brokenImages.push(source);
    if (!image.hasAttribute('alt')) missingAlt.push(source);
    if (!shown(image) || image.naturalWidth === 0 || /\.svg(\?|$)/.test(source)) continue;
    const needed = Math.round(image.getBoundingClientRect().width * devicePixelRatio);
    if (needed > image.naturalWidth * 1.15) {
      upscaledImages.push({ src: source, natural: image.naturalWidth, needed });
    }
  }

  const smallTargets: PageMetrics['smallTargets'] = [];
  const tinyText: PageMetrics['tinyText'] = [];
  if (options.mobile) {
    const targets = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [role="button"]',
    );
    for (const target of Array.from(targets)) {
      if (!shown(target) || target.classList.contains('skip-link')) continue;
      const inline = getComputedStyle(target).display === 'inline';
      if (inline && target.closest('p, li, td, dd, figcaption, small, blockquote')) continue;
      const box = target.getBoundingClientRect();
      if (box.width < options.minTarget || box.height < options.minTarget) {
        smallTargets.push({
          selector: describe(target),
          text: (target.innerText || target.getAttribute('aria-label') || '').trim().slice(0, 50),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }
    const seen = new Set<string>();
    for (const element of everything) {
      const ownText = Array.from(element.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent ?? '')
        .join('')
        .trim();
      if (!ownText || !shown(element)) continue;
      const px = parseFloat(getComputedStyle(element).fontSize);
      const selector = describe(element);
      if (px < options.minText && !seen.has(selector)) {
        seen.add(selector);
        tinyText.push({ selector, px, text: ownText.slice(0, 60) });
      }
    }
  }

  const background = (() => {
    const body = getComputedStyle(document.body).backgroundColor;
    return body === 'rgba(0, 0, 0, 0)'
      ? getComputedStyle(document.documentElement).backgroundColor
      : body;
  })();
  const brand = document.querySelector<HTMLImageElement>('.brand img, header img');
  const shift = (window as unknown as { __pagesCrawlCls?: number }).__pagesCrawlCls ?? 0;

  return {
    title: document.title,
    viewportWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow,
    scrollers: scrollers.slice(0, 15),
    clipped: clipped.slice(0, 15),
    brokenImages,
    missingAlt,
    upscaledImages,
    smallTargets: smallTargets.slice(0, 25),
    tinyText: tinyText.slice(0, 15),
    headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: (heading.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
    })),
    ids: Array.from(document.querySelectorAll('[id], a[name]')).map(
      (element) => element.id || element.getAttribute('name') || '',
    ),
    links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((anchor) => ({
      href: anchor.href,
      raw: anchor.getAttribute('href') ?? '',
      text: (anchor.innerText || anchor.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80),
      target: anchor.getAttribute('target'),
      rel: anchor.getAttribute('rel'),
    })),
    navCurrent: Array.from(document.querySelectorAll('nav a[aria-current="page"]')).map(
      (anchor) => anchor.getAttribute('href') ?? '',
    ),
    brandImage: brand ? brand.currentSrc || brand.src : null,
    bodyBackground: background,
    bodyLuminance: Math.round(luminance(background) * 1000) / 1000,
    layoutShift: Math.round(shift * 1000) / 1000,
    layoutShiftSources: (
      (
        window as unknown as {
          __pagesCrawlShifts?: Array<{ value: number; atMs: number; sources: string[] }>;
        }
      ).__pagesCrawlShifts ?? []
    )
      .sort((a, b) => b.value - a.value)
      .slice(0, 3),
  };
}

function collectHead(): HeadMeta {
  function content(selector: string): string | null {
    return document.querySelector(selector)?.getAttribute('content') ?? null;
  }
  function href(selector: string): string | null {
    return document.querySelector(selector)?.getAttribute('href') ?? null;
  }
  return {
    title: document.title,
    description: content('meta[name="description"]'),
    robots: content('meta[name="robots"]'),
    viewport: content('meta[name="viewport"]'),
    canonical: href('link[rel="canonical"]'),
    lang: document.documentElement.lang,
    ogTitle: content('meta[property="og:title"]'),
    ogDescription: content('meta[property="og:description"]'),
    ogUrl: content('meta[property="og:url"]'),
    ogImage: content('meta[property="og:image"]'),
    ogImageAlt: content('meta[property="og:image:alt"]'),
    twitterCard: content('meta[name="twitter:card"]'),
    themeColor: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map(
      (element) => element.getAttribute('content') ?? '',
    ),
    icon: href('link[rel="icon"]'),
    appleTouchIcon: href('link[rel="apple-touch-icon"]'),
    manifest: href('link[rel="manifest"]'),
    csp: content('meta[http-equiv="Content-Security-Policy"]'),
    h1: Array.from(document.querySelectorAll('h1')).map((heading) =>
      (heading.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  };
}

function focusState(): FocusState {
  const element = document.activeElement as HTMLElement | null;
  if (!element || element === document.body || element === document.documentElement) {
    return {
      tag: 'BODY',
      key: 'body',
      text: '',
      href: null,
      indicator: false,
      outline: '',
      boxShadow: '',
      inViewport: false,
      obscuredBy: null,
      isSkipLink: false,
      inMain: false,
    };
  }
  function describe(node: Element): string {
    const tag = node.tagName.toLowerCase();
    if (node.id) return `${tag}#${node.id}`;
    const classes = Array.from(node.classList).slice(0, 2).join('.');
    return classes ? `${tag}.${classes}` : tag;
  }
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const outlined = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  const shadowed = style.boxShadow !== 'none';
  // Hit-test the centre only when it is on screen: off screen, elementFromPoint
  // answers for whatever is at the clamped edge, not for what covers the stop.
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const onScreen = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const hit = onScreen ? document.elementFromPoint(x, y) : null;
  const obscured = !!hit && hit !== element && !element.contains(hit) && !hit.contains(element);
  const text = (element.innerText || element.getAttribute('aria-label') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const siblings = element.parentElement
    ? Array.from(element.parentElement.children).indexOf(element)
    : 0;
  return {
    tag: element.tagName,
    key: `${describe(element)}:${siblings}:${text}`,
    text,
    href: element.getAttribute('href'),
    indicator: outlined || shadowed,
    outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
    boxShadow: style.boxShadow,
    inViewport: box.bottom > 0 && box.top < innerHeight && box.width > 1,
    obscuredBy: obscured && hit ? describe(hit) : null,
    isSkipLink: element.classList.contains('skip-link') || /^skip/i.test(text),
    inMain: !!element.closest('main'),
  };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function capturePage(page: Page, profile: Profile, pagePath: string): Promise<PageCapture> {
  sink = emptySink();
  const started = Date.now();
  const capture: PageCapture = {
    path: pagePath,
    profile: profile.name,
    status: null,
    fold: null,
    full: null,
    metrics: null,
    axe: null,
    events: sink,
    ms: 0,
  };
  try {
    capture.status = await open(page, pagePath);
    capture.fold = await shoot(page, `${slug(pagePath)}-${profile.name}-fold`);
    capture.full = await shoot(page, `${slug(pagePath)}-${profile.name}-full`, true);
    capture.metrics = await page.evaluate(collectMetrics, {
      minTarget: MIN_TARGET_PX,
      minText: MIN_TEXT_PX,
      mobile: profile.mobile,
    });
    if (profile.axe) {
      const report = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      capture.axe = {
        violations: report.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact ?? null,
          help: violation.help,
          nodes: violation.nodes.length,
          targets: violation.nodes.slice(0, 6).map((node) => node.target.join(' ')),
        })),
        incomplete: report.incomplete.length,
        passes: report.passes.length,
      };
    }
  } catch (error) {
    capture.error = String(error).split('\n')[0].slice(0, 300);
  }
  capture.ms = Date.now() - started;
  say(
    `  ${profile.name} ${pagePath} → ${capture.status ?? 'no response'}${capture.error ? ` ! ${capture.error}` : ''}`,
  );
  return capture;
}

function isPagePath(url: URL): boolean {
  if (url.origin !== BASE.origin) return false;
  if (url.pathname === APP_PATH) return false;
  if (/^\/(assets|_res|marketing|fonts|icons|screenshots)\//.test(url.pathname)) return false;
  return !/\.[a-z0-9]{2,5}$/i.test(url.pathname) || url.pathname.endsWith('.html');
}

async function readSitemap(context: BrowserContext): Promise<string[]> {
  const response = await context.request.get(`${BASE_URL}/sitemap.xml`);
  if (!response.ok()) {
    note({
      severity: 'high',
      area: 'origin',
      message: `sitemap.xml returned ${response.status()}`,
    });
    return [];
  }
  const xml = await response.text();
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(
    (match) => new URL(match[1]).pathname,
  );
}

/**
 * Visit every page at each profile. The first profile also discovers pages:
 * any same-origin page link not already queued is added and visited in turn.
 */
async function pagesPhase(browser: Browser): Promise<void> {
  const [first, ...rest] = activeProfiles;
  if (!first) return;
  const { context, page } = await openContext(browser, first);
  try {
    const sitemap = await readSitemap(context);
    const queue = [...new Set([...sitemap.filter((entry) => entry !== APP_PATH), NOT_FOUND_PAGE])];
    say(`Pages: ${queue.length} from the sitemap; discovering more from links`);
    say(`Profile: ${first.name}`);
    for (let index = 0; index < queue.length; index++) {
      const capture = await capturePage(page, first, queue[index]);
      captures.push(capture);
      for (const link of capture.metrics?.links ?? []) {
        try {
          const url = new URL(link.href);
          if (!isPagePath(url)) continue;
          if (!queue.includes(url.pathname)) {
            queue.push(url.pathname);
            note({
              severity: 'low',
              area: 'seo',
              page: queue[index],
              message: `Linked page ${url.pathname} is not in sitemap.xml`,
            });
          }
        } catch {
          // Malformed hrefs are reported by the links phase.
        }
      }
      await persist();
    }
    pagePaths = queue;
    for (const missing of sitemap.filter((entry) => entry !== APP_PATH && !queue.includes(entry))) {
      pagePaths.push(missing);
    }
  } finally {
    await context.close();
  }
  for (const profile of rest) {
    say(`Profile: ${profile.name}`);
    const { context, page } = await openContext(browser, profile);
    try {
      for (const pagePath of pagePaths) {
        captures.push(await capturePage(page, profile, pagePath));
        await persist();
      }
    } finally {
      await context.close();
    }
  }
}

/** Head metadata with the editor's scripts blocked, so `/` reports its static head too. */
async function headPhase(browser: Browser): Promise<void> {
  // The editor's scripts are aborted here on purpose; keep those failures out
  // of the last page capture's events.
  sink = emptySink();
  const { context, page } = await openContext(browser, PROFILES[0]);
  await context.route(/\/(assets\/[^?]*\.js|src\/main\.tsx)(\?|$)/, (route) => route.abort());
  try {
    for (const pagePath of [APP_PATH, ...pagePaths]) {
      try {
        await page.goto(`${BASE_URL}${pagePath}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(NAME_SHIM);
        heads.set(pagePath, await page.evaluate(collectHead));
      } catch (error) {
        note({
          severity: 'medium',
          area: 'seo',
          page: pagePath,
          message: `Could not read head metadata: ${String(error).split('\n')[0]}`,
        });
      }
    }
  } finally {
    await context.close();
  }
}

async function keyboardPhase(browser: Browser): Promise<void> {
  for (const profile of PROFILES.filter((entry) =>
    ['desktop-light', 'desktop-dark'].includes(entry.name),
  )) {
    say(`Keyboard: ${profile.name}`);
    // The pages scroll smoothly; a focus stop read mid-scroll is still off
    // screen. Reduced motion makes the scroll that Tab triggers instant.
    const { context, page } = await openContext(browser, profile, { reducedMotion: true });
    try {
      for (const pagePath of pagePaths) {
        const result: KeyboardResult = {
          path: pagePath,
          profile: profile.name,
          firstStop: null,
          skipLinkVisible: null,
          skipLinkMovesFocus: null,
          stops: [],
          reachedEnd: false,
          screenshots: [],
        };
        try {
          await open(page, pagePath);
          await page.keyboard.press('Tab');
          await page.waitForTimeout(250);
          result.firstStop = await page.evaluate(focusState);
          result.screenshots.push(
            await shoot(page, `kbd-${slug(pagePath)}-${profile.name}-first-tab`),
          );
          if (result.firstStop.isSkipLink) {
            result.skipLinkVisible = result.firstStop.inViewport;
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);
            await page.keyboard.press('Tab');
            result.skipLinkMovesFocus = (await page.evaluate(focusState)).inMain;
          }
          await open(page, pagePath);
          let shotMissingIndicator = false;
          for (let index = 0; index < MAX_TAB_STOPS; index++) {
            await page.keyboard.press('Tab');
            const state = await page.evaluate(focusState);
            if (
              state.tag === 'BODY' ||
              (result.stops.length > 0 && state.key === result.stops[0].key)
            ) {
              result.reachedEnd = true;
              break;
            }
            result.stops.push(state);
            if ((!state.indicator || state.obscuredBy) && !shotMissingIndicator) {
              shotMissingIndicator = true;
              result.screenshots.push(
                await shoot(page, `kbd-${slug(pagePath)}-${profile.name}-stop-${index + 1}`),
              );
            }
          }
        } catch (error) {
          result.error = String(error).split('\n')[0].slice(0, 300);
        }
        keyboardResults.push(result);
        say(
          `  ${pagePath}: ${result.stops.length} stops, skip link ${result.firstStop?.isSkipLink ? 'yes' : 'no'}`,
        );
        await persist();
      }
    } finally {
      await context.close();
    }
  }
}

/**
 * Click every same-page fragment link and every button-like control. A
 * fragment link has landed when its target's top edge sits in the upper part
 * of the viewport after the scroll settles.
 */
async function interactionsPhase(browser: Browser): Promise<void> {
  for (const profile of PROFILES.filter((entry) =>
    ['desktop-light', 'phone-light'].includes(entry.name),
  )) {
    say(`Interactions: ${profile.name}`);
    const { context, page } = await openContext(browser, profile);
    try {
      for (const pagePath of pagePaths) {
        try {
          await open(page, pagePath);
        } catch {
          continue;
        }
        const fragments = await page.evaluate((current) => {
          return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="#"]'))
            .filter((anchor) => {
              const url = new URL(anchor.href);
              return (
                url.pathname === current &&
                url.hash.length > 1 &&
                !anchor.classList.contains('skip-link')
              );
            })
            .map((anchor) => ({
              hash: new URL(anchor.href).hash,
              text: (anchor.innerText || anchor.getAttribute('aria-label') || '')
                .trim()
                .slice(0, 60),
            }));
        }, new URL(page.url()).pathname);
        for (const fragment of fragments) {
          const result: InteractionResult = {
            path: pagePath,
            profile: profile.name,
            control: fragment.text,
            kind: 'fragment',
            hash: fragment.hash,
            screenshot: null,
          };
          try {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page
              .locator(`a[href$="${fragment.hash}"]`, { hasText: fragment.text })
              .first()
              .click();
            await page.waitForTimeout(900);
            const landing = await page.evaluate((hash) => {
              const target = document.getElementById(decodeURIComponent(hash.slice(1)));
              const top = target ? Math.round(target.getBoundingClientRect().top) : null;
              return { found: !!target, top, height: innerHeight, hash: location.hash };
            }, fragment.hash);
            result.targetFound = landing.found;
            result.targetTop = landing.top;
            result.landed =
              landing.found &&
              landing.top !== null &&
              landing.top >= -2 &&
              landing.top < landing.height * 0.5;
            result.screenshot = await shoot(
              page,
              `click-${slug(pagePath)}-${profile.name}-${fragment.hash}`,
            );
          } catch (error) {
            result.error = String(error).split('\n')[0].slice(0, 200);
          }
          interactions.push(result);
        }
        const controls = await page
          .locator(
            'main button, main summary, main [role="button"], main [role="tab"], header button',
          )
          .all();
        for (const control of controls) {
          if (!(await control.isVisible().catch(() => false))) continue;
          const label = ((await control.innerText().catch(() => '')) || 'control')
            .trim()
            .slice(0, 60);
          const result: InteractionResult = {
            path: pagePath,
            profile: profile.name,
            control: label,
            kind: 'control',
            screenshot: null,
          };
          try {
            const before = await page.screenshot();
            await control.click({ timeout: 5_000 });
            await page.waitForTimeout(500);
            result.changed = !before.equals(await page.screenshot());
            result.screenshot = await shoot(
              page,
              `click-${slug(pagePath)}-${profile.name}-${label}`,
            );
          } catch (error) {
            result.error = String(error).split('\n')[0].slice(0, 200);
          }
          interactions.push(result);
        }
        await persist();
      }
    } finally {
      await context.close();
    }
  }
}

const CHROME_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CHROME_WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX_WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const CHROME_LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

interface PlatformCase {
  name: string;
  userAgent: string;
  /** UA client hints; null emulates a browser without navigator.userAgentData. */
  hints: { platform: string; architecture: string; bitness: string; mobile: boolean } | null;
  navigatorPlatform: string;
  touchPoints: number;
  phone?: boolean;
  /** Installer file the hero button should point at; null means "no installer, explain why". */
  expect: RegExp | null;
  api?: 'cached' | 'live' | 'rate-limited' | 'unreachable' | 'slow';
}

const PLATFORM_CASES: PlatformCase[] = [
  {
    name: 'mac-apple-silicon-chrome',
    userAgent: CHROME_MAC_UA,
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: /mac-arm64\.dmg$/,
  },
  {
    name: 'mac-intel-chrome',
    userAgent: CHROME_MAC_UA,
    hints: { platform: 'macOS', architecture: 'x86', bitness: '64', mobile: false },
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: null,
  },
  {
    name: 'mac-safari',
    userAgent: SAFARI_MAC_UA,
    hints: null,
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: /mac-arm64\.dmg$/,
  },
  {
    name: 'windows-x64-chrome',
    userAgent: CHROME_WIN_UA,
    hints: { platform: 'Windows', architecture: 'x86', bitness: '64', mobile: false },
    navigatorPlatform: 'Win32',
    touchPoints: 0,
    expect: /win-x64\.exe$/,
  },
  {
    name: 'windows-arm64-chrome',
    userAgent: CHROME_WIN_UA,
    hints: { platform: 'Windows', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'Win32',
    touchPoints: 0,
    expect: /win-arm64\.exe$/,
  },
  {
    name: 'windows-firefox',
    userAgent: FIREFOX_WIN_UA,
    hints: null,
    navigatorPlatform: 'Win32',
    touchPoints: 0,
    expect: /win\.exe$/,
  },
  {
    name: 'linux-x64-chrome',
    userAgent: CHROME_LINUX_UA,
    hints: { platform: 'Linux', architecture: 'x86', bitness: '64', mobile: false },
    navigatorPlatform: 'Linux x86_64',
    touchPoints: 0,
    expect: /x86_64\.AppImage$/,
  },
  {
    name: 'linux-arm64-chrome',
    userAgent: CHROME_LINUX_UA,
    hints: { platform: 'Linux', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'Linux aarch64',
    touchPoints: 0,
    expect: /arm64\.AppImage$/,
  },
  {
    name: 'iphone-safari',
    userAgent: IPHONE_UA,
    hints: null,
    navigatorPlatform: 'iPhone',
    touchPoints: 5,
    phone: true,
    expect: null,
  },
  {
    name: 'ipad-safari',
    userAgent: SAFARI_MAC_UA,
    hints: null,
    navigatorPlatform: 'MacIntel',
    touchPoints: 5,
    expect: null,
  },
  {
    name: 'android-chrome',
    userAgent: ANDROID_UA,
    hints: { platform: 'Android', architecture: 'arm', bitness: '64', mobile: true },
    navigatorPlatform: 'Linux armv81',
    touchPoints: 5,
    phone: true,
    expect: null,
  },
  {
    name: 'api-live-mac',
    userAgent: CHROME_MAC_UA,
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: /mac-arm64\.dmg$/,
    api: 'live',
  },
  {
    name: 'api-rate-limited',
    userAgent: CHROME_MAC_UA,
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: null,
    api: 'rate-limited',
  },
  {
    name: 'api-unreachable',
    userAgent: CHROME_MAC_UA,
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: null,
    api: 'unreachable',
  },
  {
    name: 'api-slow',
    userAgent: CHROME_MAC_UA,
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64', mobile: false },
    navigatorPlatform: 'MacIntel',
    touchPoints: 0,
    expect: /mac-arm64\.dmg$/,
    api: 'slow',
  },
];

function platformScript(entry: PlatformCase): string {
  return `(() => {
    const hints = ${JSON.stringify(entry.hints)};
    const define = (name, value) =>
      Object.defineProperty(Navigator.prototype, name, { configurable: true, get: () => value });
    define('userAgentData', hints
      ? { platform: hints.platform, mobile: hints.mobile, brands: [],
          getHighEntropyValues: async () => ({ ...hints }) }
      : undefined);
    define('platform', ${JSON.stringify(entry.navigatorPlatform)});
    define('maxTouchPoints', ${entry.touchPoints});
  })();`;
}

async function downloadsPhase(browser: Browser): Promise<void> {
  if (!pagePaths.includes('/desktop/')) return;
  say('Downloads: /desktop/ per platform and API state');
  for (const entry of PLATFORM_CASES) {
    const api = entry.api ?? 'cached';
    const viewport = entry.phone
      ? { width: 390, height: 844, mobile: true, scale: 2 }
      : { width: 1440, height: 900, mobile: false, scale: 1 };
    const { context, page } = await openContext(
      browser,
      { ...viewport, theme: 'light' },
      { userAgent: entry.userAgent, initScript: platformScript(entry), cacheApi: api === 'cached' },
    );
    const scenario: DownloadScenario = {
      name: entry.name,
      expect: entry.expect ? entry.expect.source : null,
      label: null,
      sub: null,
      href: null,
      ariaLabel: null,
      detected: [],
      items: [],
      fallbackVisible: false,
      loadingVisible: false,
      version: null,
      screenshots: [],
    };
    try {
      if (api === 'rate-limited') {
        await context.route('https://api.github.com/**', (route) =>
          route.fulfill({
            status: 403,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*', 'x-ratelimit-remaining': '0' },
            body: JSON.stringify({ message: 'API rate limit exceeded' }),
          }),
        );
      } else if (api === 'unreachable') {
        await context.route('https://api.github.com/**', (route) =>
          route.abort('internetdisconnected'),
        );
      } else if (api === 'slow') {
        await context.route('https://api.github.com/**', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          const cached = apiCache.get(route.request().url());
          // The context may close before the delay ends; ignore that.
          await (
            cached
              ? route.fulfill({ status: cached.status, headers: cached.headers, body: cached.body })
              : route.continue()
          ).catch(() => undefined);
        });
      }
      sink = emptySink();
      await page.goto(`${BASE_URL}/desktop/`, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      if (api === 'slow') {
        await page.waitForTimeout(1_500);
        scenario.screenshots.push(await shoot(page, `downloads-${entry.name}-while-loading`));
        await page.locator('#downloads').scrollIntoViewIfNeeded();
        scenario.screenshots.push(await shoot(page, `downloads-${entry.name}-grid-while-loading`));
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page
        .locator('[data-dl-loading]')
        .waitFor({ state: 'detached', timeout: DOWNLOADS_TIMEOUT })
        .catch(() => undefined);
      const state = await page.evaluate(() => {
        const button = document.querySelector<HTMLAnchorElement>('[data-dl-primary]');
        const fallback = document.querySelector<HTMLElement>('[data-dl-fallback]');
        const loading = document.querySelector('[data-dl-loading]');
        return {
          label: document.querySelector('[data-dl-label]')?.textContent?.trim() ?? null,
          sub: document.querySelector('[data-dl-sub]')?.textContent?.trim() ?? null,
          href: button?.href ?? null,
          ariaLabel: button?.getAttribute('aria-label') ?? null,
          detected: Array.from(document.querySelectorAll('.dl-item.is-detected')).map(
            (item) => item.getAttribute('aria-label') ?? '',
          ),
          items: Array.from(document.querySelectorAll<HTMLAnchorElement>('.dl-item')).map(
            (item) => ({
              label: item.getAttribute('aria-label') ?? item.innerText,
              href: item.href,
              size: item.querySelector('.dl-item__meta')?.textContent?.trim() ?? '',
            }),
          ),
          fallbackVisible:
            !!fallback && !fallback.hidden && fallback.getBoundingClientRect().height > 0,
          loadingVisible: !!loading,
          version: document.querySelector('[data-dl-version]')?.textContent?.trim() ?? null,
        };
      });
      Object.assign(scenario, state);
      scenario.screenshots.push(await shoot(page, `downloads-${entry.name}-hero`));
      const section = page.locator('#downloads');
      await section.scrollIntoViewIfNeeded();
      shotCounter += 1;
      const sectionShot = `${String(shotCounter).padStart(3, '0')}-downloads-${slug(entry.name)}-grid.png`;
      await section.screenshot({ path: path.join(OUT_DIR, sectionShot), animations: 'disabled' });
      scenario.screenshots.push(sectionShot);
    } catch (error) {
      scenario.error = String(error).split('\n')[0].slice(0, 300);
    } finally {
      await context.close();
    }
    downloadScenarios.push(scenario);
    say(`  ${entry.name}: ${scenario.label ?? '—'} → ${scenario.href ?? '—'}`);
    await persist();
  }

  // Every installer the grid offered must actually download. A one-byte range
  // request proves the redirect chain resolves without pulling a gigabyte.
  const hrefs = new Set<string>();
  for (const scenario of downloadScenarios) {
    for (const item of scenario.items) hrefs.add(item.href);
    if (scenario.href && /\/releases\/download\//.test(scenario.href)) hrefs.add(scenario.href);
  }
  for (const href of hrefs) {
    try {
      const response = await fetch(href, {
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const range = response.headers.get('content-range');
      const total = range
        ? Number(range.split('/')[1])
        : Number(response.headers.get('content-length'));
      await response.body?.cancel();
      installerChecks.push({
        href,
        status: response.status,
        bytes: Number.isFinite(total) ? total : null,
      });
    } catch (error) {
      installerChecks.push({ href, status: String(error).slice(0, 120), bytes: null });
    }
  }
  await persist();
}

async function checkUrl(href: string): Promise<{ status: number | string; finalUrl?: string }> {
  try {
    const response = await fetch(href, {
      method: 'GET',
      headers: { Range: 'bytes=0-2047', 'User-Agent': 'Mozilla/5.0 (DocBlocks pages crawl)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    return { status: response.status, finalUrl: response.url };
  } catch (error) {
    return { status: String(error).split('\n')[0].slice(0, 120) };
  }
}

async function linksPhase(): Promise<void> {
  say('Links');
  const primary = captures.filter((capture) => capture.profile === activeProfiles[0]?.name);
  const idsByPath = new Map(
    primary.map((capture) => [capture.path, new Set(capture.metrics?.ids ?? [])]),
  );
  const statusByPath = new Map(primary.map((capture) => [capture.path, capture.status]));
  const collected = new Map<
    string,
    { sources: Set<string>; texts: Set<string>; refs: LinkRef[] }
  >();
  for (const capture of primary) {
    for (const link of capture.metrics?.links ?? []) {
      const entry = collected.get(link.href) ?? { sources: new Set(), texts: new Set(), refs: [] };
      entry.sources.add(capture.path);
      if (link.text) entry.texts.add(link.text);
      entry.refs.push(link);
      collected.set(link.href, entry);
      if (link.target === '_blank' && !/noopener|noreferrer/.test(link.rel ?? '')) {
        note({
          severity: 'low',
          area: 'links',
          page: capture.path,
          message: `target="_blank" without rel="noopener": ${link.href}`,
        });
      }
    }
  }
  for (const [href, entry] of collected) {
    const check: LinkCheck = {
      href,
      sources: [...entry.sources],
      texts: [...entry.texts].slice(0, 4),
      kind: 'other',
      status: null,
    };
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      check.note = 'unparseable href';
    }
    if (url && /^https?:$/.test(url.protocol)) {
      if (url.origin === BASE.origin) {
        check.kind = url.hash.length > 1 ? 'fragment' : 'internal';
        const known = statusByPath.get(url.pathname);
        check.status = known ?? (await checkUrl(`${url.origin}${url.pathname}`)).status;
        if (url.hash.length > 1) {
          const ids = idsByPath.get(url.pathname);
          const id = decodeURIComponent(url.hash.slice(1));
          if (ids && !ids.has(id)) check.note = `no element with id="${id}" on ${url.pathname}`;
          if (!ids && url.pathname !== APP_PATH) check.note = `fragment on an uncaptured page`;
        }
      } else {
        check.kind = 'external';
        const result = await checkUrl(href);
        check.status = result.status;
        check.finalUrl = result.finalUrl;
        if (url.protocol === 'http:') check.note = 'insecure http link';
      }
    } else if (url) {
      check.status = url.protocol.replace(':', '');
    }
    linkChecks.push(check);
  }
  say(`  ${linkChecks.length} unique links`);
  await persist();
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function fetchBytes(
  url: string,
): Promise<{ status: number; type: string; bytes: Uint8Array }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

function certificate(host: string): Promise<{ validTo: string; daysLeft: number; issuer: string }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const peer = socket.getPeerCertificate();
      socket.end();
      const validTo = new Date(peer.valid_to);
      resolve({
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
        issuer: String(peer.issuer?.O ?? peer.issuer?.CN ?? ''),
      });
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TLS handshake timed out'));
    });
  });
}

async function originPhase(): Promise<void> {
  say('Origin');
  const record = (name: string, url: string, ok: boolean, detail: unknown): void => {
    originChecks.push({ name, url, ok, detail });
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  };
  const manual = async (url: string) => {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    return { status: response.status, location: response.headers.get('location') };
  };
  const attempt = async (name: string, url: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      record(name, url, false, String(error).split('\n')[0]);
    }
  };

  await attempt('missing page returns 404', `${BASE_URL}${MISSING_PATH}`, async () => {
    const result = await manual(`${BASE_URL}${MISSING_PATH}`);
    record('missing page returns 404', `${BASE_URL}${MISSING_PATH}`, result.status === 404, result);
  });
  await attempt('slashless page redirects', `${BASE_URL}/desktop`, async () => {
    const result = await manual(`${BASE_URL}/desktop`);
    const ok =
      result.status >= 300 && result.status < 400 && /\/desktop\/$/.test(result.location ?? '');
    record('slashless page redirects', `${BASE_URL}/desktop`, ok, result);
  });
  await attempt('robots.txt', `${BASE_URL}/robots.txt`, async () => {
    const result = await fetchBytes(`${BASE_URL}/robots.txt`);
    const text = new TextDecoder().decode(result.bytes);
    record(
      'robots.txt',
      `${BASE_URL}/robots.txt`,
      result.status === 200 && /sitemap:/i.test(text),
      {
        status: result.status,
        text,
      },
    );
  });
  for (const [name, asset, size] of [
    ['social image', '/og.png', { width: 1200, height: 630 }],
    ['favicon', '/favicon.png', null],
    ['apple touch icon', '/icons/apple-touch-icon.png', { width: 180, height: 180 }],
  ] as const) {
    await attempt(name, `${BASE_URL}${asset}`, async () => {
      const result = await fetchBytes(`${BASE_URL}${asset}`);
      const dimensions = pngSize(result.bytes);
      const ok =
        result.status === 200 &&
        !!dimensions &&
        (!size || (dimensions.width === size.width && dimensions.height === size.height));
      record(name, `${BASE_URL}${asset}`, ok, {
        status: result.status,
        type: result.type,
        kb: Math.round(result.bytes.length / 1024),
        dimensions,
        expected: size,
      });
    });
  }
  await attempt('web manifest', `${BASE_URL}/`, async () => {
    const html = new TextDecoder().decode((await fetchBytes(`${BASE_URL}/`)).bytes);
    const href =
      html.match(/<link[^>]+rel="manifest"[^>]*href="([^"]+)"/)?.[1] ??
      html.match(/<link[^>]+href="([^"]+)"[^>]*rel="manifest"/)?.[1];
    if (!href) {
      record('web manifest', `${BASE_URL}/`, false, 'no <link rel="manifest"> in the served HTML');
      return;
    }
    const manifestUrl = new URL(href, `${BASE_URL}/`).href;
    const manifest = JSON.parse(
      new TextDecoder().decode((await fetchBytes(manifestUrl)).bytes),
    ) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src: string; sizes?: string; purpose?: string }>;
    };
    const icons: Array<Record<string, unknown>> = [];
    for (const icon of manifest.icons ?? []) {
      const result = await fetchBytes(new URL(icon.src, manifestUrl).href);
      const dimensions = pngSize(result.bytes);
      const declared = icon.sizes?.split(' ')[0];
      icons.push({
        src: icon.src,
        sizes: icon.sizes,
        purpose: icon.purpose,
        status: result.status,
        dimensions,
        matches:
          !declared || !dimensions || declared === `${dimensions.width}x${dimensions.height}`,
      });
    }
    const ok =
      !!manifest.name &&
      !!manifest.start_url &&
      icons.length > 0 &&
      icons.every((icon) => icon.status === 200 && icon.matches);
    record('web manifest', manifestUrl, ok, { ...manifest, icons });
  });
  if (LIVE) {
    await attempt('http redirects to https', `http://${BASE.host}/`, async () => {
      const result = await manual(`http://${BASE.host}/`);
      const ok =
        result.status >= 300 &&
        result.status < 400 &&
        (result.location ?? '').startsWith('https://');
      record('http redirects to https', `http://${BASE.host}/`, ok, result);
    });
    await attempt('www redirects to apex', `https://www.${BASE.host}/`, async () => {
      const result = await manual(`https://www.${BASE.host}/`);
      const ok =
        result.status >= 300 &&
        result.status < 400 &&
        (result.location ?? '').startsWith(`https://${BASE.host}`);
      record('www redirects to apex', `https://www.${BASE.host}/`, ok, result);
    });
    await attempt('certificate', `https://${BASE.host}/`, async () => {
      const result = await certificate(BASE.hostname);
      record('certificate', `https://${BASE.host}/`, result.daysLeft > 21, result);
    });
    await attempt('response headers', `${BASE_URL}/`, async () => {
      const response = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(20_000) });
      await response.body?.cancel();
      const headers = Object.fromEntries(
        [
          'strict-transport-security',
          'content-security-policy',
          'x-content-type-options',
          'cache-control',
          'server',
        ].map((name) => [name, response.headers.get(name)]),
      );
      record('response headers', `${BASE_URL}/`, true, headers);
    });
  }
  await persist();
}

// ---------------------------------------------------------------------------
// Assessment: turn the evidence into a triage list.
// ---------------------------------------------------------------------------

function assess(): void {
  for (const capture of captures) {
    const where = {
      page: capture.path,
      profile: capture.profile,
      screenshot: capture.fold ?? undefined,
    };
    const expected = capture.path === NOT_FOUND_PAGE ? NOT_FOUND_STATUS : 200;
    if (capture.error) {
      note({
        severity: 'high',
        area: 'load',
        ...where,
        message: `Capture failed: ${capture.error}`,
      });
    }
    if (capture.status !== null && capture.status !== expected) {
      note({
        severity: 'high',
        area: 'load',
        ...where,
        message: `HTTP ${capture.status}, expected ${expected}`,
      });
    }
    for (const error of capture.events.pageErrors) {
      note({ severity: 'high', area: 'script', ...where, message: `Uncaught error: ${error}` });
    }
    for (const line of capture.events.console) {
      const csp = /Content Security Policy|Refused to/i.test(line);
      note({
        severity: csp ? 'high' : 'medium',
        area: csp ? 'csp' : 'console',
        ...where,
        message: line,
      });
    }
    for (const failure of capture.events.failedRequests) {
      note({
        severity: 'medium',
        area: 'network',
        ...where,
        message: `Request failed: ${failure}`,
      });
    }
    const metrics = capture.metrics;
    if (!metrics) continue;
    const phone = capture.profile.includes('phone') || capture.profile === 'tablet';
    if (metrics.scrollWidth > metrics.viewportWidth + 1 || metrics.overflow.length > 0) {
      note({
        severity: phone ? 'high' : 'medium',
        area: 'layout',
        ...where,
        message: `Horizontal overflow: page is ${metrics.scrollWidth}px wide in a ${metrics.viewportWidth}px viewport`,
        evidence: metrics.overflow,
      });
    }
    for (const clipped of metrics.clipped) {
      note({
        severity: 'medium',
        area: 'layout',
        ...where,
        message: `Content clipped: ${clipped.selector} shows ${clipped.clientWidth}px of ${clipped.scrollWidth}px`,
        evidence: clipped,
      });
    }
    for (const scroller of metrics.scrollers) {
      if (scroller.selector.includes('table-wrap')) continue;
      note({
        severity: 'low',
        area: 'layout',
        ...where,
        message: `Scrolls sideways: ${scroller.selector} (${scroller.clientWidth}px box, ${scroller.scrollWidth}px content)`,
      });
    }
    for (const image of metrics.brokenImages) {
      note({ severity: 'high', area: 'images', ...where, message: `Broken image ${image}` });
    }
    for (const image of metrics.missingAlt) {
      note({
        severity: 'medium',
        area: 'images',
        ...where,
        message: `Image without alt: ${image}`,
      });
    }
    for (const image of metrics.upscaledImages) {
      note({
        severity: 'low',
        area: 'images',
        ...where,
        message: `Upscaled image ${image.src}: ${image.natural}px source drawn at ${image.needed}px`,
      });
    }
    if (metrics.smallTargets.length > 0) {
      note({
        severity: 'medium',
        area: 'touch',
        ...where,
        message: `${metrics.smallTargets.length} tap targets under ${MIN_TARGET_PX}px`,
        evidence: metrics.smallTargets,
      });
    }
    if (metrics.tinyText.length > 0) {
      note({
        severity: 'low',
        area: 'type',
        ...where,
        message: `${metrics.tinyText.length} text runs under ${MIN_TEXT_PX}px`,
        evidence: metrics.tinyText,
      });
    }
    if (metrics.layoutShift > 0.1) {
      note({
        severity: 'medium',
        area: 'performance',
        ...where,
        message: `Cumulative layout shift ${metrics.layoutShift} (over 0.1)`,
        evidence: metrics.layoutShiftSources,
      });
    }
    if (capture.profile.endsWith('dark')) {
      if (metrics.bodyLuminance > 0.4) {
        note({
          severity: 'medium',
          area: 'theme',
          ...where,
          message: `Dark profile renders a light page (body ${metrics.bodyBackground})`,
        });
      }
      if (metrics.brandImage && !/dark/.test(metrics.brandImage)) {
        note({
          severity: 'low',
          area: 'theme',
          ...where,
          message: `Dark profile shows the light logo`,
        });
      }
    }
    if (capture.path !== NOT_FOUND_PAGE && capture.profile === activeProfiles[0]?.name) {
      const current = metrics.navCurrent;
      if (current.length !== 1 || new URL(current[0] ?? '', BASE_URL).pathname !== capture.path) {
        if (metrics.links.some((link) => new URL(link.href).pathname === capture.path)) {
          note({
            severity: 'low',
            area: 'navigation',
            ...where,
            message: `Primary nav marks ${JSON.stringify(current)} as current`,
          });
        }
      }
      let previous = 0;
      for (const heading of metrics.headings) {
        if (previous && heading.level > previous + 1) {
          note({
            severity: 'low',
            area: 'a11y',
            ...where,
            message: `Heading level skips from h${previous} to h${heading.level} at “${heading.text}”`,
          });
        }
        previous = heading.level;
      }
    }
    for (const violation of capture.axe?.violations ?? []) {
      note({
        severity:
          violation.impact === 'critical' || violation.impact === 'serious' ? 'medium' : 'low',
        area: 'a11y',
        ...where,
        message: `axe ${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes} node(s)`,
        evidence: violation.targets,
      });
    }
  }

  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  for (const [pagePath, head] of heads) {
    const page = pagePath;
    const missing = pagePath === NOT_FOUND_PAGE;
    titles.set(head.title, [...(titles.get(head.title) ?? []), pagePath]);
    if (head.description) {
      descriptions.set(head.description, [...(descriptions.get(head.description) ?? []), pagePath]);
    }
    if (!head.title) note({ severity: 'high', area: 'seo', page, message: 'Missing <title>' });
    else if (head.title.length > 65) {
      note({
        severity: 'low',
        area: 'seo',
        page,
        message: `Title is ${head.title.length} characters; search results truncate near 60`,
      });
    }
    if (!head.lang)
      note({ severity: 'medium', area: 'a11y', page, message: 'Missing <html lang>' });
    if (missing) {
      if (!/noindex/.test(head.robots ?? '')) {
        note({ severity: 'low', area: 'seo', page, message: 'Not-found page is indexable' });
      }
      continue;
    }
    if (/noindex/.test(head.robots ?? '')) {
      note({ severity: 'high', area: 'seo', page, message: `robots meta is "${head.robots}"` });
    }
    if (!head.description)
      note({ severity: 'medium', area: 'seo', page, message: 'Missing meta description' });
    else if (head.description.length > 165 || head.description.length < 70) {
      note({
        severity: 'low',
        area: 'seo',
        page,
        message: `Meta description is ${head.description.length} characters (aim for 70–160)`,
      });
    }
    if (!head.canonical)
      note({ severity: 'medium', area: 'seo', page, message: 'Missing canonical link' });
    else {
      const canonical = new URL(head.canonical, BASE_URL);
      if (canonical.pathname !== pagePath) {
        note({
          severity: 'medium',
          area: 'seo',
          page,
          message: `Canonical points at ${head.canonical}`,
        });
      }
      if (canonical.origin !== PRODUCTION_ORIGIN) {
        note({
          severity: 'medium',
          area: 'seo',
          page,
          message: `Canonical origin is ${canonical.origin}`,
        });
      }
      if (head.ogUrl && head.ogUrl !== head.canonical) {
        note({
          severity: 'low',
          area: 'seo',
          page,
          message: `og:url ${head.ogUrl} differs from canonical`,
        });
      }
    }
    for (const [field, value] of [
      ['og:title', head.ogTitle],
      ['og:description', head.ogDescription],
      ['og:image', head.ogImage],
      ['og:image:alt', head.ogImageAlt],
      ['twitter:card', head.twitterCard],
    ] as const) {
      if (!value) {
        note({
          severity: field === 'og:image' ? 'medium' : 'low',
          area: 'social',
          page,
          message: `Missing ${field}`,
        });
      }
    }
    if (pagePath !== APP_PATH && head.h1.length !== 1) {
      note({ severity: 'medium', area: 'seo', page, message: `${head.h1.length} <h1> elements` });
    }
  }
  for (const [title, pages] of titles) {
    if (pages.length > 1)
      note({
        severity: 'low',
        area: 'seo',
        message: `Duplicate title “${title}” on ${pages.join(', ')}`,
      });
  }
  for (const [, pages] of descriptions) {
    if (pages.length > 1)
      note({
        severity: 'low',
        area: 'seo',
        message: `Duplicate description on ${pages.join(', ')}`,
      });
  }

  for (const result of keyboardResults) {
    const where = { page: result.path, profile: result.profile, screenshot: result.screenshots[0] };
    if (result.error) {
      note({
        severity: 'medium',
        area: 'keyboard',
        ...where,
        message: `Keyboard pass failed: ${result.error}`,
      });
      continue;
    }
    if (!result.firstStop?.isSkipLink) {
      note({
        severity: 'medium',
        area: 'keyboard',
        ...where,
        message: 'First Tab does not reach a skip link',
      });
    } else {
      if (!result.skipLinkVisible) {
        note({
          severity: 'medium',
          area: 'keyboard',
          ...where,
          message: 'Skip link stays off-screen when focused',
        });
      }
      if (result.skipLinkMovesFocus === false) {
        note({
          severity: 'medium',
          area: 'keyboard',
          ...where,
          message: 'Skip link does not move focus into <main>',
        });
      }
    }
    const unmarked = result.stops.filter((stop) => !stop.indicator);
    if (unmarked.length > 0) {
      note({
        severity: 'medium',
        area: 'keyboard',
        ...where,
        screenshot: result.screenshots[1] ?? where.screenshot,
        message: `${unmarked.length} of ${result.stops.length} focus stops show no outline or ring`,
        evidence: unmarked.map((stop) => `${stop.key} (${stop.outline})`).slice(0, 10),
      });
    }
    const covered = result.stops.filter((stop) => stop.obscuredBy);
    if (covered.length > 0) {
      note({
        severity: 'medium',
        area: 'keyboard',
        ...where,
        message: `${covered.length} focus stops are covered by another element`,
        evidence: covered.map((stop) => `${stop.key} under ${stop.obscuredBy}`).slice(0, 10),
      });
    }
    if (!result.reachedEnd) {
      note({
        severity: 'low',
        area: 'keyboard',
        ...where,
        message: `Tab order did not wrap within ${MAX_TAB_STOPS} stops`,
      });
    }
  }

  for (const result of interactions) {
    const where = {
      page: result.path,
      profile: result.profile,
      screenshot: result.screenshot ?? undefined,
    };
    if (result.error) {
      note({
        severity: 'medium',
        area: 'interaction',
        ...where,
        message: `Clicking “${result.control}” failed: ${result.error}`,
      });
    } else if (result.kind === 'fragment' && !result.targetFound) {
      note({
        severity: 'high',
        area: 'interaction',
        ...where,
        message: `“${result.control}” links to missing ${result.hash}`,
      });
    } else if (result.kind === 'fragment' && !result.landed) {
      note({
        severity: 'low',
        area: 'interaction',
        ...where,
        message: `“${result.control}” scrolled ${result.hash} to ${result.targetTop}px, not near the top`,
      });
    } else if (result.kind === 'control' && !result.changed) {
      note({
        severity: 'low',
        area: 'interaction',
        ...where,
        message: `“${result.control}” had no visible effect`,
      });
    }
  }

  for (const scenario of downloadScenarios) {
    const where = {
      page: '/desktop/',
      profile: scenario.name,
      screenshot: scenario.screenshots[0],
    };
    if (scenario.error) {
      note({
        severity: 'high',
        area: 'downloads',
        ...where,
        message: `Scenario failed: ${scenario.error}`,
      });
      continue;
    }
    if (scenario.loadingVisible) {
      note({
        severity: 'high',
        area: 'downloads',
        ...where,
        message: 'Download list never stopped loading',
      });
    }
    const expectation = PLATFORM_CASES.find((entry) => entry.name === scenario.name)?.expect;
    if (expectation && !expectation.test(scenario.href ?? '')) {
      note({
        severity: 'high',
        area: 'downloads',
        ...where,
        message: `Primary button points at ${scenario.href}, expected ${expectation.source}`,
      });
    }
    if (!expectation && /\/releases\/download\//.test(scenario.href ?? '')) {
      note({
        severity: 'high',
        area: 'downloads',
        ...where,
        message: `Primary button offers an installer this device cannot run: ${scenario.href}`,
      });
    }
    if (/api-(rate-limited|unreachable)/.test(scenario.name) && !scenario.fallbackVisible) {
      note({
        severity: 'high',
        area: 'downloads',
        ...where,
        message: 'API failure shows no fallback',
      });
    }
    if (scenario.ariaLabel && scenario.label) {
      const visible = scenario.label.toLowerCase();
      if (!scenario.ariaLabel.toLowerCase().includes(visible)) {
        note({
          severity: 'low',
          area: 'a11y',
          ...where,
          message: `Accessible name “${scenario.ariaLabel}” does not contain the visible label “${scenario.label}” (WCAG 2.5.3)`,
        });
      }
    }
  }
  // Intel Mac builds ended with 2.7.1, so the list rightly offers none. Sending
  // an Intel visitor to that list is the dead end; the hero has to say so.
  const intel = downloadScenarios.find((scenario) => scenario.name === 'mac-intel-chrome');
  if (intel && !intel.error && /#downloads$/.test(intel.href ?? '')) {
    note({
      severity: 'medium',
      area: 'downloads',
      page: '/desktop/',
      profile: intel.name,
      screenshot: intel.screenshots[0],
      message: `Intel Mac visitors see “${intel.label} · ${intel.sub}” and are sent to a list with no Intel Mac installer`,
    });
  }
  for (const installer of installerChecks) {
    if (installer.status !== 206 && installer.status !== 200) {
      note({
        severity: 'high',
        area: 'downloads',
        page: '/desktop/',
        message: `Installer did not resolve (${installer.status}): ${installer.href}`,
      });
    }
    if (installer.bytes && installer.bytes > 500e6) {
      note({
        severity: 'medium',
        area: 'downloads',
        page: '/desktop/',
        message: `${path.basename(new URL(installer.href).pathname)} is ${(installer.bytes / 1e9).toFixed(2)} GB`,
      });
    }
  }

  for (const check of linkChecks) {
    const page = check.sources.join(', ');
    if (check.note && check.kind === 'fragment') {
      note({ severity: 'high', area: 'links', page, message: `${check.href}: ${check.note}` });
    } else if (check.note) {
      note({ severity: 'low', area: 'links', page, message: `${check.href}: ${check.note}` });
    }
    if (typeof check.status === 'string' && /^https?$|^mailto$|^tel$/.test(check.status)) continue;
    const ok = typeof check.status === 'number' && check.status < 400;
    if (!ok && check.status !== null) {
      note({
        severity: check.kind === 'external' ? 'medium' : 'high',
        area: 'links',
        page,
        message: `${check.href} → ${check.status} (“${check.texts[0] ?? ''}”)`,
      });
    }
  }

  for (const check of originChecks) {
    if (check.ok) continue;
    note({
      severity: /https|certificate|404|manifest/.test(check.name) ? 'medium' : 'low',
      area: 'origin',
      message: `${check.name} failed`,
      evidence: check.detail,
    });
  }
}

// ---------------------------------------------------------------------------
// Contact sheet
// ---------------------------------------------------------------------------

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
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const findingRows = sorted
    .map(
      (finding) =>
        `<tr class="${finding.severity}"><td>${finding.severity}</td><td>${escapeHtml(finding.area)}</td><td>${escapeHtml(
          finding.page ?? '',
        )}</td><td>${escapeHtml(finding.profile ?? '')}</td><td>${escapeHtml(finding.message)}${
          finding.evidence
            ? `<details><summary>evidence</summary><pre>${escapeHtml(JSON.stringify(finding.evidence, null, 2))}</pre></details>`
            : ''
        }</td><td>${finding.screenshot ? `<a href="${finding.screenshot}">shot</a>` : ''}</td></tr>`,
    )
    .join('\n');
  const profileNames = activeProfiles.map((profile) => profile.name);
  const pageRows = pagePaths
    .map((pagePath) => {
      const cells = profileNames
        .map((name) => {
          const capture = captures.find(
            (entry) => entry.path === pagePath && entry.profile === name,
          );
          if (!capture?.fold) return '<td>—</td>';
          return `<td><a href="${capture.full ?? capture.fold}"><img loading="lazy" src="${capture.fold}"></a><br><small>${capture.status ?? ''}</small></td>`;
        })
        .join('');
      return `<tr><th>${escapeHtml(pagePath)}</th>${cells}</tr>`;
    })
    .join('\n');
  const downloadRows = downloadScenarios
    .map(
      (scenario) =>
        `<tr><td>${escapeHtml(scenario.name)}</td><td>${escapeHtml(`${scenario.label ?? ''} · ${scenario.sub ?? ''}`)}</td><td>${escapeHtml(
          scenario.href ?? '',
        )}</td><td>${scenario.fallbackVisible ? 'fallback' : ''}</td><td>${scenario.screenshots
          .map((shot) => `<a href="${shot}"><img loading="lazy" src="${shot}"></a>`)
          .join('')}</td></tr>`,
    )
    .join('\n');
  const counts = (['high', 'medium', 'low'] as const)
    .map(
      (severity) =>
        `${findings.filter((finding) => finding.severity === severity).length} ${severity}`,
    )
    .join(', ');
  await writeFile(
    path.join(OUT_DIR, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Pages crawl</title><style>
body{font:13px system-ui;margin:16px;background:#fafafa;color:#222}table{border-collapse:collapse;margin-bottom:24px}
td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}img{width:220px;display:block}
tr.high td:first-child{background:#f8c9c4}tr.medium td:first-child{background:#fbe3b0}tr.low td:first-child{background:#e8e8e8}
pre{white-space:pre-wrap;max-width:700px}
</style><h1>Pages crawl — ${escapeHtml(BASE_URL)}</h1><p>${pagePaths.length} pages × ${profileNames.length} profiles; findings: ${counts}.</p>
<h2>Findings</h2><table><tr><th>severity</th><th>area</th><th>page</th><th>profile</th><th>finding</th><th></th></tr>${findingRows}</table>
<h2>Pages</h2><table><tr><th></th>${profileNames.map((name) => `<th>${name}</th>`).join('')}</tr>${pageRows}</table>
<h2>Downloads</h2><table><tr><th>scenario</th><th>hero</th><th>href</th><th></th><th>screenshots</th></tr>${downloadRows}</table>
<h2>Origin</h2><pre>${escapeHtml(JSON.stringify(originChecks, null, 2))}</pre>`,
  );
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  say(`Pages crawl of ${BASE_URL} -> ${OUT_DIR}`);
  const browser = await chromium.launch();
  try {
    if (phaseEnabled('origin')) await originPhase();
    if (phaseEnabled('pages')) await pagesPhase(browser);
    if (pagePaths.length === 0) {
      const { context } = await openContext(browser, PROFILES[0]);
      pagePaths = [
        ...(await readSitemap(context)).filter((entry) => entry !== APP_PATH),
        NOT_FOUND_PAGE,
      ];
      await context.close();
    }
    await headPhase(browser);
    if (phaseEnabled('keyboard')) {
      sink = emptySink();
      await keyboardPhase(browser);
      flushPhaseEvents('keyboard');
    }
    if (phaseEnabled('interactions')) {
      sink = emptySink();
      await interactionsPhase(browser);
      flushPhaseEvents('interactions');
    }
    if (phaseEnabled('downloads')) await downloadsPhase(browser);
    if (phaseEnabled('links') && phaseEnabled('pages')) await linksPhase();
  } finally {
    assess();
    await persist();
    await writeFile(path.join(OUT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
    await writeIndex();
    await browser.close();
  }
  const high = findings.filter((finding) => finding.severity === 'high').length;
  say(
    `Done: ${pagePaths.length} pages, ${captures.length} captures, ${findings.length} findings (${high} high).`,
  );
  say(`Contact sheet: ${path.join(OUT_DIR, 'index.html')}`);
  if (high > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
