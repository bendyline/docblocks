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
      recommend,
      formats,
      video,
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
      import('@bendyline/squisq/recommend'),
      import('@bendyline/squisq-formats'),
      import('@bendyline/squisq-video'),
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
      doc.flattenBlocks,
      doc.validateMarkdownSource,
      doc.getAvailableTemplates,
      doc.resolveThemeForDoc,
      doc.readCustomThemesFromFrontmatter,
    ]) {
      expect(api).to.be.a('function');
    }
    expect(Object.keys(doc.TEMPLATE_METADATA).length).to.be.greaterThan(0);
    expect(Object.keys(doc.TEMPLATE_INPUT_DESCRIPTORS).length).to.be.greaterThan(0);
    for (const api of [
      transform.applyTransform,
      transform.analyzeBlocks,
      transform.extractDocImages,
      transform.getTransformStyleIds,
      transform.getTransformStyleSummaries,
    ]) {
      expect(api).to.be.a('function');
    }
    for (const api of [
      schemas.getAvailableThemes,
      schemas.getThemeSummaries,
      schemas.getDocPlaybackDuration,
    ]) {
      expect(api).to.be.a('function');
    }
    expect(Object.keys(schemas.THEMES).length).to.be.greaterThan(0);
    expect(storage.MemoryContentContainer).to.be.a('function');
    for (const api of [
      cli.readInput,
      cli.createCliRegistry,
      cli.prepareConversion,
      cli.convert,
      cli.renderDocToMp4,
      cli.renderDocToGif,
      cli.extractThumbnails,
    ]) {
      expect(api).to.be.a('function');
    }
    expect(cli.CapturedFrameBudgetError).to.be.a('function');
    expect(cli.MAX_CAPTURED_FRAME_BYTES).to.be.a('number').and.greaterThan(0);

    type ExtractThumbnailsOptions = Parameters<typeof cli.extractThumbnails>[0];
    const signal = new AbortController().signal;
    const extractorContract = {
      videoPath: 'preview.gif',
      outputDir: 'thumbnails',
      slug: 'preview',
      sizes: [{ name: 'small', width: 320, height: 180, filter: 'scale=320:180' }],
      signal,
    } satisfies ExtractThumbnailsOptions;
    const acceptedSignal: ExtractThumbnailsOptions['signal'] = extractorContract.signal;
    expect(acceptedSignal).to.equal(signal);
    type InferThemeOptions = NonNullable<Parameters<typeof formats.inferThemeFromFile>[1]>;
    const inferContract = { signal } satisfies InferThemeOptions;
    const acceptedInferSignal: InferThemeOptions['signal'] = inferContract.signal;
    expect(acceptedInferSignal).to.equal(signal);
    expect(docx.markdownDocToDocx).to.be.a('function');
    expect(docx.docxToMarkdownDoc).to.be.a('function');
    expect(docx.docxToContainer).to.be.a('function');
    expect(pptx.markdownDocToPptx).to.be.a('function');
    expect(pptx.pptxToMarkdownDoc).to.be.a('function');
    expect(pptx.pptxToContainer).to.be.a('function');
    expect(pptx.inspectPptxLayouts).to.be.a('function');
    type InspectPptxLayoutsOptions = NonNullable<Parameters<typeof pptx.inspectPptxLayouts>[1]>;
    const inspectContract = { signal } satisfies InspectPptxLayoutsOptions;
    const acceptedInspectSignal: InspectPptxLayoutsOptions['signal'] = inspectContract.signal;
    expect(acceptedInspectSignal).to.equal(signal);
    expect(pdf.markdownDocToPdf).to.be.a('function');
    expect(pdf.pdfToMarkdownDoc).to.be.a('function');
    expect(html.docToHtml).to.be.a('function');
    expect(html.collectImagePaths).to.be.a('function');
    expect(container.containerToZip).to.be.a('function');
    expect(container.zipToContainer).to.be.a('function');
    expect(recommend.profileBlockContents).to.be.a('function');
    expect(recommend.recommendTemplatesForBlock).to.be.a('function');
    expect(formats.inferThemeFromFile).to.be.a('function');
    expect(video.generateRenderHtml).to.be.a('function');
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
