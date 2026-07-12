import { expect } from 'chai';

describe('MCP Squisq API contract', () => {
  it('loads every public Squisq entry point used by MCP tools', async () => {
    const [
      markdown,
      generate,
      doc,
      transform,
      schemas,
      storage,
      cli,
      docx,
      pptx,
      pdf,
      html,
      container,
      standalone,
    ] = await Promise.all([
      import('@bendyline/squisq/markdown'),
      import('@bendyline/squisq/generate'),
      import('@bendyline/squisq/doc'),
      import('@bendyline/squisq/transform'),
      import('@bendyline/squisq/schemas'),
      import('@bendyline/squisq/storage'),
      import('@bendyline/squisq-cli/api'),
      import('@bendyline/squisq-formats/docx'),
      import('@bendyline/squisq-formats/pptx'),
      import('@bendyline/squisq-formats/pdf'),
      import('@bendyline/squisq-formats/html'),
      import('@bendyline/squisq-formats/container'),
      import('@bendyline/squisq-react/standalone-source'),
    ]);

    for (const api of [
      markdown.parseMarkdown,
      markdown.stringifyMarkdown,
      markdown.readFrontmatterThemeId,
    ]) {
      expect(api).to.be.a('function');
    }
    for (const api of [generate.extractContent, generate.stripMarkdown]) {
      expect(api).to.be.a('function');
    }
    for (const api of [
      doc.markdownToDoc,
      doc.docToMarkdown,
      doc.countBlocks,
      doc.readCustomThemesFromFrontmatter,
    ]) {
      expect(api).to.be.a('function');
    }
    for (const api of [
      transform.applyTransform,
      transform.extractDocImages,
      transform.getTransformStyleIds,
      transform.getTransformStyleSummaries,
    ]) {
      expect(api).to.be.a('function');
    }
    for (const api of [schemas.getAvailableThemes, schemas.getThemeSummaries]) {
      expect(api).to.be.a('function');
    }
    expect(storage.MemoryContentContainer).to.be.a('function');
    expect(cli.readInput).to.be.a('function');
    expect(cli.renderDocToMp4).to.be.a('function');
    expect(docx.markdownDocToDocx).to.be.a('function');
    expect(docx.docxToMarkdownDoc).to.be.a('function');
    expect(docx.docxToContainer).to.be.a('function');
    expect(pptx.markdownDocToPptx).to.be.a('function');
    expect(pptx.pptxToMarkdownDoc).to.be.a('function');
    expect(pptx.pptxToContainer).to.be.a('function');
    expect(pdf.markdownDocToPdf).to.be.a('function');
    expect(pdf.pdfToMarkdownDoc).to.be.a('function');
    expect(html.docToHtml).to.be.a('function');
    expect(html.collectImagePaths).to.be.a('function');
    expect(container.containerToZip).to.be.a('function');
    expect(standalone.PLAYER_BUNDLE).to.be.a('string').with.length.greaterThan(1_000);
  });

  it('keeps theme and transform registries internally consistent', async () => {
    const [{ getAvailableThemes, getThemeSummaries }, transform] = await Promise.all([
      import('@bendyline/squisq/schemas'),
      import('@bendyline/squisq/transform'),
    ]);

    const themeIds = getAvailableThemes();
    const themeSummaryIds = getThemeSummaries().map(({ id }) => id);
    expect(themeIds).to.have.length.greaterThan(0);
    expect(new Set(themeIds).size).to.equal(themeIds.length);
    expect(themeSummaryIds).to.deep.equal(themeIds);

    const styleIds = transform.getTransformStyleIds();
    const styleSummaryIds = transform.getTransformStyleSummaries().map(({ id }) => id);
    expect(styleIds).to.have.length.greaterThan(0);
    expect(new Set(styleIds).size).to.equal(styleIds.length);
    expect(styleSummaryIds).to.deep.equal(styleIds);
    expect(styleIds).to.include('documentary');
  });
});
