import { expect } from 'chai';
import type { Doc } from '@bendyline/squisq/schemas';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown, setFrontmatterValues } from '@bendyline/squisq/markdown';
import {
  createPresentationPlan,
  serializePresentationPlan,
  PRESENTATION_KEY,
} from '@bendyline/squisq/transform';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

const BODY = 'The first full sentence must survive export. The second sentence must survive too.';
const SOURCE = `# Opening {[title]}\n\nAn authored introduction.\n\n## Details {[content]}\n\n${BODY}\n`;

describe('PowerPoint export without a transform', () => {
  const savedPlan = serializePresentationPlan(
    createPresentationPlan(markdownToDoc(parseMarkdown(SOURCE))),
  );
  const cases: Array<{ name: string; settings: Record<string, string> }> = [
    { name: 'no saved transform', settings: {} },
    { name: 'dynamic slides', settings: { 'squisq-transform': 'dynamic-slides' } },
    { name: 'legacy transform key', settings: { 'transform-style': 'dynamic-slides' } },
    { name: 'saved presentation plan', settings: { [PRESENTATION_KEY]: savedPlan } },
  ];

  for (const { name, settings } of cases) {
    it(`preserves authored layouts and full prose with ${name}`, async () => {
      let exported: Doc | undefined;
      let saved = false;
      await runExport(
        setFrontmatterValues(SOURCE, { ...settings, author: 'Export author' }),
        '/notes.md',
        { ...DEFAULT_OPTIONS, format: 'pptx', transformStyle: '' },
        null,
        () => {
          saved = true;
        },
        {
          docToPptx: async (doc) => {
            exported = doc;
            return new ArrayBuffer(0);
          },
          diagramRenderer: async () => null,
        },
      );

      expect(saved).to.equal(true);
      expect(exported).not.to.equal(undefined);
      expect(exported!.blocks.map(({ id, template }) => ({ id, template }))).to.deep.equal([
        { id: 'opening', template: 'title' },
        { id: 'details', template: 'content' },
      ]);
      expect(JSON.stringify(exported!.blocks[1].contents)).to.contain(BODY);
      expect(exported!.presentationApplied).not.to.equal(true);
      expect(exported!.frontmatter?.author).to.equal('Export author');
      expect(exported!.diagnostics ?? []).to.deep.equal([]);
    });
  }
});
