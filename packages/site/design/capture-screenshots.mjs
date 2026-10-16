/* global document, fetch, HTMLElement, localStorage */
/**
 * Capture the product screenshots the site ships: the marketing hero used on
 * the Web, Desktop and Docs pages, and the two PWA install-dialog screenshots
 * declared in the manifest (packages/site/vite.config.ts). Each opens the
 * welcome document in a fresh profile with the default Rust accent.
 *
 * Run from the repo root:  node packages/site/design/capture-screenshots.mjs
 * Starts its own site dev server on a spare port and stops it afterwards, so
 * a server already running on 5220 is left alone. Uses the Playwright
 * Chromium the E2E suites already install. The VS Code hero comes from
 * capture-vscode-screenshot.mjs beside this file.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DESIGN = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(DESIGN, '..');
const REPO = path.resolve(SITE, '../..');
const PORT = Number(process.env.DOCBLOCKS_CAPTURE_PORT ?? 5238);
const BASE_URL = `http://localhost:${PORT}/`;

/** Output, viewport, device scale, color scheme. Pixel sizes must match the manifest. */
const SHOTS = [
  {
    out: 'public/marketing/docblocks-editor.png',
    viewport: { width: 1280, height: 720 },
    scale: 1,
    theme: 'dark',
  },
  {
    out: 'public/screenshots/wide-editor.png',
    viewport: { width: 1920, height: 1080 },
    scale: 1,
    theme: 'light',
  },
  {
    out: 'public/screenshots/narrow-editor.png',
    viewport: { width: 360, height: 640 },
    scale: 2,
    theme: 'light',
    mobile: true,
  },
];

function startSite() {
  return spawn(
    process.execPath,
    [
      path.join(REPO, 'node_modules/vite/bin/vite.js'),
      '--port',
      String(PORT),
      '--strictPort',
      '--open',
      'false',
    ],
    { cwd: SITE, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
  );
}

async function waitForSite(server) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error('The site dev server exited before it was ready.');
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${BASE_URL}.`);
}

async function capture(browser, shot) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: shot.scale,
    colorScheme: shot.theme,
    isMobile: shot.mobile ?? false,
    hasTouch: shot.mobile ?? false,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem('docblocks:themePreference', theme);
    localStorage.setItem('docblocks:accentColor', 'rust');
  }, shot.theme);

  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // First run opens the welcome document as a slideshow: behind a "Start
  // writing" tip on wide screens, from a welcome card on a phone.
  const startWriting = page.locator('.db-welcome-gateway-cta');
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  await startWriting.or(tour).first().click({ timeout: 90_000 });
  await page.locator('.squisq-toolbar-view-tab', { hasText: 'Write' }).click();
  const editor = page.locator('.ProseMirror').first();
  await editor.waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  // Rest the selection in body text so no heading button shows as active,
  // let the preview rail render its slides and proofing settle, then drop
  // focus so no caret or focus ring lands in the shot.
  await editor.locator('p').first().click();
  await page.waitForTimeout(8_000);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(0, shot.viewport.height - 1);
  await page.waitForTimeout(500);

  const out = path.join(SITE, shot.out);
  await page.screenshot({ path: out });
  await context.close();
  return out;
}

const server = startSite();
try {
  await waitForSite(server);
  const browser = await chromium.launch();
  try {
    for (const shot of SHOTS) {
      process.stdout.write(`${path.relative(REPO, await capture(browser, shot))}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
