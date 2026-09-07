import { expect } from 'chai';
import JSZip from 'jszip';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { DocumentService } from '../src/mcp/document-service.js';
import { convertPreparedDocument } from '../src/mcp/conversion-service.js';

const markdown =
  '# Opening\n\n18 SKUs.\n\n## Evidence\n\nKeep this supporting detail.\n\n# Decision\n\nFund the next step.\n';

describe('explicit MCP PowerPoint heading boundaries', function () {
  this.timeout(30_000);
  for (const [slideBreak, expectedSlides] of [
    [undefined, 2],
    ['h1', 2],
    ['h2', 3],
    ['heading', 3],
  ] as const) {
    it(`${slideBreak} controls native slide count without adding a cover or losing text`, async () => {
      const artifacts = new ArtifactStore();
      try {
        const authority = await McpFileAuthority.create({});
        const document = await new DocumentService(authority, artifacts).prepare({
          kind: 'markdown',
          markdown,
          name: 'brief.md',
        });
        const outputs = await convertPreparedDocument(artifacts, document, {
          targets: [
            { format: 'pptx', options: slideBreak ? { slideBreak } : {} },
            { format: 'docx' },
          ],
        });
        const pptx = await JSZip.loadAsync(await artifacts.read(outputs[0]!.artifact.uri), {
          checkCRC32: true,
        });
        const slides = Object.keys(pptx.files).filter((name) =>
          /^ppt\/slides\/slide[0-9]+\.xml$/.test(name),
        );
        expect(slides).to.have.length(expectedSlides);
        const text = (
          await Promise.all(slides.map((name) => pptx.file(name)!.async('string')))
        ).join(' ');
        expect(text).to.include('Keep this supporting detail.');
        expect(text).to.include('Fund the next step.');
        const docx = await JSZip.loadAsync(await artifacts.read(outputs[1]!.artifact.uri), {
          checkCRC32: true,
        });
        expect(await docx.file('word/document.xml')!.async('string')).to.include('Evidence');
      } finally {
        await artifacts.dispose();
      }
    });
  }
  it('keeps authored boundaries through titled and themed exports', async () => {
    const artifacts = new ArtifactStore();
    try {
      const authority = await McpFileAuthority.create({});
      const document = await new DocumentService(authority, artifacts).prepare({
        kind: 'markdown',
        markdown,
        name: 'brief.md',
      });
      for (const themeId of ['minimalist', 'standard']) {
        const [output] = await convertPreparedDocument(artifacts, document, {
          targets: [{ format: 'pptx', options: { slideBreak: 'h1' } }],
          title: 'Boreal Desk Returns Pilot',
          themeId,
          autoTemplates: true,
        });
        const zip = await JSZip.loadAsync(await artifacts.read(output!.artifact.uri));
        const slides = Object.keys(zip.files).filter((name) =>
          /^ppt\/slides\/slide[0-9]+\.xml$/.test(name),
        );
        expect(slides, `theme ${themeId}`).to.have.length(2);
        const imported = await new DocumentService(authority, artifacts).prepare({
          kind: 'artifact',
          uri: output!.artifact.uri,
        });
        expect(imported.doc.blocks, 'reconstructed preview boundaries').to.have.length(2);
        const text = (
          await Promise.all(slides.map((name) => zip.file(name)!.async('string')))
        ).join(' ');
        expect(text).to.include('Keep this supporting detail.');
        expect(text).to.include('Fund the next step.');
      }
    } finally {
      await artifacts.dispose();
    }
  });
});
