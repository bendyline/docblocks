import { test, expect } from './fixtures.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

test('records what mutates in the desktop explorer while typing', async ({
  launchApp,
  workspaceDir,
}) => {
  fs.mkdirSync(path.join(workspaceDir, 'notes'), { recursive: true });
  for (let i = 0; i < 4; i += 1) {
    fs.writeFileSync(path.join(workspaceDir, `doc-${i}.md`), `# Doc ${i}\n\nbody\n`, 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'notes', `note-${i}.md`), `# Note ${i}\n`, 'utf8');
  }

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: workspaceDir, stdio: 'ignore' });
  };
  git('init');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('add', '.');
  git('commit', '-m', 'seed');

  const { window: page } = await launchApp();
  await page.waitForSelector('.db-shell', { timeout: 30_000 });
  await page.waitForSelector('.db-tree-row', { timeout: 30_000 });

  await page.evaluate(() => {
    const explorer = document.querySelector('.db-shell-sidebar') ?? document.querySelector('aside');
    if (!explorer) throw new Error('no sidebar');
    const start = performance.now();
    const describe = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return `text(${node.textContent?.slice(0, 40)})`;
      const el = node as Element;
      const p = el.getAttribute?.('data-path');
      return `${el.tagName?.toLowerCase()}.${el.className || ''}${p ? `[${p}]` : ''}`;
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

    const samples: string[] = [];
    (window as unknown as { __flashSamples: string[] }).__flashSamples = samples;
    const shifts = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        startTime: number;
        sources?: { node?: Element }[];
      }[]) {
        const where = (entry.sources ?? [])
          .map((source) => (source.node ? describe(source.node) : '?'))
          .join(' | ');
        samples.push(
          `t=${Math.round(entry.startTime - start)} layout-shift value=${entry.value.toFixed(4)} ${where}`,
        );
      }
    });
    shifts.observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);

    let previous = '';
    const sample = (): void => {
      const tree = document.querySelector('.db-tree');
      const firstRow = document.querySelector('.db-tree-row');
      const state = JSON.stringify({
        loading: !!document.querySelector('.db-tree-loading'),
        empty: !!document.querySelector('.db-tree-empty'),
        rows: document.querySelectorAll('.db-tree-row').length,
        scrollTop: tree?.scrollTop ?? -1,
        scrollHeight: tree?.scrollHeight ?? -1,
        firstRowTop: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : -1,
        explorerHeight: Math.round((explorer as HTMLElement).getBoundingClientRect().height),
        opacity: getComputedStyle(explorer as HTMLElement).opacity,
      });
      if (state !== previous) {
        previous = state;
        samples.push(`t=${Math.round(performance.now() - start)} ${state}`);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.locator('.db-tree-row').filter({ hasText: 'doc-0' }).first().click();
  const writeTab = page.getByRole('tab', { name: 'Write' });
  await writeTab.waitFor({ state: 'visible', timeout: 30_000 });
  await writeTab.click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 30_000 });
  await editor.click();
  for (let i = 0; i < 5; i += 1) {
    await editor.pressSequentially(`hello world ${i} `, { delay: 60 });
    await page.waitForTimeout(1500);
  }

  const records = await page.evaluate(() => window.__flashRecords ?? []);
  const samples = await page.evaluate(
    () => (window as unknown as { __flashSamples?: string[] }).__flashSamples ?? [],
  );
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(records, null, 1));
  // eslint-disable-next-line no-console
  console.log('=== SAMPLES ===\n' + samples.join('\n'));
  expect(records.length).toBeGreaterThanOrEqual(0);
});
