/** Validate the exact file list that VSCE would place in the extension package. */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
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
    pattern: /^(?:tsup\.config|web-extension-build)\.ts$/u,
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

/**
 * Where `vsce package` must point the readme's relative links.
 *
 * vsce rewrites every relative link and image in README.md to an absolute URL,
 * because the readme becomes the Marketplace page and the Details tab, where a
 * relative path cannot load. It derives that base from `repository.url` alone
 * and ignores `repository.directory`, so for this monorepo its guess is the
 * repository root, where none of the files exist. 2.7.14 shipped its three
 * Marketplace screenshots that way, all 404. `package:vsix` therefore passes
 * both bases explicitly, and these must match the manifest's own repository.
 */
export interface VsixReadmeBaseUrls {
  readonly content: string;
  readonly images: string;
}

export function expectedVsixReadmeBaseUrls(repository: unknown): VsixReadmeBaseUrls {
  if (
    typeof repository !== 'object' ||
    repository === null ||
    !('url' in repository) ||
    typeof repository.url !== 'string' ||
    !('directory' in repository) ||
    typeof repository.directory !== 'string'
  ) {
    throw new Error(
      'packages/vscode/package.json needs repository.url and repository.directory to place readme links.',
    );
  }
  const match = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(
    repository.url,
  );
  if (!match) throw new Error(`repository.url must be a GitHub HTTPS URL: ${repository.url}`);
  const directory = path.posix
    .normalize(repository.directory.replaceAll('\\', '/'))
    .replace(/^\.\/|\/+$/gu, '');
  if (!directory || directory === '.' || directory.startsWith('..') || directory.startsWith('/')) {
    throw new Error(`repository.directory must be a folder inside the repository: ${directory}`);
  }
  const repositoryUrl = `https://github.com/${match[1]}`;
  return {
    content: `${repositoryUrl}/blob/HEAD/${directory}`,
    images: `${repositoryUrl}/raw/HEAD/${directory}`,
  };
}

/** The base URLs a script's `vsce package` command passes, if any. */
export function vscePackageBaseUrls(script: string): {
  readonly packageCommand: boolean;
  readonly content?: string;
  readonly images?: string;
} {
  const command = script
    .split('&&')
    .map((part) => part.trim())
    .find((part) => /^vsce\s+package(?:\s|$)/u.test(part));
  if (!command) return { packageCommand: false };
  const option = (name: string) => {
    const value = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\S+)`, 'u').exec(command)?.[1];
    return value?.replace(/^(["'])(.*)\1$/u, '$2');
  };
  const content = option('baseContentUrl');
  const images = option('baseImagesUrl');
  return {
    packageCommand: true,
    ...(content ? { content } : {}),
    ...(images ? { images } : {}),
  };
}

export interface ReadmeLinkTarget {
  readonly target: string;
  readonly image: boolean;
}

/**
 * The relative link and image targets vsce rewrites, found the way vsce 3.x
 * finds them: Markdown links and images (including an image nested in a link's
 * text), and `<img>`/`<video>` sources. Absolute URLs, anchors and `mailto:`
 * are left alone, by vsce and here.
 */
export function relativeReadmeTargets(markdown: string): readonly ReadmeLinkTarget[] {
  const found: ReadmeLinkTarget[] = [];
  const isRelative = (link: string) =>
    !/^\w+:\/\//u.test(link) && !link.startsWith('#') && !/^mailto:/iu.test(link);
  const visit = (text: string) => {
    for (const match of text.matchAll(/(!?)\[([^\][]*|!\[[^\][]*\]\([^)]+\))\]\(([^)]+)\)/gu)) {
      const [, bang, title, link] = match;
      if (title?.includes('](')) visit(title);
      if (link && isRelative(link)) found.push({ target: link, image: bang === '!' });
    }
  };
  visit(markdown);
  for (const match of markdown.matchAll(/<(?:img|video)[^>]+src=["']([/.\w\s#-]+)['"][^>]*>/gu)) {
    const link = match[1];
    if (link && isRelative(link) && !link.startsWith('data:')) {
      found.push({ target: link, image: true });
    }
  }
  return found;
}

/** The package-relative file a readme target names, or null if it leaves the package. */
function readmeTargetPath(target: string): string | null {
  const withoutTitle = target.trim().split(/\s+/u, 1)[0] ?? '';
  const withoutFragment = withoutTitle.split(/[?#]/u, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURI(withoutFragment);
  } catch {
    return null;
  }
  const normalized = path.posix.normalize(decoded.replace(/^\/+/u, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

export function findVsixReadmeLinkProblems(input: {
  readonly readme: string;
  readonly packageScript: string | undefined;
  readonly expected: VsixReadmeBaseUrls;
  readonly fileExists: (packageRelativePath: string) => boolean;
}): readonly string[] {
  const problems: string[] = [];
  const passed = vscePackageBaseUrls(input.packageScript ?? '');
  if (!passed.packageCommand) {
    problems.push('package:vsix does not run `vsce package`.');
  } else {
    for (const [flag, key] of [
      ['--baseContentUrl', 'content'],
      ['--baseImagesUrl', 'images'],
    ] as const) {
      if (passed[key] !== input.expected[key]) {
        problems.push(
          `package:vsix must pass ${flag} ${input.expected[key]} (found ${passed[key] ?? 'none'}); ` +
            'vsce ignores repository.directory, so its own guess points at the repository root.',
        );
      }
    }
  }
  for (const { target, image } of relativeReadmeTargets(input.readme)) {
    const file = readmeTargetPath(target);
    if (file === null) {
      problems.push(`README.md ${image ? 'image' : 'link'} ${target} leaves packages/vscode.`);
    } else if (!input.fileExists(file)) {
      problems.push(
        `README.md ${image ? 'image' : 'link'} ${target} is not a file in packages/vscode.`,
      );
    }
  }
  return problems;
}

async function checkVsixReadmeLinks(): Promise<number> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(vscodePackageRoot, 'package.json'), 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('packages/vscode/package.json is not an object.');
  }
  const scripts = 'scripts' in manifest ? manifest.scripts : undefined;
  const packageScript =
    typeof scripts === 'object' &&
    scripts !== null &&
    'package:vsix' in scripts &&
    typeof scripts['package:vsix'] === 'string'
      ? scripts['package:vsix']
      : undefined;
  const readme = await readFile(path.join(vscodePackageRoot, 'README.md'), 'utf8');
  const problems = findVsixReadmeLinkProblems({
    readme,
    packageScript,
    expected: expectedVsixReadmeBaseUrls(
      'repository' in manifest ? manifest.repository : undefined,
    ),
    fileExists: (file) => {
      try {
        return statSync(path.join(vscodePackageRoot, ...file.split('/'))).isFile();
      } catch {
        return false;
      }
    },
  });
  if (problems.length > 0) {
    throw new Error('VSIX readme links would break:\n  ' + problems.join('\n  '));
  }
  return relativeReadmeTargets(readme).length;
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
  // Formula sessions fall back to the in-house tier if this optional engine
  // is missing, so pin its VSIX payload explicitly instead of accepting a
  // silently reduced package.
  for (const requiredEngineFile of [
    'dist/webview/ironcalc/wasm_bg.wasm',
    'dist/webview/ironcalc/LICENSE-MIT.txt',
  ]) {
    if (!files.includes(requiredEngineFile)) {
      throw new Error(`VSIX is missing the packaged calculation engine: ${requiredEngineFile}`);
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

  const readmeLinks = await checkVsixReadmeLinks();

  process.stdout.write(
    'VSIX package contents: ' +
      files.length +
      ' files; no internal/test paths or dangling source maps; ' +
      readmeLinks +
      ' relative readme links resolve under packages/vscode.\n',
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
