/**
 * Rasterize the DocBlocks brand SVGs (written by make_brand.py) into every
 * PNG the surfaces ship, and render the OG card and macOS DMG background.
 *
 * Run from the repo root:  node packages/site/design/brand/render-brand.mjs
 * Uses the Playwright Chromium the E2E suites already install.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BRAND = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(BRAND, '../../../..');
const at = (relative) => path.join(REPO, relative);

const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const svg = (name) => dataUri(path.join(BRAND, name), 'image/svg+xml');

/** Square rasters: [source SVG, output, pixel size, scale of the art within the square]. */
const ICONS = [
  ['app-icon.svg', 'packages/site/public/favicon.png', 32, 1],
  ['app-icon.svg', 'packages/site/public/icons/pwa-192.png', 192, 1],
  ['app-icon.svg', 'packages/site/public/icons/pwa-512.png', 512, 1],
  ['app-icon-square.svg', 'packages/site/public/icons/apple-touch-icon.png', 180, 1],
  ['app-icon-maskable.svg', 'packages/site/public/icons/maskable-512.png', 512, 1],
  ['app-icon.svg', 'packages/vscode/resources/extension-icon.png', 512, 1],
  [
    'app-icon-square.svg',
    'packages/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
    1024,
    1,
  ],
  [
    'app-icon.svg',
    'packages/mobile/ios/App/App/Assets.xcassets/Splash.imageset/DocBlocks.png',
    1024,
    0.5,
  ],
  // Android insets this foreground by 18% per side; at 0.62 the D sits a
  // little under half the icon's height, inside the adaptive-icon safe zone.
  [
    'app-icon-glyph.svg',
    'packages/mobile/android/app/src/main/res/drawable-nodpi/docblocks_mark.png',
    1024,
    0.62,
  ],
  // Source art for packages/desktop/scripts/generate-icons.py.
  ['app-icon-glyph.svg', 'packages/site/design/brand/app-icon-glyph.png', 1024, 1],
];

const hanken = dataUri(at('packages/site/public/fonts/hanken-grotesk-400.woff2'), 'font/woff2');
const FONT_FACE = `@font-face{font-family:'Hanken Grotesk';font-weight:100 900;src:url(${hanken}) format('woff2')}`;

function ogCard() {
  return `<!doctype html><meta charset="utf-8"><style>${FONT_FACE}
    html,body{margin:0;width:1200px;height:630px;overflow:hidden}
    body{background:url(${dataUri(path.join(BRAND, 'og-paper.png'), 'image/png')}) 0 0/1200px 630px;
      color:#231f18;font-family:'Hanken Grotesk',sans-serif;position:relative}
    img{position:absolute;left:72px;top:62px;height:298px}
    h1{position:absolute;left:76px;top:388px;margin:0;font-size:55px;font-weight:800;letter-spacing:.01em;line-height:1}
    p{position:absolute;left:76px;top:470px;margin:0;font-size:29px;font-weight:500;line-height:1.5;color:#2a2419}
  </style>
  <img src="${svg('../../public/_res/siteimages/docblocks.svg')}" alt="">
  <h1>YOUR MARKDOWN CAN DO ANYTHING</h1>
  <p>Honest free open source to view, edit, and convert<br>text/markdown → slideshows, documents, tables, pages and more</p>`;
}

function dmgBackground() {
  // Finder draws the app and Applications icons at (130,175) and (410,175);
  // the arrow runs between them. Layout is in 1x points.
  return `<!doctype html><meta charset="utf-8"><style>${FONT_FACE}
    html,body{margin:0;width:540px;height:380px;overflow:hidden}
    body{position:relative;font-family:'Hanken Grotesk',sans-serif;
      background:radial-gradient(ellipse at 50% 45%,#fbf8f1 0%,#f6efe2 62%,#efe5d2 100%)}
    .b{position:absolute;background:#e9dcc4;opacity:.45}
    img{position:absolute;left:50%;top:16px;height:64px;transform:translateX(-50%)}
    p{position:absolute;left:0;right:0;top:86px;margin:0;text-align:center;font-size:21px;font-weight:500;color:#4a3826;letter-spacing:-.01em}
    svg{position:absolute;left:228px;top:157px}
  </style>
  <div class="b" style="left:0;top:0;width:38px;height:50px"></div>
  <div class="b" style="left:38px;top:20px;width:46px;height:28px"></div>
  <div class="b" style="right:0;top:0;width:56px;height:48px;border-bottom-left-radius:56px"></div>
  <div class="b" style="right:28px;top:48px;width:28px;height:26px"></div>
  <div class="b" style="left:0;bottom:0;width:52px;height:108px;border-top-right-radius:52px"></div>
  <div class="b" style="left:52px;bottom:18px;width:28px;height:40px"></div>
  <div class="b" style="right:0;bottom:0;width:54px;height:104px"></div>
  <div class="b" style="right:54px;bottom:12px;width:38px;height:44px"></div>
  <img src="${svg('../../public/_res/siteimages/docblocks.svg')}" alt="">
  <p>Drag DocBlocks to Applications</p>
  <svg width="84" height="36" viewBox="0 0 84 36" fill="none" stroke="#6b4a32" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 18h58" stroke-dasharray="8 6"/><path d="M64 4l16 14-16 14"/>
  </svg>`;
}

const browser = await chromium.launch();
try {
  for (const [source, output, size, scale] of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const inner = Math.round(size * scale);
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}body{width:${size}px;height:${size}px;display:grid;place-items:center}</style>` +
        `<img src="${svg(source)}" width="${inner}" height="${inner}">`,
    );
    await page.waitForLoadState('load');
    writeFileSync(at(output), await page.screenshot({ omitBackground: true }));
    process.stdout.write(`  wrote ${output} (${size}px)\n`);
    await page.close();
  }

  const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await og.setContent(ogCard());
  await og.evaluate(() => globalThis.document.fonts.ready);
  writeFileSync(at('packages/site/public/og.png'), await og.screenshot());
  process.stdout.write('  wrote packages/site/public/og.png\n');
  await og.close();

  for (const [scale, name] of [
    [1, 'dmg-background.png'],
    [2, 'dmg-background@2x.png'],
  ]) {
    const dmg = await browser.newPage({
      viewport: { width: 540, height: 380 },
      deviceScaleFactor: scale,
    });
    await dmg.setContent(dmgBackground());
    await dmg.evaluate(() => globalThis.document.fonts.ready);
    writeFileSync(at(`packages/desktop/resources/${name}`), await dmg.screenshot());
    process.stdout.write(`  wrote packages/desktop/resources/${name}\n`);
    await dmg.close();
  }
} finally {
  await browser.close();
}
