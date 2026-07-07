import { Command } from 'commander';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownHtml } from '../render-html.js';

export interface BuildOptions {
  input: string;
  output: string;
  theme?: string;
}

export interface BuildResult {
  inputDir: string;
  outputDir: string;
  builtFiles: string[];
}

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const inputDir = path.resolve(opts.input);
  const outputDir = path.resolve(opts.output);
  const inputStat = await stat(inputDir).catch(() => null);

  if (!inputStat?.isDirectory()) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const markdownFiles = await listMarkdownFiles(inputDir);
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

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(absolutePath);
      return isMarkdownFile(entry.name) ? [absolutePath] : [];
    }),
  );

  return files.flat().sort((a, b) => a.localeCompare(b));
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
