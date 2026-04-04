/**
 * parse command — parse a markdown file and print its structure as JSON.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';

export const parseCommand = new Command('parse')
  .description('Parse a markdown file and print its structure as JSON')
  .argument('<input>', 'Path to a .md file')
  .action(async (inputPath: string) => {
    try {
      const resolvedInput = resolve(inputPath);
      const content = await readFile(resolvedInput, 'utf-8');
      const { parseMarkdown } = await import('@bendyline/squisq/markdown');
      const markdownDoc = parseMarkdown(content);

      // Compute summary stats
      const stats = {
        headingCount: 0,
        paragraphCount: 0,
        blockCount: markdownDoc.children?.length ?? 0,
      };

      if (markdownDoc.children) {
        for (const node of markdownDoc.children) {
          if (node.type === 'heading') stats.headingCount++;
          if (node.type === 'paragraph') stats.paragraphCount++;
        }
      }

      process.stdout.write(JSON.stringify({ stats, document: markdownDoc }, null, 2) + '\n');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });
