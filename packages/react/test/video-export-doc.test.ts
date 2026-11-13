import { expect } from 'chai';
import { buildPreviewDoc, markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown, setFrontmatterValues } from '@bendyline/squisq/markdown';
import {
  applyTransform,
  defaultPresentationHints,
  serializePresentationHints,
  PRESENTATION_HINTS_KEY,
  createPresentationPlan,
  serializePresentationPlan,
  PRESENTATION_KEY,
} from '@bendyline/squisq/transform';
import assert from 'node:assert/strict';
import type { Doc, MediaProvider } from '@bendyline/squisq/schemas';

import { PresentationInvalidError } from '../src/Export/export-errors.js';
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
  it('exports dynamic slides from current text without storing generated prose', async () => {
    const source = setFrontmatterValues('# Weather\n\nThe sky is pink.', {
      'squisq-transform': 'dynamic-slides',
      [PRESENTATION_HINTS_KEY]: serializePresentationHints(defaultPresentationHints()),
    });
    const first = await buildVideoExportDoc(source);
    const updated = await buildVideoExportDoc(source.replace('pink', 'blue'));
    expect(updated.presentationApplied).to.equal(true);
    expect(JSON.stringify(first.blocks)).to.contain('pink');
    expect(JSON.stringify(updated.blocks)).to.contain('blue').and.not.contain('pink');
    expect(JSON.stringify(updated.frontmatter)).not.to.contain('sky');
    expect(updated.blocks).to.deep.equal(
      buildPreviewDoc(markdownToDoc(parseMarkdown(source.replace('pink', 'blue')))).blocks,
    );
  });
  it('uses the saved presentation and refuses stale plans or missing narration timings', async () => {
    const text = '# An idea\n\nWrite your story.\n\n## Share it\n\nMake slides. Add narration.';
    const raw = markdownToDoc(parseMarkdown(text));
    const plan = createPresentationPlan(raw);
    const source = setFrontmatterValues(text, {
      [PRESENTATION_KEY]: serializePresentationPlan(plan),
      'squisq-transform': 'documentary',
    });
    const exported = await buildVideoExportDoc(source);
    expect(exported.presentationApplied).to.equal(true);
    expect(exported.blocks.map((block) => block.id)).to.deep.equal(
      plan.beats.map((beat) => beat.id),
    );
    expect(exported.audio.segments).to.deep.equal([]);
    await assert.rejects(
      buildVideoExportDoc(source + '\n\nChanged.'),
      (error: unknown) =>
        error instanceof PresentationInvalidError && /text has changed/.test(error.message),
    );
    await assert.rejects(
      buildVideoExportDoc(
        source.replace('# An idea', '{[audio src=take.webm anchor=document]}\n\n# An idea'),
      ),
      /timings are unavailable/,
    );
  });
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

  describe('a slide over a video', () => {
    // A caption-only slide over a long clip — the slide used to advance, and
    // the clip stop, after the caption's three-second reading time.
    const CLIP_DECK =
      '# Demo\n\n.\n\n<video src="video/demo.webm" controls width="480"></video>\n\n' +
      '# Next\n\nA sentence of its own.\n';

    const provider: MediaProvider = {
      resolveUrl: async (path) => (path === 'video/demo.webm' ? 'blob:demo-clip' : path),
      listMedia: async () => [],
      addMedia: async (name) => name,
      removeMedia: async () => {},
      dispose: () => {},
    };

    const createElement = document.createElement;
    afterEach(() => {
      document.createElement = createElement;
    });

    /** The DOM here cannot decode media: report `seconds` for the clip's URL. */
    function stubClipLength(seconds: number): void {
      document.createElement = ((tag: string) => {
        const el = createElement.call(document, tag);
        if (tag !== 'video') return el;
        let current = '';
        Object.defineProperty(el, 'duration', {
          get: () => (current === 'blob:demo-clip' ? seconds : Number.NaN),
        });
        Object.defineProperty(el, 'src', {
          get: () => current,
          set: (value: string) => {
            current = value;
            queueMicrotask(() =>
              el.dispatchEvent(new Event(value === 'blob:demo-clip' ? 'loadedmetadata' : 'error')),
            );
          },
        });
        (el as HTMLVideoElement).load = () => {};
        return el;
      }) as typeof document.createElement;
    }

    it('plays the whole clip, measured as the preview measures it', async () => {
      stubClipLength(101.5);
      const exported = await buildVideoExportDoc(CLIP_DECK, { mediaProvider: provider });
      expect(slide(exported, 'demo').duration).to.equal(101.5);
      expect(slide(exported, 'next').startTime).to.equal(101.5);
    });

    it('keeps the reading-time slide when the clip cannot be measured', async () => {
      stubClipLength(Number.NaN);
      const exported = await buildVideoExportDoc(CLIP_DECK.replace('demo.webm', 'gone.webm'), {
        mediaProvider: provider,
      });
      expect(slide(exported, 'demo').duration).to.equal(3);
    });
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
