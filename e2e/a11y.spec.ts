import { test, expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openInitializedSite } from './helpers/site.js';

/**
 * Accessibility audits using axe-core against the DocBlocks site shell.
 *
 * Each test scans a specific UI state (initial shell, app menu open, dialog
 * open, etc.) and asserts that no WCAG 2.0/2.1 A or AA violations remain.
 *
 * Editor internals (Squisq, Monaco) are owned upstream in qualla-internal —
 * we scope axe scans away from them with `.exclude(...)` so failures here
 * are actionable inside this repo. Issues inside the editor itself should
 * be filed against squisq.
 *
 * On failure, each test writes a per-state report to
 *   test-results/a11y-reports/<state>.{json,md}
 * with the full violation list — handy for triage when stdout is truncated.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/**
 * Surfaces we don't own — exclude from scans so we audit the DocBlocks
 * chrome rather than third-party editor internals. The `[class*="..."]`
 * patterns intentionally catch namespaced variants like `squisq-status-bar`.
 */
const UPSTREAM_SELECTORS = ['[class*="squisq"]', '[data-squisq]', '.monaco-editor', '.cm-editor'];

function buildScan(page: Page) {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS]);
  for (const selector of UPSTREAM_SELECTORS) {
    builder = builder.exclude(selector);
  }
  return builder;
}

type Violation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return 'no violations';
  return violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, 3)
        .map((n) => `      ${n.target.join(' ')}`)
        .join('\n');
      const more = v.nodes.length > 3 ? `\n      … and ${v.nodes.length - 3} more` : '';
      return `  • [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}
    ${v.helpUrl}
    Affected (${v.nodes.length}):
${targets}${more}`;
    })
    .join('\n');
}

function formatViolationsMarkdown(state: string, violations: Violation[]): string {
  const lines: string[] = [
    `# A11y violations — ${state}`,
    '',
    `**Count:** ${violations.length}`,
    '',
  ];
  for (const v of violations) {
    lines.push(`## [${v.impact ?? 'unknown'}] \`${v.id}\` — ${v.help}`);
    lines.push('');
    lines.push(`- WCAG tags: ${v.tags.join(', ')}`);
    lines.push(`- Help: ${v.helpUrl}`);
    lines.push(`- Affected nodes (${v.nodes.length}):`);
    for (const node of v.nodes) {
      lines.push(`  - \`${node.target.join(' ')}\``);
      if (node.failureSummary) {
        const summary = node.failureSummary.replace(/\n/g, ' ');
        lines.push(`    - ${summary}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function scanAndReport(page: Page, info: TestInfo, state: string) {
  const results = await buildScan(page).analyze();
  // info.project.outputDir is the project-wide output root (defaults to
  // ./test-results) — put the audit artifacts in a sibling subfolder.
  const outDir = join(info.project.outputDir, 'a11y-reports');
  const jsonPath = join(outDir, `${state}.json`);
  const mdPath = join(outDir, `${state}.md`);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(results.violations, null, 2), 'utf8');
  await writeFile(mdPath, formatViolationsMarkdown(state, results.violations), 'utf8');
  return results.violations;
}

async function waitForShell(page: Page) {
  await openInitializedSite(page);
}

test.describe('a11y — initial shell', () => {
  test('no WCAG A/AA violations on first load', async ({ page }, info) => {
    await waitForShell(page);
    const violations = await scanAndReport(page, info, 'initial-shell');
    expect(
      violations.length,
      `${violations.length} violation(s) on initial shell:\n${formatViolations(violations)}`,
    ).toBe(0);
  });
});

test.describe('a11y - application dialogs', () => {
  test('no WCAG A/AA violations in Settings and About dialogs', async ({ page }, info) => {
    await waitForShell(page);

    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    let violations = await scanAndReport(page, info, 'settings-dialog');
    expect(
      violations.length,
      `${violations.length} violation(s) in Settings dialog:\n${formatViolations(violations)}`,
    ).toBe(0);
    await page.getByRole('button', { name: 'Close' }).click();

    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'About' }).click();
    await expect(page.getByRole('dialog', { name: 'About DocBlocks' })).toBeVisible();
    violations = await scanAndReport(page, info, 'about-dialog');
    expect(
      violations.length,
      `${violations.length} violation(s) in About dialog:\n${formatViolations(violations)}`,
    ).toBe(0);
  });

  test('no WCAG A/AA violations in the Export dialog', async ({ page }, info) => {
    await waitForShell(page);
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export document...' }).click();
    await expect(page.getByRole('dialog', { name: 'Export Document' })).toBeVisible();

    const violations = await scanAndReport(page, info, 'export-dialog');
    expect(
      violations.length,
      `${violations.length} violation(s) in Export dialog:\n${formatViolations(violations)}`,
    ).toBe(0);
  });
});

test.describe('a11y — app menu open', () => {
  test('no WCAG A/AA violations with app menu dropdown visible', async ({ page }, info) => {
    await waitForShell(page);
    await page.locator('.db-app-menu-btn').click();
    await expect(page.locator('.db-app-menu-dropdown')).toBeVisible();

    const violations = await scanAndReport(page, info, 'app-menu-open');
    expect(
      violations.length,
      `${violations.length} violation(s) with app menu open:\n${formatViolations(violations)}`,
    ).toBe(0);
  });
});

test.describe('a11y — workspace picker open', () => {
  test('no WCAG A/AA violations with workspace dropdown visible', async ({ page }, info) => {
    await waitForShell(page);
    await page.locator('.db-workspace-picker-btn').click();
    await expect(page.locator('.db-workspace-dropdown')).toBeVisible();

    const violations = await scanAndReport(page, info, 'workspace-picker-open');
    expect(
      violations.length,
      `${violations.length} violation(s) with workspace picker open:\n${formatViolations(
        violations,
      )}`,
    ).toBe(0);
  });
});

test.describe('a11y — new file input visible', () => {
  test('no WCAG A/AA violations with new-file input visible', async ({ page }, info) => {
    await waitForShell(page);
    await page.getByRole('button', { name: 'New File' }).click();
    await expect(page.locator('.db-new-item-input')).toBeVisible();

    const violations = await scanAndReport(page, info, 'new-file-input');
    expect(
      violations.length,
      `${violations.length} violation(s) with new-file input visible:\n${formatViolations(
        violations,
      )}`,
    ).toBe(0);
  });
});

test.describe('a11y — editor open with a file', () => {
  test('no WCAG A/AA violations on the DocBlocks chrome with editor mounted', async ({
    page,
  }, info) => {
    await waitForShell(page);

    // Create a file, then open it so the editor mounts.
    await page.getByRole('button', { name: 'New File' }).click();
    const input = page.locator('.db-new-item-input');
    await input.fill('a11y-test-doc');
    await page.locator('.db-new-item-add').click();

    const treeRow = page.locator('.db-tree-row', { hasText: 'a11y-test-doc' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
    await treeRow.click();

    // Editor mounted = empty state gone.
    await expect(page.locator('.db-shell-empty')).not.toBeVisible({ timeout: 5_000 });

    const violations = await scanAndReport(page, info, 'editor-open');
    expect(
      violations.length,
      `${violations.length} violation(s) with editor open (chrome only; editor internals excluded):\n${formatViolations(
        violations,
      )}`,
    ).toBe(0);
  });
});
