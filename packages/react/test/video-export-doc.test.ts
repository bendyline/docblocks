import { expect } from 'chai';
import { buildPreviewDoc, markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { applyTransform } from '@bendyline/squisq/transform';
import type { Doc } from '@bendyline/squisq/schemas';

import { buildVideoExportDoc, persistedTransformStyle } from '../src/Export/video-export-doc.js';

// Trimmed from the document that exposed the bug: an untemplated `##` section
// whose body is a table played in the preview but exported as a title card.
const TALK = `---
squisq-theme: gezellig
squisq-captions: off
---

# Everything You Need to Know about Local Models {[sectionHeader]}

- Terms and terminology

### What's in a model name {[factCard]}

Take: Qwen 3.6 35B-A3B-Q4

## Parameters

Parameters are the "size of the brain"

| Model | Size | Tasks passed |
| --- | --- | --- |
| qwen3.5-2b | 2B | 6/33 (18%) |
| qwen3.5-27b | 27B | 30/33 (91%) |

*(performance measured on a Windows 11 PC)*
`;

function slides(doc: Doc): Array<Record<string, unknown>> {
  return doc.blocks as unknown as Array<Record<string, unknown>>;
}

function slide(doc: Doc, id: string): Record<string, unknown> {
  const found = slides(doc).find((entry) => entry.id === id);
  if (!found) throw new Error(`No slide ${id}`);
  return found;
}

function containsTable(contents: unknown): boolean {
  return (
    Array.isArray(contents) &&
    contents.some(
      (node) =>
        typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'table',
    )
  );
}

describe('video export document', () => {
  it('exports a section with a body as a content slide that keeps its table', async () => {
    // The raw document is what the exporter used to receive: title only.
    const raw = markdownToDoc(parseMarkdown(TALK));
    const rawParameters = raw.blocks
      .flatMap((block) => [block, ...(block.children ?? [])])
      .find((block) => block.id === 'parameters');
    expect(rawParameters?.template).to.equal('sectionHeader');

    const exported = await buildVideoExportDoc(TALK, { fileName: 'notes/perf.md' });
    const parameters = slide(exported, 'parameters');
    expect(parameters.template).to.equal('content');
    expect(parameters.title).to.equal('Parameters');
    expect(containsTable(parameters.contents)).to.equal(true);
  });

  // The preview renders buildPreviewDoc's slides but takes its audio from the
  // content document; the export must do the same.
  function previewProjection(contentDoc: Doc): Doc {
    return { ...buildPreviewDoc(contentDoc, { documentTitle: 'perf' }), audio: contentDoc.audio };
  }

  it('is exactly the projection the Video preview plays when no transform is chosen', async () => {
    const exported = await buildVideoExportDoc(TALK, { fileName: 'perf.md' });
    expect(exported).to.deep.equal(previewProjection(markdownToDoc(parseMarkdown(TALK))));
  });

  it('applies the transform the preview persisted to frontmatter', async () => {
    const source = TALK.replace(
      'squisq-captions: off',
      'squisq-captions: off\nsquisq-transform: documentary',
    );
    const exported = await buildVideoExportDoc(source, { fileName: 'perf.md' });
    expect(exported).to.deep.equal(
      previewProjection(applyTransform(markdownToDoc(parseMarkdown(source)), 'documentary').doc),
    );
  });

  it('never hands the exporter the live player’s placeholder audio', async () => {
    // buildPreviewDoc alone would add `{ src: '' }` for a doc without
    // narration, which the exporter would try to fetch and mix.
    expect(buildPreviewDoc(markdownToDoc(parseMarkdown(TALK))).audio.segments).to.have.length(1);
    const exported = await buildVideoExportDoc(TALK, { fileName: 'perf.md' });
    expect(exported.audio.segments).to.deep.equal([]);
  });

  it('titles a heading-less opening with the file name, as the preview does', async () => {
    const exported = await buildVideoExportDoc('Opening words.\n\n## Next\n\nMore.\n', {
      fileName: 'notes/Longview Plan.md',
    });
    expect(slides(exported)[0]?.title).to.equal('Longview Plan');
  });
});

describe('persisted transform style', () => {
  const known = new Set(['documentary', 'data-driven']);

  it('reads the canonical key, then the legacy one', () => {
    expect(persistedTransformStyle({ 'squisq-transform': 'documentary' }, known)).to.equal(
      'documentary',
    );
    expect(persistedTransformStyle({ 'transform-style': 'Documentary' }, known)).to.equal(
      'documentary',
    );
  });

  it('lets a present canonical key win even when its value is unusable', () => {
    expect(
      persistedTransformStyle(
        { 'squisq-transform': 'no-such-style', 'transform-style': 'documentary' },
        known,
      ),
    ).to.equal(null);
  });

  it('accepts the legacy dataDriven spelling and nothing unknown', () => {
    expect(persistedTransformStyle({ 'squisq-transform': 'dataDriven' }, known)).to.equal(
      'data-driven',
    );
    expect(persistedTransformStyle({ 'squisq-transform': 'data driven' }, known)).to.equal(
      'data-driven',
    );
    expect(persistedTransformStyle({ 'squisq-transform': 42 }, known)).to.equal(null);
    expect(persistedTransformStyle(undefined, known)).to.equal(null);
  });
});
