/**
 * Burn in the site E2E tests that a change added or edited.
 *
 * A test that races the app passes almost every time on an idle machine and
 * fails only when the browser is starved at the wrong moment. One pass of the
 * gate cannot tell such a test from a sound one: `adaptive-shell.spec.ts` once
 * passed every PR and main run and then failed a release gate on identical
 * code, because its probe sometimes snapshotted the page before a lazy editor
 * had mounted. Run in parallel, it failed about once in 80 runs.
 *
 * So before a change merges, this repeats every test whose own code the change
 * touched, with several workers loading the machine, and fails on any failure.
 * It costs little because it selects tests, not files: a one-test edit to a
 * 1,000-line spec burns in that one test.
 *
 *   npm run test:e2e:burn-in                  # against the merge base with origin/main
 *   npm run test:e2e:burn-in -- --base=<ref>
 *
 * Scope:
 * - Tests the root Playwright config runs (site + touch-device projects). The
 *   desktop and VS Code suites launch one Electron or workbench at a time and
 *   cannot be loaded this way.
 * - Spec files only. A shared helper runs under every test, so burning one in
 *   means burning in the whole suite; those changes get the ordinary gate.
 * - A change inside a spec but outside every test body (a helper function, a
 *   hook, a describe-level skip) selects every test in that file.
 *
 * In CI it runs on pull requests only: push and release builds have no change
 * under review, and they ran this when the change was a pull request.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');

/** Specs the root config deliberately does not run (see playwright.config.ts). */
const ROOT_CONFIG_EXCLUDED = /(?:^|\/)(?:offline|cross-browser|visual|visual-adaptive)\.spec\.ts$/u;
const SPEC_FILE = /^e2e\/(?:.+\/)?[^/]+\.spec\.ts$/u;

/**
 * Test runs per burn-in, shared across the selected tests. One edited test
 * gets the maximum repeats; a pull request that edits dozens shares the budget
 * and gets fewer each, so even a large one costs about 200 test runs.
 */
const RUN_BUDGET = 200;
const MIN_REPEAT_EACH = 5;
const MAX_REPEAT_EACH = 30;

export function repeatEachFor(listedTests: number): number {
  if (listedTests < 1) return MAX_REPEAT_EACH;
  return Math.max(MIN_REPEAT_EACH, Math.min(MAX_REPEAT_EACH, Math.floor(RUN_BUDGET / listedTests)));
}

/** One `test(...)` declaration and the lines its call spans, 1-based inclusive. */
export interface TestDeclaration {
  readonly line: number;
  readonly endLine: number;
}

export interface ChangedSpec {
  readonly file: string;
  /** Changed lines in the working-tree file, or 'all' for a new file. */
  readonly lines: ReadonlySet<number> | 'all';
}

/**
 * Which new-file lines each file's hunks touch, from `git diff --unified=0`.
 *
 * A pure deletion has no new lines; it marks the lines either side of the gap
 * so a test that only lost a line still counts as changed.
 */
export function parseChangedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') {
        current = null;
        continue;
      }
      const file = target.replace(/^b\//u, '');
      current = changed.get(file) ?? new Set<number>();
      changed.set(file, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!hunk || !current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) {
      current.add(Math.max(1, start));
      current.add(start + 1);
      continue;
    }
    for (let offset = 0; offset < count; offset += 1) current.add(start + offset);
  }
  return changed;
}

const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow']);

function isTestCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'test';
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'test' &&
    TEST_MODIFIERS.has(expression.name.text)
  );
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function parseSpec(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Lines holding at least one token. A blank separator or a reworded comment
 * changes no behaviour, and one between two tests would otherwise read as a
 * change outside every test and select the whole file.
 */
export function findCodeLines(source: string, fileName = 'spec.ts'): Set<number> {
  const sourceFile = parseSpec(source, fileName);
  const lines = new Set<number>();
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const last = lineOf(sourceFile, node.getEnd());
    for (let line = lineOf(sourceFile, node.getStart(sourceFile)); line <= last; line += 1) {
      lines.add(line);
    }
  };
  visit(sourceFile);
  return lines;
}

/**
 * Every `test(title, fn)` in a spec, including `.only/.skip/.fixme/.fail` and
 * computed titles such as a template per theme. A conditional
 * `test.skip(condition, 'reason')` declares nothing and is left out: it has no
 * function after its first argument, or that argument is itself the function.
 */
export function findTestDeclarations(source: string, fileName = 'spec.ts'): TestDeclaration[] {
  const sourceFile = parseSpec(source, fileName);
  const declarations: TestDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      isTestCallee(node.expression) &&
      node.arguments.length >= 2 &&
      !isFunctionLike(node.arguments[0]) &&
      node.arguments.slice(1).some(isFunctionLike)
    ) {
      declarations.push({
        line: lineOf(sourceFile, node.getStart(sourceFile)),
        endLine: lineOf(sourceFile, node.getEnd()),
      });
      // Nested declarations would be a Playwright error; nothing to find inside.
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

/**
 * Playwright `file:line` locations to burn in. A changed line of code inside a
 * test selects that test; one outside every test selects the whole file.
 */
export function selectLocations(
  file: string,
  source: string,
  lines: ReadonlySet<number> | 'all',
): string[] {
  const declarations = findTestDeclarations(source, file);
  if (declarations.length === 0) return [];
  if (lines === 'all') return [file];
  const codeLines = findCodeLines(source, file);
  const selected = new Set<number>();
  for (const line of lines) {
    if (!codeLines.has(line)) continue;
    const owner = declarations.find((test) => line >= test.line && line <= test.endLine);
    if (!owner) return [file];
    selected.add(owner.line);
  }
  return [...selected].sort((a, b) => a - b).map((line) => `${file}:${line}`);
}

function git(args: readonly string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

function refExists(ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
}

type BaseResolution = { kind: 'base'; ref: string } | { kind: 'skip'; reason: string };

/**
 * What to diff against.
 *
 * Locally that is the merge base with origin/main, so commits that landed on
 * main after this branch forked are not mistaken for this branch's changes.
 * A pull request checkout is a shallow merge commit with no history to find a
 * merge base in, but the base branch tip is exactly what it was merged onto.
 */
function resolveBase(explicit: string | undefined): BaseResolution {
  if (explicit) {
    if (!refExists(explicit)) throw new Error(`--base ${explicit} is not a commit in this clone.`);
    return { kind: 'base', ref: explicit };
  }

  const pullRequestBase = process.env.GITHUB_BASE_REF;
  if (pullRequestBase) {
    const ref = `origin/${pullRequestBase}`;
    if (!refExists(ref)) {
      const fetched = git([
        'fetch',
        '--no-tags',
        '--depth=1',
        'origin',
        `+refs/heads/${pullRequestBase}:refs/remotes/${ref}`,
      ]);
      if (!fetched.ok || !refExists(ref)) {
        throw new Error(`Could not fetch ${ref} to find the tests this pull request changed.`);
      }
    }
    return { kind: 'base', ref };
  }

  if (process.env.CI) {
    return { kind: 'skip', reason: 'not a pull request, so there is no change under review' };
  }

  for (const candidate of ['origin/main', 'main']) {
    if (!refExists(candidate)) continue;
    const mergeBase = git(['merge-base', 'HEAD', candidate]);
    return { kind: 'base', ref: mergeBase.ok ? mergeBase.stdout.trim() : candidate };
  }
  return { kind: 'skip', reason: 'neither origin/main nor main exists to compare against' };
}

/** Spec files the change touched, as working-tree paths with changed lines. */
function changedSpecs(base: string): ChangedSpec[] {
  const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--', 'e2e']);
  if (!diff.ok) throw new Error(`git diff against ${base} failed.`);
  const specs: ChangedSpec[] = [...parseChangedLines(diff.stdout)].map(([file, lines]) => ({
    file,
    lines,
  }));
  // `git diff` does not see a spec that has never been added.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'e2e']);
  for (const file of untracked.stdout.split(/\r?\n/u).filter(Boolean)) {
    specs.push({ file, lines: 'all' });
  }
  return specs.filter(({ file }) => SPEC_FILE.test(file) && !ROOT_CONFIG_EXCLUDED.test(file));
}

function intFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}.`);
  }
  return value;
}

/**
 * Enough workers to load the machine, not so many that the browsers starve
 * past the assertion timeouts. A 4-vCPU CI runner gets 2.
 */
function defaultWorkers(): number {
  return Math.max(2, Math.min(4, Math.floor(os.availableParallelism() / 2)));
}

export async function runBurnIn(argv: readonly string[]): Promise<number> {
  const explicitBase = argv.find((arg) => arg.startsWith('--base='))?.slice('--base='.length);
  const passthrough = argv.filter((arg) => !arg.startsWith('--base='));
  const base = resolveBase(explicitBase);
  if (base.kind === 'skip') {
    process.stdout.write(`E2E burn-in skipped: ${base.reason}.\n`);
    return 0;
  }

  const locations: string[] = [];
  for (const spec of changedSpecs(base.ref)) {
    let source: string;
    try {
      source = await readFile(path.join(repoRoot, spec.file), 'utf8');
    } catch {
      continue; // Renamed away or deleted in the working tree.
    }
    locations.push(...selectLocations(spec.file, source, spec.lines));
  }
  if (locations.length === 0) {
    process.stdout.write(`E2E burn-in: no site E2E test changed since ${base.ref}.\n`);
    return 0;
  }

  // The gate built every package before this step; skip the config's local
  // rebuild.
  const env = { ...process.env, DOCBLOCKS_E2E_PREBUILT: '1' };
  const listed = spawnSync(
    process.execPath,
    [playwrightCli, 'test', ...locations, '--list', '--reporter=list', ...passthrough],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true },
  );
  if (listed.status !== 0) {
    process.stderr.write(listed.stdout + listed.stderr);
    return listed.status ?? 1;
  }
  const listedTests = Number(/^Total: (\d+) tests?\b/mu.exec(listed.stdout)?.[1] ?? 0);
  if (listedTests === 0) {
    process.stdout.write(
      `E2E burn-in: the changed specs since ${base.ref} hold no test the root config runs.\n`,
    );
    return 0;
  }

  const repeatEach = intFromEnvironment('DOCBLOCKS_BURN_IN_REPEAT', repeatEachFor(listedTests));
  const workers = intFromEnvironment('DOCBLOCKS_BURN_IN_WORKERS', defaultWorkers());
  process.stdout.write(
    `E2E burn-in: ${listedTests} tests x${repeatEach} with ${workers} workers, changed since ${base.ref}:\n` +
      locations.map((location) => `  ${location}\n`).join(''),
  );

  const result = spawnSync(
    process.execPath,
    [
      playwrightCli,
      'test',
      ...locations,
      `--repeat-each=${repeatEach}`,
      `--workers=${workers}`,
      '--retries=0',
      '--reporter=list',
      // Kept apart from the ordinary run's results, which the gate already
      // wrote and CI uploads alongside these.
      '--output=test-results/burn-in',
      ...passthrough,
    ],
    { cwd: repoRoot, env, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runBurnIn(process.argv.slice(2));
}
