import { Command } from 'commander';
import { mkdir, opendir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownHtml } from '../render-html.js';

export interface BuildOptions {
  input: string;
  output: string;
  theme?: string;
  /** Programmatic traversal budget; CLI callers use the safe default. */
  maxEntries?: number;
  /** Programmatic directory-depth budget; CLI callers use the safe default. */
  maxDepth?: number;
}

export interface BuildResult {
  inputDir: string;
  outputDir: string;
  builtFiles: string[];
}

const DEFAULT_MAX_BUILD_ENTRIES = 100_000;
const DEFAULT_MAX_BUILD_DEPTH = 64;

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
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
    maxEntries: positiveLimit(opts.maxEntries, DEFAULT_MAX_BUILD_ENTRIES, 'entry'),
    maxDepth: positiveLimit(opts.maxDepth, DEFAULT_MAX_BUILD_DEPTH, 'depth'),
  });
  if (markdownFiles.length === 0) {
    throw new Error(`No markdown files found in ${inputDir}.`);
  }

  await mkdir(outputDir, { recursive: true });
  const builtFiles: string[] = [];

  for (const sourcePath of markdownFiles) {
    const relativePath = path.relative(inputDir, sourcePath);
    const outputPath = path.join(outputDir, replaceMarkdownExtension(relativePath));
    const source = await readFile(sourcePath, 'utf-8');
    const html = await renderMarkdownHtml(source, {
      title: titleFromPath(relativePath),
      sourcePath,
      assetRoot: inputDir,
      themeId: opts.theme,
      mode: 'static',
    });

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
  .action(async (opts: BuildOptions) => {
    try {
      const result = await runBuild(opts);
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

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1)
    throw new Error(`Invalid build ${label} limit.`);
  return selected;
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
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
