import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './helpers/test.js';
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

for (const theme of ['Light', 'Dark']) {
  test(`host editor palette meets text contrast in ${theme} across every accent`, async ({
    page,
  }) => {
    await openInitializedSite(page);
    await page.getByRole('tab', { name: 'Write', exact: true }).click();
    const heading = page.getByRole('button', { name: 'Heading 2', exact: true });
    await heading.click();
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    for (const accent of ['Rust', 'Green', 'Blue', 'Purple', 'Maroon', 'Orange', 'Gray']) {
      await page.getByRole('button', { name: 'DocBlocks', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await dialog.getByRole('radio', { name: theme, exact: true }).check();
      // The visible swatch is a label over the native input. Exercise its
      // keyboard path rather than trying to click through that label.
      const accentRadio = dialog.getByRole('radio', { name: accent, exact: true });
      await accentRadio.press('Space');
      await expect(accentRadio).toBeChecked();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.mouse.move(0, 0);
      // Squisq owns the markup, but DocBlocks supplies these foreground and
      // background colors; excluding the editor would hide host palette bugs.
      const { violations } = await new AxeBuilder({ page })
        .include('.squisq-toolbar')
        .include('.squisq-status-bar')
        .withRules(['color-contrast'])
        .analyze();
      expect(violations, `${theme} / ${accent}: ${formatViolations(violations)}`).toEqual([]);
      // Active text and its hover state both need readable ink on the tint.
      await heading.hover();
      await heading.evaluate(async (element) => {
        await Promise.all(element.getAnimations({ subtree: true }).map((entry) => entry.finished));
      });
      const hovered = await new AxeBuilder({ page })
        .include('.squisq-toolbar-button--active')
        .withRules(['color-contrast'])
        .analyze();
      expect(
        hovered.violations,
        `${theme} / ${accent} active hover: ${formatViolations(hovered.violations)}`,
      ).toEqual([]);
      await page.getByRole('button', { name: 'Choose Use mode', exact: true }).click();
      // Measure the settled menu, not the partially transparent entrance frame.
      await page.locator('.squisq-use-mode-menu').evaluate(async (element) => {
        await Promise.all(element.getAnimations({ subtree: true }).map((entry) => entry.finished));
      });
      const menuScan = await new AxeBuilder({ page })
        .include('.squisq-use-mode-menu')
        .withRules(['color-contrast'])
        .analyze();
      expect(
        menuScan.violations,
        `${theme} / ${accent} mode menu: ${formatViolations(menuScan.violations)}`,
      ).toEqual([]);
      await page.keyboard.press('Escape');
    }
  });
}

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
  // Export/Share render inside Squisq's toolbar slot. Excluding the editor
  // ancestor also excludes those first-party dialogs, silently scanning none
  // of their controls. Audit the open modal directly without upstream exclusions.
  const builder = (await page.locator('.db-dialog').count())
    ? new AxeBuilder({ page }).withTags([...WCAG_TAGS]).include('.db-dialog')
    : buildScan(page);
  const results = await builder.analyze();
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

  test('no WCAG A/AA violations in the Share dialog', async ({ page }, info) => {
    await waitForShell(page);
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Share link with content embedded...' }).click();
    await expect(page.getByRole('dialog', { name: 'Share document' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
    const violations = await scanAndReport(page, info, 'share-dialog');
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

test.describe('a11y — quick-open and workspace search', () => {
  test('no WCAG A/AA violations in the quick-open dialog', async ({ page }, info) => {
    await waitForShell(page);
    await page.keyboard.press('ControlOrMeta+p');
    const dialog = page.getByRole('dialog', { name: 'Go to document' });
    await expect(dialog).toBeVisible();
    // The empty list leaves out the open document, the only one on a fresh site.
    await dialog.getByRole('combobox', { name: 'Go to document' }).fill('welcome');
    await expect(dialog.getByRole('option').first()).toBeVisible();

    const violations = await scanAndReport(page, info, 'quick-open');
    expect(
      violations.length,
      `${violations.length} violation(s) in quick-open:\n${formatViolations(violations)}`,
    ).toBe(0);
  });

  test('no WCAG A/AA violations in the search panel with results', async ({ page }, info) => {
    await waitForShell(page);
    await page.getByRole('button', { name: 'Search workspace' }).click();
    await page.getByRole('searchbox', { name: 'Search workspace' }).fill('DocBlocks');
    await expect(page.locator('.db-search-line').first()).toBeVisible({ timeout: 20_000 });

    const violations = await scanAndReport(page, info, 'workspace-search');
    expect(
      violations.length,
      `${violations.length} violation(s) in the search panel:\n${formatViolations(violations)}`,
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
