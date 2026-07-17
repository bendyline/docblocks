import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';
import { SITE_PRECACHE_EXTENSIONS } from '../../../scripts/site-precache-policy.js';

const SITE_ROOT = path.join(process.cwd(), 'packages', 'site');
const PUBLIC_ROOT = path.join(SITE_ROOT, 'public');
const MARKETING_ROUTES = [
  'web',
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

/** The `[...]` body of the custom worker's root navigation allowlist. */
function extractAllowlistSource(serviceWorker: string): string {
  const source = serviceWorker.match(/allowlist:\s*\[([^\]]*)\]/)?.[1];
  expect(source, 'NavigationRoute allowlist literal').to.be.a('string');
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
    expect(html).to.match(
      /\.db-seo-bootstrap-document\s*\{[^}]*width:\s*100%;[^}]*padding:\s*16px 24px 72px;/s,
    );
    expect(html).to.include('class="db-seo-bootstrap-toolbar-spacer"');
    expect(html).to.include('<path d="M8 10.5V1.75" />');
    expect(html).to.include('The site is fully loading.');
    expect(html).to.include('href="https://github.com/bendyline/docblocks/issues/new"');

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
    expect(bootstrap).to.include("globalThis.localStorage.getItem('docblocks:accentColor')");
    expect(bootstrap).to.include("'brown', 'green', 'blue', 'purple', 'maroon', 'orange', 'gray'");
    expect(bootstrap).to.include(
      'globalThis.document.documentElement.dataset.dbAccent = accentColor',
    );
    expect(bootstrap).to.include(
      'globalThis.document.documentElement.dataset.dbTheme = resolvedTheme',
    );
  });

  it('ships unique, indexable static product and policy pages', async () => {
    const titles = new Set<string>();
    for (const route of MARKETING_ROUTES) {
      const html = await read(`public/${route}/index.html`);
      expectIndexableDocument(html, `https://docblocks.com/${route}/`);
      expect(html).to.include('href="/"');
      expect(html).to.include('href="/web/"');
      expect(html.indexOf('href="/web/"')).to.be.lessThan(html.indexOf('href="/desktop/"'));
      expect(html, `${route} footer`).to.match(
        /DocBlocks is free open-source software in beta, by\s*<a href="https:\/\/bendyline\.com">Bendyline<\/a>\./,
      );
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

    expect(robots.replace(/\r\n?/gu, '\n')).to.equal(
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
    const [config, serviceWorker] = await Promise.all([
      read('vite.config.ts'),
      read('src/service-worker.ts'),
    ]);
    expect(config).to.include("appType: 'mpa'");
    expect(config).to.include("strategies: 'injectManifest'");
    expect(config).to.include('SITE_PRECACHE_GLOB');
    for (const extension of ['webmanifest', 'txt', 'xml', 'wasm']) {
      expect(SITE_PRECACHE_EXTENSIONS).to.include(extension);
    }
    expect(serviceWorker).to.include("createHandlerBoundToURL('index.html')");
    expect(serviceWorker).to.include("headers.set('Cross-Origin-Opener-Policy', 'same-origin')");
    expect(serviceWorker).to.include(
      "headers.set('Cross-Origin-Embedder-Policy', 'credentialless')",
    );

    const allowlist = parseRegexLiterals(extractAllowlistSource(serviceWorker));
    expect(allowlist.length, 'NavigationRoute allowlist entries').to.be.greaterThan(0);

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

  it('ships a one-time migration from the legacy catch-all navigation worker', async () => {
    const [config, serviceWorker, migration] = await Promise.all([
      read('vite.config.ts'),
      read('src/service-worker.ts'),
      read('public/pwa-route-migration.js'),
    ]);

    expect(config).to.include("filename: 'sw.ts'");
    expect(serviceWorker).to.include("serviceWorker.importScripts('pwa-route-migration.js')");
    expect(serviceWorker).to.include("type: 'SKIP_WAITING'");
    expect(serviceWorker).to.include('ServiceWorkerRuntime).skipWaiting()');
    expect(serviceWorker).not.to.include('clients.claim()');
    expect(migration).to.include('root-only-navigation-v1');
    expect(migration).to.include('self.skipWaiting()');
    expect(migration).to.include('self.clients.claim()');
    expect(migration).to.include("markerCacheName = 'docblocks-pwa-migrations'");
  });

  it('publishes separate copyable CLI installation and invocation commands', async () => {
    const html = await read('public/cli/index.html');
    expect(html).to.include('npm install -g @bendyline/docblocks-cli');
    expect(html).to.include('docblocks --help');
    expect(html).not.to.include('@bendyline/docblocks-cli docblocks --help');
  });

  it('publishes customer quick-start, recovery, version, and support guidance', async () => {
    const html = await read('public/docs/index.html');
    expect(html).to.include('id="quick-start"');
    expect(html).to.include('Backup browser docs frequently');
    expect(html).to.include('id="troubleshooting"');
    expect(html).to.include('A site page opens the editor');
    expect(html).to.include('About DocBlocks');
    expect(html).to.include('https://github.com/bendyline/docblocks/releases');
    expect(html).to.include('https://github.com/bendyline/docblocks/issues');
  });

  it('explains the Web value proposition, sandbox boundaries, and install path', async () => {
    const html = await read('public/web/index.html');

    expect(html).to.include('No account, installer, or server upload');
    expect(html).to.include('Browser storage is not a backup');
    expect(html).to.include('Folder support varies');
    expect(html).to.include('Install DocBlocks&hellip;');
    expect(html).to.include('href="/desktop/"');
  });
  it('ships dark-mode marketing surfaces with real product imagery', async () => {
    const [css, web, desktop, vscode, docs, editorImage, vscodeImage] = await Promise.all([
      read('public/marketing/marketing.css'),
      read('public/web/index.html'),
      read('public/desktop/index.html'),
      read('public/vscode/index.html'),
      read('public/docs/index.html'),
      stat(path.join(PUBLIC_ROOT, 'marketing', 'docblocks-editor.png')),
      stat(path.join(PUBLIC_ROOT, 'marketing', 'docblocks-vscode.png')),
    ]);

    expect(css).to.include('@media (prefers-color-scheme: dark)');
    expect(css).to.include('color-scheme: light dark');
    expect(web).to.include('/marketing/docblocks-editor.png');
    expect(desktop).to.include('/marketing/docblocks-editor.png');
    expect(vscode).to.include('/marketing/docblocks-vscode.png');
    expect(docs).to.include('/marketing/docblocks-editor.png');
    expect(editorImage.size).to.be.greaterThan(50_000);
    expect(vscodeImage.size).to.be.greaterThan(50_000);
  });

  it('uses the Bendyline typography on every shared marketing surface', async () => {
    const css = await read('public/marketing/marketing.css');

    expect(css).to.include("--font-main: 'Hanken Grotesk'");
    expect(css).to.include("--font-accent: 'PT Serif'");
    expect(css).to.include("src: url('/fonts/hanken-grotesk-400.woff2')");
    expect(css).to.include("src: url('/fonts/pt-serif-700.woff2')");
    expect(css).to.include('font-family: var(--font-main)');
    expect(css).to.include('font-family: var(--font-accent)');
    expect(css).to.include('font-size: clamp(2.5rem, 5vw, 4.5rem)');
  });

  it('resolves every manifest entry point through the navigation fallback', async () => {
    // Regression guard: workbox matches the allowlist against
    // `url.pathname + url.search`, so a root-only `/^\/$/` silently excludes
    // the "New document" shortcut's `/?action=new` — the jump-list entry then
    // hits the network and shows a browser error page offline. Any URL the
    // manifest advertises as an entry point has to survive the allowlist.
    const [config, serviceWorker] = await Promise.all([
      read('vite.config.ts'),
      read('src/service-worker.ts'),
    ]);
    const allowlist = parseRegexLiterals(extractAllowlistSource(serviceWorker));

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
