import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdown, stringifyMarkdown } from '@bendyline/squisq/markdown';

export const buildCommand = new Command('build')
  .description('Build markdown files into HTML output')
  .option('-i, --input <dir>', 'input directory', '.')
  .option('-o, --output <dir>', 'output directory', 'dist')
  .action(async (opts: { input: string; output: string }) => {
    const inputDir = path.resolve(opts.input);
    const outputDir = path.resolve(opts.output);

    if (!fs.existsSync(inputDir)) {
      console.error(`Input directory not found: ${inputDir}`);
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const files = fs.readdirSync(inputDir).filter((f) => f.endsWith('.md'));

    if (files.length === 0) {
      console.error('No markdown files found.');
      return;
    }

    for (const file of files) {
      const source = fs.readFileSync(path.join(inputDir, file), 'utf-8');
      const doc = parseMarkdown(source);
      const html = wrapHtml(file.replace(/\.md$/, ''), stringifyMarkdown(doc));
      const outFile = path.join(outputDir, file.replace(/\.md$/, '.html'));
      fs.writeFileSync(outFile, html);
      console.error(`Built: ${outFile}`);
    }

    console.error(`Done. ${files.length} file(s) built to ${outputDir}`);
  });

function wrapHtml(title: string, markdownContent: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 4px; }
    code { font-family: 'SF Mono', Menlo, monospace; }
  </style>
</head>
<body>
  <pre>${escapeHtml(markdownContent)}</pre>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
