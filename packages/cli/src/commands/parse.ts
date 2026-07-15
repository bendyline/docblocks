/**
 * parse command — parse a markdown file and print its structure as JSON.
 */

import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { decodeUtf8Text } from '@bendyline/docblocks/filesystem';

const DEFAULT_MAX_PARSE_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PARSE_OUTPUT_BYTES = 128 * 1024 * 1024;

export interface ParseOptions {
  /** Programmatic input budget; CLI callers use the safe default. */
  readonly maxInputBytes?: number;
  /** Programmatic JSON output budget; CLI callers use the safe default. */
  readonly maxOutputBytes?: number;
}

export async function runParse(inputPath: string, options: ParseOptions = {}): Promise<string> {
  const resolvedInput = resolve(inputPath);
  const maxInputBytes = positiveLimit(
    options.maxInputBytes,
    DEFAULT_MAX_PARSE_INPUT_BYTES,
    'input byte',
  );
  const maxOutputBytes = positiveLimit(
    options.maxOutputBytes,
    DEFAULT_MAX_PARSE_OUTPUT_BYTES,
    'output byte',
  );
  const bytes = await readBoundedFile(resolvedInput, maxInputBytes);
  const content = decodeUtf8Text(bytes, { label: 'Parse input', path: resolvedInput });
  const { parseMarkdown } = await import('@bendyline/squisq/markdown');
  const markdownDoc = parseMarkdown(content);

  const stats = {
    headingCount: 0,
    paragraphCount: 0,
    blockCount: markdownDoc.children?.length ?? 0,
  };

  if (markdownDoc.children) {
    for (const node of markdownDoc.children) {
      if (node.type === 'heading') stats.headingCount += 1;
      if (node.type === 'paragraph') stats.paragraphCount += 1;
    }
  }

  const serialized = `${JSON.stringify({ stats, document: markdownDoc }, null, 2)}\n`;
  const outputBytes = Buffer.byteLength(serialized, 'utf8');
  if (outputBytes > maxOutputBytes) {
    throw new Error(`Parse output exceeds the ${maxOutputBytes}-byte limit.`);
  }
  return serialized;
}

async function readBoundedFile(inputPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(inputPath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Parse input is not a file: ${inputPath}`);
    if (info.size > maxBytes) throw new Error(`Parse input exceeds the ${maxBytes}-byte limit.`);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(`Parse input exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

export const parseCommand = new Command('parse')
  .description('Parse a markdown file and print its structure as JSON')
  .argument('<input>', 'Path to UTF-8 Markdown content')
  .action(async (inputPath: string) => {
    try {
      process.stdout.write(await runParse(inputPath));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1)
    throw new Error(`Invalid parse ${label} limit.`);
  return selected;
}
