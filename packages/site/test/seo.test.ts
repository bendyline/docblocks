import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';
import { SITE_PRECACHE_EXTENSIONS } from '../../../scripts/site-precache-policy.js';

const SITE_ROOT = path.join(process.cwd(), 'packages', 'site');
const PUBLIC_ROOT = path.join(SITE_ROOT, 'public');
const MARKETING_ROUTES = [
  'desktop',
  'vscode',
  'cli',
  'formats',
  'docs',
  'privacy',
  'terms',
] as const;

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(SITE_ROOT, relativePath), 'utf8');
}

/** The `[...]` body of the workbox `navigateFallbackAllowlist` option. */
function extractAllowlistSource(config: string): string {
  const source = config.match(/navigateFallbackAllowlist:\s*\[([^\]]*)\]/)?.[1];
  expect(source, 'navigateFallbackAllowlist literal').to.be.a('string');
  return source ?? '';
}

/** Rebuild the regex literals written in the config as real RegExp objects. */
function parseRegexLiterals(source: string): RegExp[] {
  return [...source.matchAll(/\/((?:[^/\\]|\\.)+)\/([gimsuy]*)/g)].map(
    ([, pattern, flags]) => new RegExp(pattern, flags),
  );
}

/** Quoted string values of a manifest key, e.g. `start_url` or `url`. */
function extractManifestValues(config: string, key: string): string[] {
  return [...config.matchAll(new RegExp(String.raw`\b${key}:\s*'([^']+)'`, 'g'))].map(
    ([, value]) => value,
  );
}

/**
 * Mirror of workbox's NavigationRoute matching: the allowlist regexes are
 * tested against the concatenated pathname and search, not the pathname
 * alone (workbox-routing/NavigationRoute.js).
 */
function matchesAllowlist(allowlist: RegExp[], url: string): boolean {
  const parsed = new URL(url, 'https://docblocks.com');
  const pathnameAndSearch = parsed.pathname + parsed.search;
  return allowlist.some((pattern) => pattern.test(pathnameAndSearch));
}

function expectIndexableDocument(html: string, canonicalUrl: string): void {
  expect(html).to.include('<html lang="en">');
  expect(html).to.match(/<title>[^<]+<\/title>/);
  expect(html).to.match(/<meta\s+name="description"/);
  expect(html).to.include('name="robots" content="index, follow, max-image-preview:large"');
  expect(html).to.include(`<link rel="canonical" href="${canonicalUrl}"`);
  expect(html).to.include(`property="og:url" content="${canonicalUrl}"`);
  expect(html).to.include('property="og:image" content="https://docblocks.com/og.png"');
  expect(html).to.include('name="twitter:card" content="summary_large_image"');
  expect(html).to.match(/<main(?:\s|>)/);
  expect(html).to.match(/<h1(?:\s|>)/);
}

describe('site SEO surface', () => {
  it('ships stable root metadata, structured data, and crawlable bootstrap content', async () => {
    const html = await read('index.html');
    expectIndexableDocument(html, 'https://docblocks.com/');
    expect(html).to.include('<title>DocBlocks — Local-First Markdown Editor</title>');
    expect(html).to.include('<script type="application/ld+json">');
    expect(html).to.include('"@type": "SoftwareApplication"');
    expect(html).to.include('The Markdown editor that turns one file into anything.');
    expect(html).to.include('class="db-seo-bootstrap-sidebar"');
    expect(html).to.include('class="db-seo-bootstrap-toolbar"');
    expect(html).to.include('class="db-seo-bootstrap-document"');
    expect(html).to.include('<script src="/bootstrap-theme.js"></script>');
    expect(html).to.match(/\.db-seo-bootstrap h1\s*\{[^}]*font-size:\s*1rem;/s);

    const jsonLdText = html.match(
      /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
    )?.[1];
    expect(jsonLdText).to.be.a('string');
    expect(() => JSON.parse(jsonLdText ?? '')).not.to.throw();
  });

  it('matches the saved appearance before the React shell mounts', async () => {
    const bootstrap = await read('public/bootstrap-theme.js');
    expect(bootstrap).to.include("globalThis.localStorage.getItem('docblocks:themePreference')");
    expect(bootstrap).to.include("preference === 'light' || preference === 'dark'");
    expect(bootstrap).to.include(
      'globalThis.document.documentElement.dataset.dbTheme = preference',
    );
  });

  it('ships unique, indexable static product and policy pages', async () => {
    const titles = new Set<string>();
    for (const route of MARKETING_ROUTES) {
      const html = await read(`public/${route}/index.html`);
      expectIndexableDocument(html, `https://docblocks.com/${route}/`);
      expect(html).to.include('href="/"');
      const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
      expect(typeof title, `${route} title type`).to.equal('string');
      expect(title?.length ?? 0, `${route} title length`).to.be.greaterThan(0);
      titles.add(title ?? '');
    }
    expect(titles.size).to.equal(MARKETING_ROUTES.length);
  });

  it('publishes exact crawl files and omits app states from the sitemap', async () => {
    const robots = await read('public/robots.txt');
    const sitemap = await read('public/sitemap.xml');

    expect(robots).to.equal(
      'User-agent: *\nAllow: /\n\nSitemap: https://docblocks.com/sitemap.xml\n',
    );
    expect(sitemap).to.include('<loc>https://docblocks.com/</loc>');
    for (const route of MARKETING_ROUTES) {
      expect(sitemap).to.include(`<loc>https://docblocks.com/${route}/</loc>`);
    }
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locations.every((url) => !url.includes('#') && !url.includes('?'))).to.equal(true);
    expect(locations.some((url) => url.includes('/app/'))).to.equal(false);
  });

  it('keeps the service-worker fallback scoped to the root editor', async () => {
    const config = await read('vite.config.ts');
    expect(config).to.include("appType: 'mpa'");
    expect(config).to.include('SITE_PRECACHE_GLOB');
    for (const extension of ['webmanifest', 'txt', 'xml']) {
      expect(SITE_PRECACHE_EXTENSIONS).to.include(extension);
    }

    const allowlist = parseRegexLiterals(extractAllowlistSource(config));
    expect(allowlist.length, 'navigateFallbackAllowlist entries').to.be.greaterThan(0);

    // The root editor is the app shell and must fall back to index.html.
    expect(matchesAllowlist(allowlist, '/'), '/').to.equal(true);

    // Everything else owns its own precached response — the fallback must
    // never replace a static product page, a crawl file, or the custom 404.
    for (const route of MARKETING_ROUTES) {
      expect(matchesAllowlist(allowlist, `/${route}/`), `/${route}/`).to.equal(false);
    }
    for (const file of ['/robots.txt', '/sitemap.xml', '/404.html', '/og.png']) {
      expect(matchesAllowlist(allowlist, file), file).to.equal(false);
    }
  });

  it('resolves every manifest entry point through the navigation fallback', async () => {
    // Regression guard: workbox matches the allowlist against
    // `url.pathname + url.search`, so a root-only `/^\/$/` silently excludes
    // the "New document" shortcut's `/?action=new` — the jump-list entry then
    // hits the network and shows a browser error page offline. Any URL the
    // manifest advertises as an entry point has to survive the allowlist.
    const config = await read('vite.config.ts');
    const allowlist = parseRegexLiterals(extractAllowlistSource(config));

    const entryPoints = [
      ...extractManifestValues(config, 'start_url'),
      ...extractManifestValues(config, 'url'),
    ];
    expect(entryPoints, 'manifest entry points').to.include('/?action=new');

    for (const entryPoint of entryPoints) {
      expect(matchesAllowlist(allowlist, entryPoint), entryPoint).to.equal(true);
    }
  });

  it('lets interactive development fall forward while keeping the E2E port fixed', async () => {
    const [viteConfig, playwrightConfig] = await Promise.all([
      read('vite.config.ts'),
      readFile(path.join(process.cwd(), 'playwright.config.ts'), 'utf8'),
    ]);

    expect(viteConfig).to.include('port: 5220');
    expect(viteConfig).to.include('strictPort: false');
    expect(viteConfig).to.include("name: 'serve-static-directory-indexes'");
    for (const route of MARKETING_ROUTES) {
      expect(viteConfig).to.include(`'/${route}/'`);
    }
    expect(playwrightConfig).to.include('npm run dev -w docblocks-site -- --strictPort');
    expect(playwrightConfig).to.include("url: 'http://localhost:5220'");
  });

  it('ships a noindex custom 404 and a correctly sized social card', async () => {
    const notFound = await read('public/404.html');
    expect(notFound).to.include('name="robots" content="noindex, follow"');
    expect(notFound).to.include('Page not found — DocBlocks');

    const socialCardPath = path.join(PUBLIC_ROOT, 'og.png');
    const [socialCard, socialCardBytes] = await Promise.all([
      stat(socialCardPath),
      readFile(socialCardPath),
    ]);
    expect(socialCard.size).to.be.greaterThan(10_000);
    expect(socialCardBytes.readUInt32BE(16)).to.equal(1200);
    expect(socialCardBytes.readUInt32BE(20)).to.equal(630);
  });
});
