/** Validate the exact file list that VSCE would place in the extension package. */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ForbiddenRule {
  readonly pattern: RegExp;
  readonly reason: string;
}

export interface VsixContentViolation {
  readonly path: string;
  readonly reason: string;
}

const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FILES = 5_000;
const MAX_SCANNED_FILE_BYTES = 32 * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vscodePackageRoot = path.join(repoRoot, 'packages', 'vscode');
const require = createRequire(import.meta.url);

const FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  {
    pattern:
      /^(?:\.vscode-test-web|desktop-e2e|e2e|playwright-report|src|test|test-fixtures|test-results|webview)(?:\/|$)/u,
    reason: 'internal source or test infrastructure',
  },
  {
    pattern: /^dist\/desktop-e2e(?:\/|$)/u,
    reason: 'compiled desktop E2E harness',
  },
  {
    pattern: /^tsconfig(?:\.[^/]+)?\.json$/u,
    reason: 'TypeScript project configuration',
  },
  {
    pattern: /^tsup\.config\.ts$/u,
    reason: 'build configuration',
  },
  {
    pattern: /(?:^|\/)[^/]+\.map$/u,
    reason: 'source map',
  },
  {
    pattern: /(?:^|\/)[^/]+\.log$/u,
    reason: 'log file',
  },
];

function normalizeListedPath(filePath: string): string {
  return filePath
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/u, '');
}

export function findForbiddenVsixPaths(
  filePaths: readonly string[],
): readonly VsixContentViolation[] {
  const violations: VsixContentViolation[] = [];
  for (const rawPath of filePaths) {
    const filePath = normalizeListedPath(rawPath);
    if (
      filePath.length === 0 ||
      filePath.startsWith('/') ||
      filePath === '..' ||
      filePath.startsWith('../')
    ) {
      violations.push({ path: rawPath, reason: 'invalid package-relative path' });
      continue;
    }
    const rule = FORBIDDEN_RULES.find((candidate) => candidate.pattern.test(filePath));
    if (rule) violations.push({ path: filePath, reason: rule.reason });
  }
  return violations;
}

function resolveVsceCli(): string {
  const manifestPath = require.resolve('@vscode/vsce/package.json');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('bin' in manifest) ||
    typeof manifest.bin !== 'object' ||
    manifest.bin === null ||
    !('vsce' in manifest.bin) ||
    typeof manifest.bin.vsce !== 'string'
  ) {
    throw new Error('@vscode/vsce does not declare a usable vsce CLI entry.');
  }
  return path.resolve(path.dirname(manifestPath), manifest.bin.vsce);
}

function listVsixFiles(): readonly string[] {
  const result = spawnSync(process.execPath, [resolveVsceCli(), 'ls', '--no-dependencies'], {
    cwd: vscodePackageRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: MAX_LIST_BYTES,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr.trim();
    throw new Error('vsce ls failed' + (details ? ': ' + details : '.'));
  }

  const files = result.stdout.split(/\r?\n/gu).map(normalizeListedPath).filter(Boolean);
  if (files.length === 0) throw new Error('vsce ls returned no package files.');
  if (files.length > MAX_LISTED_FILES) {
    throw new Error('vsce ls exceeded the ' + MAX_LISTED_FILES + '-file package budget.');
  }
  return files;
}

async function findDanglingSourceMaps(filePaths: readonly string[]): Promise<readonly string[]> {
  const shippedPaths = new Set(filePaths.map(normalizeListedPath));
  const violations: string[] = [];
  for (const filePath of shippedPaths) {
    if (!/\.(?:css|js)$/u.test(filePath)) continue;
    const absolutePath = path.resolve(vscodePackageRoot, ...filePath.split('/'));
    const relativePath = path.relative(vscodePackageRoot, absolutePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith('..' + path.sep) ||
      path.isAbsolute(relativePath)
    ) {
      violations.push(filePath + ' escapes the extension package root');
      continue;
    }

    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_SCANNED_FILE_BYTES) {
      violations.push(filePath + ' cannot be safely scanned for source-map references');
      continue;
    }
    const source = await readFile(absolutePath, 'utf8');
    const sourceMapPattern =
      /^[\t ]*(?:\/\/[#@][\t ]*sourceMappingURL=([^\s]+)|\/\*[#@][\t ]*sourceMappingURL=([^\s*]+)[\t ]*\*\/)[\t ]*$/gmu;
    for (const match of source.matchAll(sourceMapPattern)) {
      const reference = match[1] ?? match[2];
      if (!reference || reference.startsWith('data:')) continue;
      const referencePath = reference.split(/[?#]/u, 1)[0];
      if (!referencePath) {
        violations.push(filePath + ' has an invalid source-map reference');
        continue;
      }
      let decodedReference: string;
      try {
        decodedReference = decodeURIComponent(referencePath);
      } catch {
        violations.push(filePath + ' has an invalid source-map reference: ' + reference);
        continue;
      }
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(filePath), decodedReference),
      );
      if (!shippedPaths.has(target)) {
        violations.push(filePath + ' references missing ' + target);
      }
    }
  }
  return violations;
}

export async function checkVsixPackageContents(): Promise<void> {
  const files = listVsixFiles();
  for (const requiredNotice of [
    'THIRD_PARTY_NOTICES.txt',
    'dist/webview/THIRD_PARTY_COMPONENTS.json',
  ]) {
    if (!files.includes(requiredNotice)) {
      throw new Error(`VSIX is missing required legal inventory: ${requiredNotice}`);
    }
  }
  // Proofing has no CDN fallback: an extension shipped without these binaries
  // does not degrade loudly, it just never finishes loading the engine. The
  // license rides along because harper is Apache-2.0.
  for (const requiredEngineFile of [
    'dist/webview/harper/harper_wasm_bg.wasm',
    'dist/webview/harper/harper_wasm_slim_bg.wasm',
    'dist/webview/harper/LICENSE.txt',
  ]) {
    if (!files.includes(requiredEngineFile)) {
      throw new Error(`VSIX is missing the packaged proofing engine: ${requiredEngineFile}`);
    }
  }
  const forbidden = findForbiddenVsixPaths(files);
  if (forbidden.length > 0) {
    throw new Error(
      'VSIX contains forbidden files:\n' +
        forbidden.map((item) => '  ' + item.path + ' (' + item.reason + ')').join('\n'),
    );
  }

  const danglingSourceMaps = await findDanglingSourceMaps(files);
  if (danglingSourceMaps.length > 0) {
    throw new Error(
      'VSIX contains dangling source-map references:\n  ' + danglingSourceMaps.join('\n  '),
    );
  }

  process.stdout.write(
    'VSIX package contents: ' +
      files.length +
      ' files; no internal/test paths or dangling source maps.\n',
  );
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
  void checkVsixPackageContents().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
