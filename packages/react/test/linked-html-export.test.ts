import { expect } from 'chai';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { zipToContainer } from '@bendyline/squisq-formats/container';
import { runExport } from '../src/Export/run-export.js';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';

describe('linked HTML export of pending edits', function () {
  this.timeout(30_000);
  for (const htmlStyle of ['plain', 'rendered'] as const) {
    it(`uses the current entry and follows its unsaved links in ${htmlStyle} output`, async () => {
      const source = new MemoryContentContainer();
      await source.writeDocument('# Old saved version\n', 'entry.md');
      await source.writeDocument('# Linked content\n', 'linked.md');
      let bytes: ArrayBuffer | undefined;
      await runExport(
        '# Current unsaved version\n\n[New link](linked.md)\n',
        'entry.md',
        { ...DEFAULT_OPTIONS, format: 'html', htmlStyle, includeLinkedDocs: true },
        source,
        async (blob) => {
          bytes = await blob.arrayBuffer();
        },
      );
      expect(bytes).not.to.equal(undefined);
      const bundle = await zipToContainer(bytes!);
      const entry = new TextDecoder().decode((await bundle.readFile('entry.html'))!);
      expect(entry).to.contain('Current unsaved version');
      expect(entry).not.to.contain('Old saved version');
      expect(await bundle.readFile('linked.html')).not.to.equal(null);
    });
  }
});
