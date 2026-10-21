/**
 * Regenerate the marketing product screenshot from the current build.
 *
 * `packages/site/public/marketing/docblocks-editor.png` is the editor image on
 * /web/, /desktop/, and /docs/. Captured by hand, it drifted: in October 2026 it
 * still showed the starter document from before it was renamed `Welcome.md`.
 * This captures the same frame — the welcome document in Write, dark theme,
 * file pane and slide previews visible — from a local production preview, so a
 * refresh is one command whenever the editor changes.
 *
 *   npm run capture:marketing-screenshot              # build, preview, capture
 *   npm run capture:marketing-screenshot -- --no-build
 *
 * packages/site/test/seo.test.ts pins the image at 1280×720 and under 500 KB.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sitePackageRoot = path.join(repoRoot, 'packages', 'site');
const output = path.join(sitePackageRoot, 'public', 'marketing', 'docblocks-editor.png');
/** Distinct from the dev server (5220), the crawl preview (5240), and the offline preview (5230). */
const PREVIEW_PORT = 5250;
const VIEWPORT = { width: 1280, height: 720 };
const MAX_BYTES = 500_000;
/** Proofing and the offline cache both settle in seconds locally; allow for a cold machine. */
const SETTLE_TIMEOUT = 120_000;

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) {
    say('Building the site…');
    await run('npm', ['run', 'build', '-w', 'docblocks-site']);
  }
  const server = await preview({
    root: sitePackageRoot,
    logLevel: 'warn',
    preview: { host: '127.0.0.1', port: PREVIEW_PORT, strictPort: true },
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      locale: 'en-US',
    });
    await context.addInitScript(() => {
      window.localStorage.setItem('docblocks:themePreference', 'dark');
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PREVIEW_PORT}/`);
    await page.locator('.db-welcome-gateway-cta').click({ timeout: SETTLE_TIMEOUT });
    await page.locator('.ProseMirror').first().waitFor({ timeout: SETTLE_TIMEOUT });

    // Transient status reads as unfinished in a marketing image: wait until
    // proofing is ready and the offline cache has finished installing.
    say('Waiting for proofing and the offline cache…');
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, {
      timeout: SETTLE_TIMEOUT,
    });
    await page.waitForFunction(
      () => {
        const text = Array.from(document.querySelectorAll('.squisq-status-item'))
          .map((item) => item.textContent ?? '')
          .join(' ');
        return text.includes('✓ Proofing') && !/Preparing offline|Offline unavailable/.test(text);
      },
      undefined,
      { timeout: SETTLE_TIMEOUT },
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Park the pointer off every control so no hover state or tooltip shows.
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: output, animations: 'disabled', caret: 'hide' });
    say(`Status bar: ${(await page.locator('.squisq-status-item').allInnerTexts()).join(' | ')}`);
  } finally {
    await browser.close();
    await server.close();
  }
  const { size } = await stat(output);
  say(`Wrote ${path.relative(repoRoot, output)} (${Math.round(size / 1024)} KB)`);
  if (size > MAX_BYTES) {
    throw new Error(`The screenshot is ${size} bytes; seo.test.ts allows ${MAX_BYTES}.`);
  }
}

await main();
