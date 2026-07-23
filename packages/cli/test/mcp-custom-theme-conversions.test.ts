import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  parseConversionResult,
  parseInspectionResult,
  type ConversionResult,
  type McpDiagnostic,
} from '@bendyline/docblocks/mcp';
import {
  markdownToDoc,
  readCustomTemplatesFromFrontmatter,
  readCustomThemesFromFrontmatter,
  writeCustomThemesToFrontmatter,
} from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { compileTheme, type Theme } from '@bendyline/squisq/schemas';
import { inferThemeFromFile } from '@bendyline/squisq-formats';
import { zipToContainer } from '@bendyline/squisq-formats/container';
import {
  CONTENT_TYPE_PPTX_PRESENTATION,
  CONTENT_TYPE_PPTX_SLIDE,
  CONTENT_TYPE_PPTX_SLIDE_LAYOUT,
  CONTENT_TYPE_PPTX_SLIDE_MASTER,
  CONTENT_TYPE_PPTX_THEME,
  createPackage,
  NS_DRAWINGML,
  NS_PML,
  NS_R,
  REL_OFFICE_DOCUMENT,
  REL_SLIDE,
  REL_SLIDE_LAYOUT,
  REL_SLIDE_MASTER,
  REL_THEME,
  xmlDeclaration,
} from '@bendyline/squisq-formats/ooxml';
import { inspectPptxLayouts } from '@bendyline/squisq-formats/pptx';
import JSZip from 'jszip';
import { decodePDFRawStream, PDFContentStream, PDFDocument, PDFRawStream } from 'pdf-lib';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const BRAND = compileTheme({
  id: 'custom-agent-brand',
  name: 'Agent Brand',
  seedColors: {
    primary: '#ff0088',
    background: '#123456',
    text: '#abcdef',
  },
});

const BRAND_MARKDOWN = `---
title: Agentic Brand Audit
squisq-theme: ${BRAND.id}
squisq-custom-themes: ${writeCustomThemesToFrontmatter([BRAND])}
---

# Heading One

Body copy rendered with the document-scoped brand.

:::note
This directive intentionally exercises fidelity diagnostics.
:::
`;

const TARGETS = [
  {
    format: 'docx',
    fidelity: 'editable-native',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    format: 'pptx',
    fidelity: 'editable-native',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  { format: 'pdf', fidelity: 'semantic', mimeType: 'application/pdf' },
  { format: 'html', fidelity: 'semantic', mimeType: 'text/html' },
] as const;

const ARCHIVE_LIMITS = {
  maxEntries: 2_048,
  maxEntryUncompressedBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
} as const;

describe('MCP linked custom-theme and inferred-layout workflows', function () {
  this.timeout(60_000);

  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('propagates a frontmatter-only custom theme through DOCX, PPTX, PDF, and HTML', async () => {
    const inspected = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'markdown', markdown: BRAND_MARKDOWN, name: 'brand-audit.md' },
    });
    expect(inspected.isError, inspected.text).to.equal(false);
    const inspection = parseInspectionResult(inspected.structuredContent);
    expect(inspection, 'canonical pre-conversion inspection').to.not.equal(null);
    expect(inspection?.theme).to.deep.equal({
      id: BRAND.id,
      name: BRAND.name,
      source: 'document',
      layouts: [],
    });

    const converted = await callTool(harness.client, 'convert_document', {
      source: { kind: 'markdown', markdown: BRAND_MARKDOWN, name: 'brand-audit.md' },
      targets: TARGETS.map(({ format, fidelity }) => ({ format, fidelity })),
    });
    expect(converted.isError, converted.text).to.equal(false);
    const rawResults = converted.structuredContent?.results;
    expect(rawResults).to.be.an('array').with.length(TARGETS.length);
    if (!Array.isArray(rawResults)) throw new Error('Expected MCP conversion results');
    const results = rawResults.map((result) => {
      const parsed = parseConversionResult(result);
      if (!parsed) throw new Error('Expected a canonical MCP conversion result');
      return parsed;
    });

    const expectedSourceSha256 = sha256(Buffer.from(BRAND_MARKDOWN, 'utf8'));
    for (const target of TARGETS) {
      const result = results.find((candidate) => candidate.targetFormat === target.format);
      expect(result, `${target.format} result`).to.not.equal(undefined);
      if (!result) throw new Error(`Missing ${target.format} conversion result`);

      expect(result).to.include({
        sourceFormat: 'md',
        targetFormat: target.format,
        fidelity: target.fidelity,
        appliedThemeId: BRAND.id,
        appliedTransformId: null,
        sourceAssetCount: 0,
      });
      expect(result.sourceAssets).to.deep.equal([]);
      expect(result.artifact).to.include({
        format: target.format,
        mimeType: target.mimeType,
        sourceFormat: 'md',
        sourceSha256: expectedSourceSha256,
      });
      expect(result.artifact.suggestedFilename).to.match(new RegExp(`\\.${target.format}$`, 'u'));
      expect(result.artifact.appliedOptions).to.deep.equal([
        { name: 'autoTemplates', value: true },
        { name: 'fidelity', value: target.fidelity },
      ]);
      expect(result.artifact.engineVersions.map((engine) => engine.name)).to.include(
        '@bendyline/squisq-cli',
      );
      expect(result.diagnostics).to.deep.equal(expectedFidelityDiagnostics(target.format));

      const artifactBytes = await readArtifactBytes(harness.client, result);
      expect(artifactBytes.byteLength).to.equal(result.artifact.size);
      expect(sha256(artifactBytes)).to.equal(result.artifact.sha256);

      const fetched = await callTool(harness.client, 'get_conversion_report', {
        artifactUri: result.artifact.uri,
      });
      expect(fetched.isError, fetched.text).to.equal(false);
      expect(parseConversionResult(fetched.structuredContent)).to.deep.equal(result);

      if (target.format === 'docx' || target.format === 'pptx') {
        const serialized = await zipText(artifactBytes);
        expect(serialized, `${target.format} custom background`).to.contain('123456');
      } else if (target.format === 'html') {
        const html = Buffer.from(artifactBytes).toString('utf8').toLowerCase();
        expect(html).to.contain('123456');
        expect(html).to.contain('abcdef');
      } else {
        const operators = await pdfContentOperators(artifactBytes);
        expect(operators).to.contain('1 0 0.5333333333333333 rg');
        expect(operators).to.contain('0.6705882352941176 0.803921568627451 0.9372549019607843 rg');
      }
    }
  });

  it('keeps MCP PPTX theme and layout inference aligned with the linked public APIs', async () => {
    const fixtureName = 'reference-layout.pptx';
    const fixture = await buildThemedTwoContentPptx();
    const fixtureBytes = new Uint8Array(fixture);
    await writeFile(join(harness.tmpDir, fixtureName), fixtureBytes);
    const sourceSha256 = sha256(fixtureBytes);
    const source = {
      kind: 'file' as const,
      rootId: await readableRootId(harness),
      path: fixtureName,
      format: 'pptx',
    };

    const linkedInspection = await inspectPptxLayouts(fixture, ARCHIVE_LIMITS);
    const linkedInference = await inferThemeFromFile(fixture, {
      format: 'pptx',
      inferLayouts: true,
      nameHint: fixtureName,
      ...ARCHIVE_LIMITS,
    });
    const expectedTheme = summarizeTheme(linkedInference.theme);
    const expectedLayouts = (linkedInference.layouts ?? []).map((layout) => ({
      id: layout.name,
      name: layout.label,
      description: layout.description ?? '',
    }));
    expect(expectedLayouts.map((layout) => layout.id)).to.include('pptx-two-content');
    expect(linkedInference.warnings).to.include(
      'theme: background and text colors are too close; deriving surfaces instead',
    );

    const inspectedLayouts = await callTool(harness.client, 'inspect_pptx_layouts', { source });
    expect(inspectedLayouts.isError, inspectedLayouts.text).to.equal(false);
    expect(inspectedLayouts.structuredContent).to.deep.equal({
      slideSize: linkedInspection.slideSize,
      layouts: linkedInspection.layouts.map((layout) => ({
        layoutPath: layout.layoutPath,
        name: layout.name,
        masterName: layout.masterName ?? null,
        type: layout.typeAttr ?? null,
        slideCount: layout.slideCount,
        verdict: layout.verdict,
        templateId: layout.builtinTemplate ?? layout.customTemplate?.name ?? null,
        notes: layout.notes ?? [],
      })),
    });

    const inferred = await callTool(harness.client, 'infer_theme_from_file', {
      source,
      inferLayouts: true,
    });
    expect(inferred.isError, inferred.text).to.equal(false);
    expect(inferred.structuredContent).to.deep.equal({
      sourceFormat: 'pptx',
      sourceSha256,
      theme: expectedTheme,
      layouts: expectedLayouts,
      warnings: linkedInference.warnings,
    });

    const targetMarkdown = '# Agent-built deck\n\n- Left item\n- Right item\n';
    const applied = await callTool(harness.client, 'apply_inferred_theme', {
      source: { kind: 'markdown', markdown: targetMarkdown, name: 'agent-deck.md' },
      themeSource: source,
      inferLayouts: true,
    });
    expect(applied.isError, applied.text).to.equal(false);
    const payload = applied.structuredContent as
      | {
          result: unknown;
          theme: unknown;
          layoutIds: string[];
          warnings: string[];
        }
      | undefined;
    if (!payload) throw new Error('Expected an inferred-theme payload');
    const result = parseConversionResult(payload.result);
    if (!result) throw new Error('Expected a canonical themed DBK conversion result');
    const expectedLayoutIds = expectedLayouts.map((layout) => layout.id);
    expect(payload.theme).to.deep.equal(expectedTheme);
    expect(payload.layoutIds).to.deep.equal(expectedLayoutIds);
    expect(payload.warnings).to.deep.equal(linkedInference.warnings);
    expect(result).to.include({
      sourceFormat: 'md',
      targetFormat: 'dbk',
      fidelity: 'semantic',
      appliedThemeId: linkedInference.theme.id,
      appliedTransformId: null,
      sourceAssetCount: 0,
    });
    expect(result.artifact).to.include({
      format: 'dbk',
      mimeType: 'application/zip',
      sourceFormat: 'md',
      sourceSha256: sha256(Buffer.from(targetMarkdown, 'utf8')),
    });
    expect(result.artifact.suggestedFilename).to.match(/\.dbk$/u);
    expect(result.artifact.appliedOptions).to.deep.equal([
      { name: 'fidelity', value: 'semantic' },
      { name: 'themeId', value: linkedInference.theme.id },
    ]);
    expect(result.diagnostics).to.deep.equal(
      linkedInference.warnings.map((warning) => warningDiagnostic(warning, 'pptx')),
    );

    const fetched = await callTool(harness.client, 'get_conversion_report', {
      artifactUri: result.artifact.uri,
    });
    expect(fetched.isError, fetched.text).to.equal(false);
    expect(parseConversionResult(fetched.structuredContent)).to.deep.equal(result);

    const artifactBytes = await readArtifactBytes(harness.client, result);
    expect(sha256(artifactBytes)).to.equal(result.artifact.sha256);
    const container = await zipToContainer(ownedArrayBuffer(artifactBytes), ARCHIVE_LIMITS);
    const embeddedMarkdown = await container.readDocument();
    if (embeddedMarkdown === null) throw new Error('The themed DBK did not contain Markdown');
    const embeddedDocument = parseMarkdown(embeddedMarkdown);
    expect(embeddedDocument.frontmatter?.['squisq-theme']).to.equal(linkedInference.theme.id);
    expect(readCustomThemesFromFrontmatter(embeddedDocument.frontmatter)).to.deep.equal([
      linkedInference.theme,
    ]);
    expect(readCustomTemplatesFromFrontmatter(embeddedDocument.frontmatter)).to.deep.equal(
      linkedInference.layouts,
    );
    const embeddedDoc = markdownToDoc(embeddedDocument);
    expect(embeddedDoc.themeId).to.equal(linkedInference.theme.id);
    expect(embeddedDoc.customTemplates?.map((layout) => layout.name)).to.deep.equal(
      expectedLayoutIds,
    );

    const inspectedArtifact = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'artifact', uri: result.artifact.uri },
    });
    expect(inspectedArtifact.isError, inspectedArtifact.text).to.equal(false);
    const artifactInspection = parseInspectionResult(inspectedArtifact.structuredContent);
    expect(artifactInspection, 'canonical themed DBK inspection').to.not.equal(null);
    expect(artifactInspection?.theme).to.deep.equal({
      id: linkedInference.theme.id,
      name: linkedInference.theme.name,
      source: 'document',
      layouts: expectedLayoutIds,
    });

    const described = await callTool(harness.client, 'describe_theme', {
      themeId: linkedInference.theme.id,
      source: { kind: 'artifact', uri: result.artifact.uri },
    });
    expect(described.isError, described.text).to.equal(false);
    expect(described.structuredContent).to.deep.equal({
      theme: expectedTheme,
      source: 'document',
    });
  });
});

function expectedFidelityDiagnostics(format: (typeof TARGETS)[number]['format']): McpDiagnostic[] {
  if (format === 'html') return [];
  return [
    warningDiagnostic(
      `${format.toUpperCase()} export omitted 1 unsupported Markdown node(s): containerDirective (1).`,
      format,
      'convert',
    ),
  ];
}

function warningDiagnostic(
  message: string,
  format: string,
  stage: McpDiagnostic['stage'] = 'transform',
): McpDiagnostic {
  const unsupported = /unsupported Markdown node/iu.test(message);
  const inferredThemeAdjustment = message.toLowerCase().startsWith('theme:');
  return {
    code: unsupported
      ? 'unsupported-markdown-node'
      : inferredThemeAdjustment
        ? 'theme-inference-adjusted'
        : 'fidelity-warning',
    severity: 'warning',
    stage,
    format,
    count: 1,
    message,
    remediation: unsupported
      ? 'Replace unsupported directives with standard Markdown or choose a target that retains them.'
      : inferredThemeAdjustment
        ? 'Review the inferred theme and adjust its colors before reusing it broadly.'
        : null,
    retryable: false,
    location: null,
  };
}

async function readableRootId(harness: McpHarness): Promise<string> {
  const listed = await callTool(harness.client, 'list_roots', {});
  expect(listed.isError, listed.text).to.equal(false);
  const roots = listed.structuredContent?.roots;
  if (!Array.isArray(roots)) throw new Error('Expected opaque MCP root descriptors');
  const root = roots.find(
    (candidate): candidate is { id: string; read: true } =>
      isRecord(candidate) && typeof candidate.id === 'string' && candidate.read === true,
  );
  if (!root) throw new Error('Expected a readable MCP root alias');
  return root.id;
}

async function readArtifactBytes(client: Client, result: ConversionResult): Promise<Uint8Array> {
  const resource = await client.readResource({ uri: result.artifact.uri });
  expect(resource.contents).to.have.length(1);
  const content = resource.contents[0];
  expect(content).to.include({
    uri: result.artifact.uri,
    mimeType: result.artifact.mimeType,
  });
  if (!content) throw new Error('Expected an artifact resource');
  if ('blob' in content) return Buffer.from(content.blob, 'base64');
  if ('text' in content) return Buffer.from(content.text, 'utf8');
  throw new Error('Artifact resource did not include text or binary content');
}

async function zipText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  let text = '';
  for (const [name, entry] of Object.entries(zip.files)) {
    if (/\.(xml|css|html|xhtml|rels)$/iu.test(name)) text += await entry.async('string');
  }
  return text.toLowerCase();
}

async function pdfContentOperators(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes);
  let operators = '';
  for (const page of document.getPages()) {
    const contents = page.node.normalizedEntries().Contents;
    if (!contents) continue;
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = contents.lookup(index);
      if (stream instanceof PDFRawStream) {
        operators += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      } else if (stream instanceof PDFContentStream) {
        operators += Buffer.from(stream.getUnencodedContents()).toString('latin1');
      }
    }
  }
  return operators;
}

function summarizeTheme(theme: Theme) {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description ?? '',
    colors: {
      primary: theme.colors.primary,
      secondary: theme.colors.secondary,
      background: theme.colors.background,
      text: theme.colors.text,
      highlight: theme.colors.highlight,
    },
    bodyFont: JSON.stringify(theme.typography.bodyFont),
    titleFont: JSON.stringify(theme.typography.titleFont),
  };
}

async function buildThemedTwoContentPptx(): Promise<ArrayBuffer> {
  const pkg = createPackage();
  pkg.addPart(
    'ppt/presentation.xml',
    `${xmlDeclaration()}<p:presentation xmlns:p="${NS_PML}" xmlns:r="${NS_R}">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst><p:sldId id="256" r:id="rIdS1"/></p:sldIdLst>` +
      `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    CONTENT_TYPE_PPTX_PRESENTATION,
  );
  pkg.addRelationship('', {
    id: 'rId1',
    type: REL_OFFICE_DOCUMENT,
    target: 'ppt/presentation.xml',
  });
  pkg.addRelationship('ppt/presentation.xml', {
    id: 'rIdM1',
    type: REL_SLIDE_MASTER,
    target: 'slideMasters/slideMaster1.xml',
  });
  pkg.addRelationship('ppt/presentation.xml', {
    id: 'rIdS1',
    type: REL_SLIDE,
    target: 'slides/slide1.xml',
  });

  pkg.addPart(
    'ppt/slideMasters/slideMaster1.xml',
    `${xmlDeclaration()}<p:sldMaster xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_R}" xmlns:p="${NS_PML}">` +
      `<p:cSld name="Agent Fixture Master"><p:spTree>${groupShapeProperties()}</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" ` +
      `accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" ` +
      `accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdL1"/></p:sldLayoutIdLst>` +
      `</p:sldMaster>`,
    CONTENT_TYPE_PPTX_SLIDE_MASTER,
  );
  pkg.addRelationship('ppt/slideMasters/slideMaster1.xml', {
    id: 'rIdT1',
    type: REL_THEME,
    target: '../theme/theme1.xml',
  });
  pkg.addRelationship('ppt/slideMasters/slideMaster1.xml', {
    id: 'rIdL1',
    type: REL_SLIDE_LAYOUT,
    target: '../slideLayouts/slideLayout1.xml',
  });

  pkg.addPart('ppt/theme/theme1.xml', fixtureThemeXml(), CONTENT_TYPE_PPTX_THEME);
  pkg.addPart(
    'ppt/slideLayouts/slideLayout1.xml',
    `${xmlDeclaration()}<p:sldLayout xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_R}" xmlns:p="${NS_PML}">` +
      `<p:cSld name="Two Content"><p:spTree>${groupShapeProperties()}` +
      placeholderShape('title', undefined, { x: 914400, y: 685800, cx: 10363200, cy: 1371600 }, 2) +
      placeholderShape(undefined, 1, { x: 609600, y: 1714500, cx: 5181600, cy: 4114800 }, 3) +
      placeholderShape(undefined, 2, { x: 6400800, y: 1714500, cx: 5181600, cy: 4114800 }, 4) +
      `</p:spTree></p:cSld></p:sldLayout>`,
    CONTENT_TYPE_PPTX_SLIDE_LAYOUT,
  );
  pkg.addRelationship('ppt/slideLayouts/slideLayout1.xml', {
    id: 'rIdM1',
    type: REL_SLIDE_MASTER,
    target: '../slideMasters/slideMaster1.xml',
  });

  pkg.addPart(
    'ppt/slides/slide1.xml',
    `${xmlDeclaration()}<p:sld xmlns:p="${NS_PML}" xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_R}">` +
      `<p:cSld><p:spTree>` +
      slideTextShape('title', undefined, ['Side by side']) +
      slideTextShape(undefined, 1, ['Left one', 'Left two']) +
      slideTextShape(undefined, 2, ['Right one']) +
      `</p:spTree></p:cSld></p:sld>`,
    CONTENT_TYPE_PPTX_SLIDE,
  );
  pkg.addRelationship('ppt/slides/slide1.xml', {
    id: 'rIdLo1',
    type: REL_SLIDE_LAYOUT,
    target: '../slideLayouts/slideLayout1.xml',
  });
  return pkg.toArrayBuffer();
}

function fixtureThemeXml(): string {
  return (
    `${xmlDeclaration()}<a:theme xmlns:a="${NS_DRAWINGML}" name="Agent Fixture Theme">` +
    `<a:themeElements><a:clrScheme name="Agent Fixture">` +
    `<a:dk1><a:srgbClr val="222222"/></a:dk1>` +
    `<a:lt1><a:srgbClr val="222222"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="30304a"/></a:dk2>` +
    `<a:lt2><a:srgbClr val="efefe4"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="ff0088"/></a:accent1>` +
    `<a:accent2><a:srgbClr val="00ff99"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="ffaa00"/></a:accent3>` +
    `<a:accent4><a:srgbClr val="00aaff"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="ffffff"/></a:accent5>` +
    `<a:accent6><a:srgbClr val="cc33ff"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0563c1"/></a:hlink>` +
    `<a:folHlink><a:srgbClr val="954f72"/></a:folHlink>` +
    `</a:clrScheme><a:fontScheme name="Agent Fixture">` +
    `<a:majorFont><a:latin typeface="Playfair Display"/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Aptos"/></a:minorFont>` +
    `</a:fontScheme></a:themeElements></a:theme>`
  );
}

function groupShapeProperties(): string {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
}

function placeholderShape(
  type: string | undefined,
  index: number | undefined,
  rect: { x: number; y: number; cx: number; cy: number },
  id: number,
): string {
  const typeAttribute = type ? ` type="${type}"` : '';
  const indexAttribute = index === undefined ? '' : ` idx="${index}"`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="ph${id}"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph${typeAttribute}${indexAttribute}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${rect.x}" y="${rect.y}"/>` +
    `<a:ext cx="${rect.cx}" cy="${rect.cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`
  );
}

function slideTextShape(
  type: string | undefined,
  index: number | undefined,
  texts: readonly string[],
): string {
  const typeAttribute = type ? ` type="${type}"` : '';
  const indexAttribute = index === undefined ? '' : ` idx="${index}"`;
  const paragraphs = texts.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('');
  return (
    `<p:sp><p:nvSpPr><p:nvPr><p:ph${typeAttribute}${indexAttribute}/></p:nvPr></p:nvSpPr>` +
    `<p:txBody>${paragraphs}</p:txBody></p:sp>`
  );
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
