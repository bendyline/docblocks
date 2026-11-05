/**
 * Repeatable live/preview editor scale audit. Run separately from other crawls
 * so their browser CPU load does not distort typing measurements.
 *
 * LIVE_UX_BASE_URL=https://docblocks.com node --import tsx e2e/site-scale-review.ts reports/scale
 * Optional SCALE_SECTIONS=25,100,400 and SCALE_CPU_PROFILE=1 (Chromium profiles).
 * SCALE_INPUT=insertText retains the synthetic character-typing audit; the default
 * dispatches a clipboard paste through Monaco's paste handler without changing
 * the system clipboard. These are different input paths and must not be compared.
 * SCALE_KEY_DELAY_MS=250 exercises typing with pauses; SCALE_TARGET=body exercises
 * a paragraph. SCALE_SETTLE_MS=15000 lets cold proofing finish before timing.
 * Profiles add overhead: use unprofiled runs
 * for final numbers. Undo/redo, source fidelity and reload run after timing.
 * SCALE_EXPECT_OPTIMIZATIONS=1 additionally requires lazy previews and a live
 * parser worker for large documents; leave unset when measuring older releases.
 * Uses only disposable browser profiles.
 * Measures source insertion, switching to Write, and keyboard-to-frame latency;
 * saves screenshots and JSON even when a case fails. Not part of the test gate.
 */
import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectRuntimeErrors, unexpectedRuntimeErrors } from './helpers/console-guard.js';

const base = process.env.LIVE_UX_BASE_URL ?? 'http://127.0.0.1:5240';
const output = path.resolve(process.argv[2] ?? 'reports/site-scale-review');
const sizes = (process.env.SCALE_SECTIONS ?? '25,100,400').split(',').map(Number);
const inputMode = process.env.SCALE_INPUT ?? 'paste';
const expectOptimizations = process.env.SCALE_EXPECT_OPTIMIZATIONS === '1';
if (!['paste', 'insertText'].includes(inputMode)) throw new Error('Invalid SCALE_INPUT.');
const keyDelayMs = Number(process.env.SCALE_KEY_DELAY_MS ?? 0);
const settleMs = Number(process.env.SCALE_SETTLE_MS ?? 2000);
if (!Number.isFinite(settleMs) || settleMs < 0 || settleMs > 60_000) {
  throw new Error('SCALE_SETTLE_MS must be between 0 and 60000.');
}
if (!Number.isFinite(keyDelayMs) || keyDelayMs < 0 || keyDelayMs > 2000) {
  throw new Error('SCALE_KEY_DELAY_MS must be between 0 and 2000.');
}
const target = process.env.SCALE_TARGET ?? 'heading';
if (!['heading', 'body'].includes(target)) throw new Error('Invalid SCALE_TARGET.');
if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 1000)) {
  throw new Error('SCALE_SECTIONS must contain integers from 1 to 1000.');
}
const records: Array<Record<string, unknown>> = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const environment = {
  base,
  recordedAt: new Date().toISOString(),
  browser: browser.version(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
async function settleSelection(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
}
try {
  for (const sections of sizes) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const workerUrls: string[] = [];
    page.on('worker', (worker) => workerUrls.push(worker.url()));
    const profiler =
      process.env.SCALE_CPU_PROFILE === '1' ? await context.newCDPSession(page) : null;
    if (profiler) await profiler.send('Profiler.enable');
    const startProfile = async (): Promise<void> => {
      if (profiler) await profiler.send('Profiler.start');
    };
    const stopProfile = async (phase: string): Promise<void> => {
      if (!profiler) return;
      const { profile } = await profiler.send('Profiler.stop');
      await writeFile(
        path.join(output, `${sections}-${phase}.cpuprofile`),
        JSON.stringify(profile),
      );
    };
    page.setDefaultTimeout(45_000);
    const readErrors = collectRuntimeErrors(page);
    const record: Record<string, unknown> = {
      sections,
      inputMode,
      keyDelayMs,
      settleMs,
      target,
      cpuProfile: !!profiler,
      expectOptimizations,
      status: 'running',
    };
    records.push(record);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      await page.goto(base);
      await page.getByRole('button', { name: 'Tour the welcome document' }).click();
      await page.getByRole('button', { name: 'New File', exact: true }).click();
      const name = page.getByRole('textbox', { name: 'New file name' });
      await name.fill(`scale-${sections}.md`);
      await name.press('Enter');
      await expect(page.locator('.ProseMirror')).toHaveText('');
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.locator('.monaco-editor .view-lines').click();
      await page.keyboard.press('ControlOrMeta+A');
      const markdown =
        '# Scale review\n\n' +
        Array.from(
          { length: sections },
          (_, index) =>
            `## Section ${index + 1}\n\nParagraph ${index + 1} has **bold**, _italic_, and \`code\`. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n\n- First item\n- Second item`,
        ).join('\n\n');
      record.characters = markdown.length;
      record.words = markdown.split(/\s+/).length;
      process.stdout.write(`${sections}: inserting source\n`);
      await startProfile();
      let started = Date.now();
      if (inputMode === 'insertText') {
        await page.keyboard.insertText(markdown);
      } else {
        await page.evaluate((text) => {
          const data = new DataTransfer();
          data.setData('text/plain', text);
          document.activeElement?.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, markdown);
      }
      record.sourceInputMs = Date.now() - started;
      await stopProfile('source');
      started = Date.now();
      process.stdout.write(`${sections}: switching to Write\n`);
      await page.getByRole('tab', { name: 'Write', exact: true }).click();
      await page
        .locator('.ProseMirror h2')
        .nth(sections - 1)
        .waitFor();
      record.writeReadyMs = Date.now() - started;
      const editTarget = page
        .locator(target === 'heading' ? '.ProseMirror h1' : '.ProseMirror > p')
        .first();
      await editTarget.click();
      await page.keyboard.press('End');
      await settleSelection(page);
      await page.waitForTimeout(settleMs);
      record.proofingDecorationsBefore = await page.locator('.squisq-proof-underline').count();
      const originalText = await page.locator('.ProseMirror').innerText();
      const samples: number[] = [];
      process.stdout.write(`${sections}: timing 21 keystrokes\n`);
      await startProfile();
      for (let index = 0; index < 21; index++) {
        started = Date.now();
        await page.keyboard.type('x');
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        samples.push(Date.now() - started);
        if (keyDelayMs) await page.waitForTimeout(keyDelayMs);
      }
      await stopProfile('typing');
      record.firstKeyMs = samples[0];
      record.chronologicalSamples = [...samples];
      samples.sort((a, b) => a - b);
      record.samples = samples;
      record.medianMs = samples[10];
      record.p95Ms = samples[19];
      record.withinTypingBudget = samples[10] < 100;
      record.parserWorkerReady = (
        await Promise.all(
          page.workers().map(async (worker) => {
            try {
              return await worker.evaluate(
                () =>
                  globalThis.name === 'squisq-markdown-parser' &&
                  typeof globalThis.onmessage === 'function',
              );
            } catch {
              return false;
            }
          }),
        )
      ).some(Boolean);
      if (expectOptimizations && markdown.length >= 32_768) {
        expect(record.parserWorkerReady, 'the parser worker must start and stay alive').toBe(true);
      }
      record.statusText = await page.locator('.squisq-status-item').allInnerTexts();
      record.proofingDecorationsAfter = await page.locator('.squisq-proof-underline').count();
      await page.screenshot({
        path: path.join(output, `${sections}-sections.png`),
        animations: 'disabled',
      });
      const editedText = await page.locator('.ProseMirror').innerText();
      expect(editedText).not.toBe(originalText);
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.locator('.ProseMirror')).not.toHaveText(editedText);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => page.locator('.ProseMirror').innerText()).toBe(editedText);

      // Copy through Monaco's own handler without reading/writing the OS clipboard.
      await page.getByRole('tab', { name: 'Source', exact: true }).click();
      await page.locator('.monaco-editor .view-lines').click();
      await page.keyboard.press('ControlOrMeta+A');
      const savedSource = await page.evaluate(() => {
        const data = new DataTransfer();
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
        );
        return data.getData('text/plain').replace(/\r\n/g, '\n');
      });
      await writeFile(path.join(output, `${sections}-edited.md`), savedSource);
      if (inputMode === 'paste') {
        // The edited paragraph uses the Write serializer's emphasis convention;
        // source preservation keeps every untouched block byte-for-byte intact.
        const expectedSource =
          target === 'body' ? markdown.replace('_italic_', '*italic*') : markdown;
        expect(savedSource.replace('x'.repeat(21), '').trimEnd()).toBe(expectedSource.trimEnd());
      }
      await page.getByRole('tab', { name: 'Write', exact: true }).click();
      await expect(page.locator('.db-shell')).toHaveAttribute('data-document-status', 'saved');
      await page.reload();
      await expect.poll(() => page.locator('.ProseMirror').innerText()).toBe(editedText);
      record.fidelityUndoReload = 'passed';
      const previews = page.locator('.squisq-inline-preview-card-svg > svg');
      await expect(previews.first()).toBeVisible();
      if (expectOptimizations) await expect.poll(() => previews.count()).toBeLessThan(20);
      record.mountedPreviews = await previews.count();
      if (sections >= 25) {
        const firstPreview = await previews.first().getAttribute('data-block-id');
        await page
          .locator('.ProseMirror h2')
          .nth(Math.floor(sections / 2))
          .scrollIntoViewIfNeeded();
        await expect
          .poll(() => previews.first().getAttribute('data-block-id'))
          .not.toBe(firstPreview);
        await expect(previews.first()).toBeVisible();
        if (expectOptimizations) await expect.poll(() => previews.count()).toBeLessThan(20);
        record.mountedPreviewsAfterScroll = await previews.count();
        await page.screenshot({
          path: path.join(output, `${sections}-scrolled.png`),
          animations: 'disabled',
        });
        record.previewScrolling = 'passed';
      }
      const errors = unexpectedRuntimeErrors(readErrors());
      record.errors = errors;
      expect(errors).toEqual([]);
      record.status = 'completed';
    };
    try {
      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Case exceeded 180 seconds')), 180_000);
        }),
      ]);
    } catch (error) {
      record.status = 'failed';
      record.error = String(error);
    } finally {
      clearTimeout(deadline);
      record.errors = unexpectedRuntimeErrors(readErrors());
      record.workerUrls = workerUrls;
      await context.close();
      await writeFile(
        path.join(output, 'results.json'),
        JSON.stringify({ ...environment, records }, null, 2),
      );
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }
} finally {
  await browser.close();
}
if (
  records.some((record) => record.status !== 'completed' || record.withinTypingBudget === false)
) {
  process.exitCode = 1;
}
