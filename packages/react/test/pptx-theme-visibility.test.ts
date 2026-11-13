import { expect } from 'chai';
import { getPartXml, NS_PML, openPackage } from '@bendyline/squisq-formats/ooxml';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

describe('PowerPoint theme visibility', () => {
  it('exports Gezellig content without an opaque grain overlay', async () => {
    let saved: Blob | undefined;
    await runExport(
      '---\nsquisq-theme: gezellig\nsquisq-cover-slide: false\n---\n' +
        '# Opening {[title]}\n\n## Details {[content]}\n\nVisible slide content.',
      '/presentation.md',
      { ...DEFAULT_OPTIONS, format: 'pptx', themeId: 'gezellig', transformStyle: '' },
      null,
      (blob) => {
        saved = blob;
      },
      { diagramRenderer: async () => null },
    );

    expect(saved).not.to.equal(undefined);
    const pkg = await openPackage(await saved!.arrayBuffer());
    const presentation = await getPartXml(pkg, 'ppt/presentation.xml');
    expect(presentation!.getElementsByTagNameNS(NS_PML, 'sldId').length).to.equal(2);
    for (let index = 1; index <= 2; index++) {
      const slide = await getPartXml(pkg, `ppt/slides/slide${index}.xml`);
      const names = Array.from(slide!.getElementsByTagNameNS(NS_PML, 'cNvPr')).map((node) =>
        node.getAttribute('name'),
      );
      expect(names).not.to.include('persistent-grain');
      expect(slide!.documentElement.textContent).to.include(
        index === 1 ? 'Opening' : 'Visible slide content.',
      );
    }
  });

  it('keeps the chosen Standard theme when a transform is applied', async () => {
    // The Documentary transform suggests its own dark theme. A document with
    // no theme previews in Standard, and the dialog says Standard, so the deck
    // must be Standard too (it came out dark navy).
    let saved: Blob | undefined;
    await runExport(
      '# Offsite plan\n\nTwo days by the water.\n\n## Agenda\n\n- Arrive\n- Workshop\n',
      '/offsite.md',
      { ...DEFAULT_OPTIONS, format: 'pptx', themeId: 'standard', transformStyle: 'documentary' },
      null,
      (blob) => {
        saved = blob;
      },
      { diagramRenderer: async () => null },
    );
    const pkg = await openPackage(await saved!.arrayBuffer());
    const theme = await getPartXml(pkg, 'ppt/theme/theme1.xml');
    expect(theme!.documentElement.getAttribute('name')).to.equal('Standard Light');
  });
});
