/**
 * PPTX → Markdown converter.
 *
 * PPTX is a zip archive of XML parts. We extract every `ppt/slides/slide*.xml`
 * in slide order and pull out the text runs (`<a:t>` elements), grouped by
 * paragraph (`<a:p>`). The first paragraph on each slide is treated as the
 * slide title (→ `##` heading); remaining paragraphs become body text.
 *
 * This is a best-effort text extractor — it does not preserve formatting,
 * shapes, images, or animations.
 */

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function extractSlideParagraphs(slideXml: string): string[] {
  const paragraphs: string[] = [];
  const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = paraRe.exec(slideXml)) !== null) {
    const body = pMatch[1];
    const parts: string[] = [];
    let rMatch: RegExpExecArray | null;
    while ((rMatch = runRe.exec(body)) !== null) {
      parts.push(decodeXmlEntities(rMatch[1]));
    }
    const text = parts.join('').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function slideOrder(name: string): number {
  const m = /slide(\d+)\.xml$/i.exec(name);
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

export async function pptxToMarkdown(input: string | Buffer | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? await readFile(input) : input;
  const zip = await JSZip.loadAsync(data);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => slideOrder(a) - slideOrder(b));

  if (slideNames.length === 0) {
    throw new Error('No slides found — not a valid PPTX file.');
  }

  const sections: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('string');
    const paragraphs = extractSlideParagraphs(xml);
    if (paragraphs.length === 0) continue;
    const [title, ...body] = paragraphs;
    const section = [`## ${title}`, ...body].join('\n\n');
    sections.push(section);
  }

  return sections.join('\n\n') + '\n';
}
