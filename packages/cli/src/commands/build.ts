import { Command } from 'commander';
import { mkdir, opendir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownHtml } from '../render-html.js';
import { positiveLimit } from '../internal/limits.js';
import { isNodeErrorCode } from '../internal/node-error.js';
import { assertKnownThemeId } from '../internal/theme.js';
import { decodeUtf8Text } from '@bendyline/docblocks/filesystem';

export interface BuildOptions {
  input: string;
  output: string;
  theme?: string;
  /** Programmatic traversal budget; CLI callers use the safe default. */
  maxEntries?: number;
  /** Programmatic directory-depth budget; CLI callers use the safe default. */
  maxDepth?: number;
  /** Maximum bytes in one Markdown input. */
  maxInputBytes?: number;
  /** Maximum aggregate bytes across all Markdown inputs. */
  maxTotalInputBytes?: number;
  /** Maximum bytes in one generated standalone HTML file. */
  maxOutputBytes?: number;
  /** Maximum aggregate bytes across all generated HTML files. */
  maxTotalOutputBytes?: number;
  /** Disable default byte budgets for an explicitly trusted bulk build. */
  allowLargeBuild?: boolean;
}

export interface BuildResult {
  inputDir: string;
  outputDir: string;
  builtFiles: string[];
}

const DEFAULT_MAX_BUILD_ENTRIES = 100_000;
const DEFAULT_MAX_BUILD_DEPTH = 64;
const DEFAULT_MAX_BUILD_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_BUILD_TOTAL_INPUT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_BUILD_OUTPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_BUILD_TOTAL_OUTPUT_BYTES = 1024 * 1024 * 1024;

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  await assertKnownThemeId(opts.theme);
  const inputDir = path.resolve(opts.input);
  const outputDir = path.resolve(opts.output);
  let inputStat;
  try {
    inputStat = await stat(inputDir);
  } catch (error: unknown) {
    if (!isNodeErrorCode(error, 'ENOENT')) throw error;
    throw new Error(`Input directory not found: ${inputDir}`);
  }
  if (!inputStat.isDirectory()) throw new Error(`Input is not a directory: ${inputDir}`);

  const markdownFiles = await listMarkdownFiles(inputDir, {
    maxEntries: positiveLimit(opts.maxEntries, DEFAULT_MAX_BUILD_ENTRIES, 'build entry'),
    maxDepth: positiveLimit(opts.maxDepth, DEFAULT_MAX_BUILD_DEPTH, 'build depth'),
  });
  if (markdownFiles.length === 0) {
    throw new Error(`No markdown files found in ${inputDir}.`);
  }
  const byteLimits = resolveBuildByteLimits(opts);
  await assertBuildInputSizes(markdownFiles, byteLimits);

  await mkdir(outputDir, { recursive: true });
  const builtFiles: string[] = [];
  let totalInputBytes = 0;
  let totalOutputBytes = 0;

  for (const sourcePath of markdownFiles) {
    const relativePath = path.relative(inputDir, sourcePath);
    const outputPath = path.join(outputDir, replaceMarkdownExtension(relativePath));
    const sourceBytes = await readFile(sourcePath);
    if (sourceBytes.byteLength > byteLimits.maxInputBytes) {
      throw new Error(
        `Build input ${sourcePath} exceeds the ${byteLimits.maxInputBytes}-byte per-file limit.`,
      );
    }
    totalInputBytes += sourceBytes.byteLength;
    if (totalInputBytes > byteLimits.maxTotalInputBytes) {
      throw new Error(
        `Build inputs exceed the ${byteLimits.maxTotalInputBytes}-byte aggregate limit.`,
      );
    }
    const source = decodeUtf8Text(sourceBytes, { label: 'Build input', path: sourcePath });
    const html = await renderMarkdownHtml(source, {
      title: titleFromPath(relativePath),
      sourcePath,
      assetRoot: inputDir,
      themeId: opts.theme,
      mode: 'static',
    });
    const outputBytes = Buffer.byteLength(html, 'utf8');
    if (outputBytes > byteLimits.maxOutputBytes) {
      throw new Error(
        `Build output ${outputPath} exceeds the ${byteLimits.maxOutputBytes}-byte per-file limit.`,
      );
    }
    totalOutputBytes += outputBytes;
    if (totalOutputBytes > byteLimits.maxTotalOutputBytes) {
      throw new Error(
        `Build outputs exceed the ${byteLimits.maxTotalOutputBytes}-byte aggregate limit.`,
      );
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, 'utf-8');
    builtFiles.push(outputPath);
  }

  return { inputDir, outputDir, builtFiles };
}

export const buildCommand = new Command('build')
  .description('Build markdown files into HTML output')
  .option('-i, --input <dir>', 'input directory', '.')
  .option('-o, --output <dir>', 'output directory', 'dist')
  .option('-t, --theme <id>', 'Squisq theme ID to apply')
  .option('--max-input-bytes <bytes>', 'maximum bytes in one Markdown input')
  .option('--max-total-input-bytes <bytes>', 'maximum aggregate Markdown input bytes')
  .option('--max-output-bytes <bytes>', 'maximum bytes in one generated HTML file')
  .option('--max-total-output-bytes <bytes>', 'maximum aggregate generated HTML bytes')
  .option('--allow-large-build', 'disable default byte budgets for a trusted bulk build')
  .action(async (opts: BuildCommandOptions) => {
    try {
      const result = await runBuild({
        input: opts.input,
        output: opts.output,
        theme: opts.theme,
        maxInputBytes: parseOptionalByteLimit('--max-input-bytes', opts.maxInputBytes),
        maxTotalInputBytes: parseOptionalByteLimit(
          '--max-total-input-bytes',
          opts.maxTotalInputBytes,
        ),
        maxOutputBytes: parseOptionalByteLimit('--max-output-bytes', opts.maxOutputBytes),
        maxTotalOutputBytes: parseOptionalByteLimit(
          '--max-total-output-bytes',
          opts.maxTotalOutputBytes,
        ),
        allowLargeBuild: opts.allowLargeBuild,
      });
      for (const outFile of result.builtFiles) {
        console.error(`Built: ${outFile}`);
      }
      console.error(`Done. ${result.builtFiles.length} file(s) built to ${result.outputDir}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });

interface BuildTraversalLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
}

interface BuildByteLimits {
  readonly maxInputBytes: number;
  readonly maxTotalInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxTotalOutputBytes: number;
}

interface BuildCommandOptions {
  readonly input: string;
  readonly output: string;
  readonly theme?: string;
  readonly maxInputBytes?: string;
  readonly maxTotalInputBytes?: string;
  readonly maxOutputBytes?: string;
  readonly maxTotalOutputBytes?: string;
  readonly allowLargeBuild?: boolean;
}

function resolveBuildByteLimits(options: BuildOptions): BuildByteLimits {
  const unlimitedDefault = options.allowLargeBuild === true ? Number.MAX_SAFE_INTEGER : undefined;
  return {
    maxInputBytes: positiveLimit(
      options.maxInputBytes,
      unlimitedDefault ?? DEFAULT_MAX_BUILD_INPUT_BYTES,
      'build input byte',
    ),
    maxTotalInputBytes: positiveLimit(
      options.maxTotalInputBytes,
      unlimitedDefault ?? DEFAULT_MAX_BUILD_TOTAL_INPUT_BYTES,
      'build aggregate input byte',
    ),
    maxOutputBytes: positiveLimit(
      options.maxOutputBytes,
      unlimitedDefault ?? DEFAULT_MAX_BUILD_OUTPUT_BYTES,
      'build output byte',
    ),
    maxTotalOutputBytes: positiveLimit(
      options.maxTotalOutputBytes,
      unlimitedDefault ?? DEFAULT_MAX_BUILD_TOTAL_OUTPUT_BYTES,
      'build aggregate output byte',
    ),
  };
}

async function assertBuildInputSizes(
  markdownFiles: readonly string[],
  limits: BuildByteLimits,
): Promise<void> {
  let totalBytes = 0;
  for (const sourcePath of markdownFiles) {
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error(`Build input is not a file: ${sourcePath}`);
    if (info.size > limits.maxInputBytes) {
      throw new Error(
        `Build input ${sourcePath} exceeds the ${limits.maxInputBytes}-byte per-file limit.`,
      );
    }
    totalBytes += info.size;
    if (totalBytes > limits.maxTotalInputBytes) {
      throw new Error(`Build inputs exceed the ${limits.maxTotalInputBytes}-byte aggregate limit.`);
    }
  }
}

function parseOptionalByteLimit(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

async function listMarkdownFiles(root: string, limits: BuildTraversalLimits): Promise<string[]> {
  const files: string[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let entryCount = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await opendir(current.directory);
    for await (const entry of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new Error(`Build traversal exceeded ${limits.maxEntries} filesystem entries.`);
      }
      const absolutePath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= limits.maxDepth) {
          throw new Error(`Build traversal exceeded a depth of ${limits.maxDepth}.`);
        }
        pending.push({ directory: absolutePath, depth: current.depth + 1 });
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        files.push(absolutePath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function isMarkdownFile(fileName: string): boolean {
  return /\.(md|markdown)$/i.test(fileName);
}

function replaceMarkdownExtension(filePath: string): string {
  return filePath.replace(/\.(md|markdown)$/i, '.html');
}

function titleFromPath(filePath: string): string {
  const baseName = path.basename(filePath).replace(/\.(md|markdown)$/i, '');
  return baseName || 'DocBlocks Document';
}
