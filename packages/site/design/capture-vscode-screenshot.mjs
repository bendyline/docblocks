/* global document, fetch, HTMLElement, NodeFilter */
/**
 * Capture the VS Code marketing hero (public/marketing/docblocks-vscode.png):
 * a short Markdown file open in the DocBlocks editor inside VS Code for Web,
 * Light Modern theme, with the Explorer showing its folder.
 *
 * Run from the repo root after `npm run build:vscode`:
 *   node packages/site/design/capture-vscode-screenshot.mjs
 * Starts the same @vscode/test-web build the VS Code E2E suite pins, on a
 * spare port, against a throwaway "Product Docs" folder, and stops it after.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DESIGN = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DESIGN, '../../..');
const EXTENSION = path.join(REPO, 'packages/vscode');
const OUT = path.join(REPO, 'packages/site/public/marketing/docblocks-vscode.png');
const PORT = Number(process.env.DOCBLOCKS_CAPTURE_PORT ?? 3138);
const BASE_URL = `http://localhost:${PORT}/`;
// Keep in step with packages/vscode/e2e/global-setup.ts so the cached build is reused.
const VSCODE_WEB_COMMIT =
  process.env.VSCODE_TEST_WEB_COMMIT ?? 'e8a3eada3426fa6848c7494ebe2291702fef4a61';

const LAUNCH_PLAN = `# Launch plan

A clear plan, written in portable Markdown.

## What ships

One source for the web, desktop, VS Code, and automated publishing.

## Ready for review

- **Local-first editing** keeps the document under your control.
- **Visual and source views** support different ways of working.
- **Finished formats** turn the same source into documents, slides, and more.

> The document stays useful wherever the work moves.
`;

function startVscodeWeb(folder) {
  const testWebCli = createRequire(path.join(EXTENSION, 'package.json')).resolve(
    '@vscode/test-web/out/server/index.js',
  );
  return spawn(
    process.execPath,
    [
      testWebCli,
      '--quality=insiders',
      `--commit=${VSCODE_WEB_COMMIT}`,
      `--extensionDevelopmentPath=${EXTENSION}`,
      '--browser=none',
      '--host=localhost',
      `--port=${PORT}`,
      '--headless',
      `--testRunnerDataDir=${path.join(EXTENSION, 'e2e/.vscode-test-web')}`,
      folder,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true },
  );
}

async function waitForServer(server) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('VS Code for Web exited before it was ready.');
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${BASE_URL}.`);
}

/**
 * Poll `check` until it resolves true. Each attempt is capped, because a read
 * from a frame VS Code is still navigating can hang rather than reject.
 */
async function poll(check, what, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await Promise.race([check().catch(() => false), delay(2_000, false)])) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** The frame whose document contains `selector`, looked up afresh on each attempt. */
async function findFrame(page, selector, timeout) {
  let match;
  await poll(
    async () => {
      const frames = page.frames();
      const found = await Promise.all(
        frames.map((frame) =>
          Promise.race([
            frame.evaluate((s) => document.querySelector(s) !== null, selector).catch(() => false),
            delay(1_000, false),
          ]),
        ),
      );
      match = frames[found.indexOf(true)];
      return match !== undefined;
    },
    selector,
    timeout,
  );
  return match;
}

async function selectColorTheme(page, themeName) {
  await page.locator('.activitybar').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+K');
  await page.keyboard.press('Control+T');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ timeout: 10_000 });
  await input.fill(themeName);
  await page
    .locator('.quick-input-list .monaco-list-row', { hasText: themeName })
    .first()
    .waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
}

// test-web labels the folder it mounts "Test Files", so mount a parent and
// open the named subfolder through the workbench's `?folder=` parameter.
const scratch = mkdtempSync(path.join(tmpdir(), 'docblocks-capture-'));
mkdirSync(path.join(scratch, 'Product Docs'));
writeFileSync(path.join(scratch, 'Product Docs', 'launch-plan.md'), LAUNCH_PLAN);

const server = startVscodeWeb(scratch);
try {
  await waitForServer(server);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // DocBlocks only becomes the default Markdown editor once the workbench
    // has read the development extension's manifest.
    const manifest = page.waitForResponse(
      (response) => response.url().endsWith('/static/devextensions/package.json'),
      { timeout: 60_000 },
    );
    await page.goto(
      `${BASE_URL}?folder=${encodeURIComponent('vscode-test-web://mount/Product Docs')}`,
    );
    await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
    await page.locator('.activitybar').waitFor();
    await manifest;
    await selectColorTheme(page, 'Light Modern');

    // The DocBlocks editor runs in a webview: an iframe inside an iframe that
    // VS Code navigates and swaps while it loads. A Playwright locator that
    // reaches into those frames too early stays latched to a stale one, so
    // find the editor's frame afresh on each attempt and only read from it.
    const file = page.locator('.explorer-folders-view').getByText('launch-plan.md');
    let editor;
    for (let attempt = 1; !editor; attempt += 1) {
      await file.click();
      editor = await findFrame(page, '.ProseMirror', 15_000).catch(() => undefined);
      if (!editor) {
        if (attempt === 4) throw new Error('VS Code never opened launch-plan.md in DocBlocks.');
        // A click that still beats the editor's registration opens the text
        // editor instead. Close it and try again.
        await page.locator('.tabs-container .tab.active .tab-actions .action-label').click();
        await page.waitForTimeout(2_000);
      }
    }
    await editor.evaluate(() => document.fonts.ready);
    await poll(
      () =>
        editor.evaluate(() => {
          const status = document.querySelector('.squisq-proof-status')?.textContent ?? '';
          return status !== '' && !status.includes('…');
        }),
      'proofing',
    );
    await page.waitForTimeout(1_000);
    // Leave no caret or focus ring in the shot.
    await editor.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.mouse.move(640, 715);
    // Drop the harness's own labels, which a real VS Code window never shows.
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        node.nodeValue = node.nodeValue
          .replace('[Extension Development Host] ', '')
          .replace(' [Test Files]', '')
          .replace(/^(\s*)Test Files(\s*)$/u, '$1Product Docs$2');
      }
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: OUT });
    process.stdout.write(`${path.relative(REPO, OUT)}\n`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  rmSync(scratch, { recursive: true, force: true });
}
