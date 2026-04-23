/**
 * PDF → Markdown converter.
 *
 * Uses pdfjs-dist (legacy build, Node-compatible) to extract the text of
 * each page. Text items are joined respecting vertical position so that
 * separate lines become separate paragraphs. Each PDF page becomes a
 * `## Page N` section so structure isn't lost completely.
 *
 * Heading/list structure in the source PDF is not recovered — PDFs
 * don't carry semantic structure reliably. This is a text extractor,
 * not a layout-preserving converter.
 */

import { readFile } from 'node:fs/promises';

export async function pdfToMarkdown(input: string | Buffer | Uint8Array): Promise<string> {
  const raw = typeof input === 'string' ? await readFile(input) : input;
  // pdfjs-dist rejects Buffer — copy into a plain Uint8Array.
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;

  const sections: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const lines: { y: number; text: string }[] = [];
    for (const item of content.items) {
      const i = item as { str?: string; transform?: number[]; hasEOL?: boolean };
      if (typeof i.str !== 'string') continue;
      const y = i.transform ? i.transform[5] : 0;
      const existing = lines.find((l) => Math.abs(l.y - y) < 2);
      if (existing) {
        existing.text += i.str;
      } else {
        lines.push({ y, text: i.str });
      }
    }
    lines.sort((a, b) => b.y - a.y);

    const pageText = lines
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (pageText) {
      sections.push(`## Page ${pageNum}\n\n${pageText}`);
    }
  }

  await doc.destroy();
  return sections.join('\n\n') + '\n';
}
