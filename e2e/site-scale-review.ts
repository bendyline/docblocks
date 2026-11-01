/**
 * Repeatable live/preview editor scale audit. Run separately from other crawls
 * so their browser CPU load does not distort typing measurements.
 *
 * LIVE_UX_BASE_URL=https://docblocks.com node --import tsx e2e/site-scale-review.ts reports/scale
 * Optional SCALE_SECTIONS=25,100,400. Uses only disposable browser profiles.
 * Measures source insertion, switching to Write, and keyboard-to-frame latency;
 * saves screenshots and JSON even when a case fails. Not part of the test gate.
 */
import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.LIVE_UX_BASE_URL ?? 'http://127.0.0.1:5240';
const output = path.resolve(process.argv[2] ?? 'reports/site-scale-review');
const sizes = (process.env.SCALE_SECTIONS ?? '25,100,400').split(',').map(Number);
if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 1000)) {
  throw new Error('SCALE_SECTIONS must contain integers from 1 to 1000.');
}
const records: Array<Record<string, unknown>> = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
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
    page.setDefaultTimeout(45_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const record: Record<string, unknown> = { sections, errors, status: 'running' };
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
      let started = Date.now();
      process.stdout.write(`${sections}: inserting source\n`);
      await page.keyboard.insertText(markdown);
      record.sourceInputMs = Date.now() - started;
      started = Date.now();
      process.stdout.write(`${sections}: switching to Write\n`);
      await page.getByRole('tab', { name: 'Write', exact: true }).click();
      await page
        .locator('.ProseMirror h2')
        .nth(sections - 1)
        .waitFor();
      record.writeReadyMs = Date.now() - started;
      await page.locator('.ProseMirror h1').click();
      await page.keyboard.press('End');
      await settleSelection(page);
      await page.waitForTimeout(2000);
      const samples: number[] = [];
      process.stdout.write(`${sections}: timing 21 keystrokes\n`);
      for (let index = 0; index < 21; index++) {
        started = Date.now();
        await page.keyboard.type('x');
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        samples.push(Date.now() - started);
      }
      samples.sort((a, b) => a - b);
      record.samples = samples;
      record.medianMs = samples[10];
      record.p95Ms = samples[19];
      record.withinTypingBudget = samples[10] < 100;
      record.statusText = await page.locator('.squisq-status-item').allInnerTexts();
      await page.screenshot({
        path: path.join(output, `${sections}-sections.png`),
        animations: 'disabled',
      });
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
      await context.close();
      await writeFile(
        path.join(output, 'results.json'),
        JSON.stringify({ base, records }, null, 2),
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
