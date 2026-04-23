/**
 * DOCX → Markdown converter.
 *
 * Uses mammoth to extract the document's structure and produce Markdown.
 * Covers headings, paragraphs, emphasis, lists, and tables. Embedded
 * images are emitted as data: URIs; binary fidelity with the source is
 * not guaranteed (DOCX has features Markdown cannot represent).
 */

import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';

interface MammothResult {
  value: string;
}
interface MammothMarkdown {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<MammothResult>;
}

export async function docxToMarkdown(input: string | Buffer | Uint8Array): Promise<string> {
  const buffer = typeof input === 'string' ? await readFile(input) : Buffer.from(input);
  const m = mammoth as unknown as MammothMarkdown;
  const { value } = await m.convertToMarkdown({ buffer });
  return value.replace(/\r\n/g, '\n').trimEnd() + '\n';
}
