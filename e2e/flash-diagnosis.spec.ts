import { test, expect } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';

interface MutationRecordSummary {
  readonly t: number;
  readonly type: string;
  readonly target: string;
  readonly attribute: string | null;
  readonly added: string[];
  readonly removed: string[];
}

declare global {
  interface Window {
    __flashRecords?: MutationRecordSummary[];
  }
}

test('records what mutates in the explorer while typing', async ({ page }) => {
  await openInitializedSite(page);

  await page.evaluate(() => {
    const explorer = document.querySelector('.db-file-explorer');
    if (!explorer) throw new Error('no explorer');
    const start = performance.now();
    const describe = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return `text(${node.textContent?.slice(0, 40)})`;
      const el = node as Element;
      const path = el.getAttribute?.('data-path');
      return `${el.tagName?.toLowerCase()}.${el.className || ''}${path ? `[${path}]` : ''}`;
    };
    window.__flashRecords = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        window.__flashRecords!.push({
          t: Math.round(performance.now() - start),
          type: record.type,
          target: describe(record.target),
          attribute: record.attributeName,
          added: [...record.addedNodes].map(describe),
          removed: [...record.removedNodes].map(describe),
        });
      }
    });
    observer.observe(explorer, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });

  const writeTab = page.getByRole('tab', { name: 'Write' });
  if (await writeTab.isVisible()) await writeTab.click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 30_000 });
  await editor.click();
  for (let i = 0; i < 5; i += 1) {
    await editor.pressSequentially(`hello world ${i} `, { delay: 60 });
    await page.waitForTimeout(1200);
  }

  const records = await page.evaluate(() => window.__flashRecords ?? []);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(records, null, 1));
  expect(records.length).toBeGreaterThanOrEqual(0);
});
