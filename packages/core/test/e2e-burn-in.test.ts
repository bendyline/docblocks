import { expect } from 'chai';
import {
  findCodeLines,
  findTestDeclarations,
  parseChangedLines,
  repeatEachFor,
  selectLocations,
} from '../../../scripts/run-e2e-burn-in.js';

const SPEC = [
  "import { expect, test } from './helpers/test.js';", // 1
  '', // 2
  'async function open(page) {', // 3
  "  await page.goto('/');", // 4
  '}', // 5
  '', // 6
  "test.describe('shell', () => {", // 7
  "  test.skip(({ isMobile }) => !isMobile, 'touch only');", // 8
  '', // 9
  "  test('first', async ({ page }) => {", // 10
  '    await open(page);', // 11
  "    test.skip(true, 'not a declaration');", // 12
  '  });', // 13
  '', // 14
  '  // Explains the second test.', // 15
  "  test.fixme('second', async ({ page }) => {", // 16
  '    await open(page);', // 17
  '  });', // 18
  '', // 19
  "  for (const theme of ['Light', 'Dark']) {", // 20
  '    test(`themed ${theme}`, async ({ page }) => {', // 21
  '      await open(page);', // 22
  '    });', // 23
  '  }', // 24
  '});', // 25
].join('\n');

describe('E2E burn-in selection', () => {
  describe('parseChangedLines', () => {
    it('maps each hunk to its new-file lines', () => {
      const diff = [
        'diff --git a/e2e/a.spec.ts b/e2e/a.spec.ts',
        '--- a/e2e/a.spec.ts',
        '+++ b/e2e/a.spec.ts',
        '@@ -10,2 +10,3 @@ test(',
        '@@ -40 +41 @@',
        'diff --git a/e2e/b.spec.ts b/e2e/b.spec.ts',
        '--- a/e2e/b.spec.ts',
        '+++ b/e2e/b.spec.ts',
        '@@ -5,0 +6,2 @@',
      ].join('\n');
      const changed = parseChangedLines(diff);
      expect([...(changed.get('e2e/a.spec.ts') ?? [])]).to.deep.equal([10, 11, 12, 41]);
      expect([...(changed.get('e2e/b.spec.ts') ?? [])]).to.deep.equal([6, 7]);
    });

    it('marks both sides of a pure deletion and ignores deleted files', () => {
      const diff = [
        '--- a/e2e/a.spec.ts',
        '+++ b/e2e/a.spec.ts',
        '@@ -12,3 +11,0 @@',
        '--- a/e2e/gone.spec.ts',
        '+++ /dev/null',
        '@@ -1,9 +0,0 @@',
      ].join('\n');
      const changed = parseChangedLines(diff);
      expect([...(changed.get('e2e/a.spec.ts') ?? [])]).to.deep.equal([11, 12]);
      expect(changed.has('e2e/gone.spec.ts')).to.equal(false);
    });
  });

  describe('findTestDeclarations', () => {
    it('finds plain, modified and computed-title tests but not conditional skips', () => {
      expect(findTestDeclarations(SPEC)).to.deep.equal([
        { line: 10, endLine: 13 },
        { line: 16, endLine: 18 },
        { line: 21, endLine: 23 },
      ]);
    });
  });

  describe('findCodeLines', () => {
    it('leaves out blank lines and comments', () => {
      const lines = findCodeLines(SPEC);
      expect(lines.has(2)).to.equal(false);
      expect(lines.has(14)).to.equal(false);
      expect(lines.has(15)).to.equal(false);
      expect(lines.has(11)).to.equal(true);
      expect(lines.has(16)).to.equal(true);
    });
  });

  describe('selectLocations', () => {
    const file = 'e2e/shell.spec.ts';

    it('selects only the tests whose bodies changed', () => {
      expect(selectLocations(file, SPEC, new Set([22, 17, 11]))).to.deep.equal([
        `${file}:10`,
        `${file}:16`,
        `${file}:21`,
      ]);
    });

    it('ignores blank and comment-only changes, even between tests', () => {
      expect(selectLocations(file, SPEC, new Set([14, 15, 19]))).to.deep.equal([]);
    });

    it('selects the whole file for a change outside every test', () => {
      // A helper every test calls, and a describe-level skip.
      expect(selectLocations(file, SPEC, new Set([4]))).to.deep.equal([file]);
      expect(selectLocations(file, SPEC, new Set([8, 11]))).to.deep.equal([file]);
    });

    it('selects a new file whole and a file without tests not at all', () => {
      expect(selectLocations(file, SPEC, 'all')).to.deep.equal([file]);
      expect(selectLocations(file, 'export const helper = 1;\n', 'all')).to.deep.equal([]);
    });
  });

  describe('repeatEachFor', () => {
    it('spends the run budget on few tests and floors it for many', () => {
      expect(repeatEachFor(1)).to.equal(30);
      expect(repeatEachFor(18)).to.equal(11);
      expect(repeatEachFor(500)).to.equal(5);
    });
  });
});
