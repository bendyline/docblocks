import { expect } from 'chai';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import * as mcpPackage from '@bendyline/docblocks/mcp';
import {
  DOCBLOCKS_MCP_WIRE_VERSION,
  DOCBLOCKS_MCP_TOOL_NAMES,
  MCP_WIRE_LIMITS,
  parseArtifactRef,
  parseComparisonResult,
  parseConversionResult,
  parseDocumentSource,
  parseInspectionResult,
  parseMaterializationOptions,
  parseMcpDiagnostic,
  parseMcpErrorResult,
  parsePreviewResult,
  parseValidationResult,
  type ArtifactRef,
  type McpDiagnostic,
} from '../src/mcp/index.js';
import {
  DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS,
  DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS,
  artifactRefSchema,
  comparisonResultSchema,
  conversionResultSchema,
  documentSourceSchema,
  inspectionResultSchema,
  materializationOptionsSchema,
  previewResultSchema,
  toolOutputSchema,
} from '../src/mcp/zod.js';

const ARTIFACT_HASH = 'a'.repeat(64);
const SOURCE_HASH = 'b'.repeat(64);

function artifact(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    id: 'artifact-1',
    uri: 'docblocks://artifacts/artifact-1',
    format: 'pdf',
    mimeType: 'application/pdf',
    size: 1_024,
    sha256: ARTIFACT_HASH,
    sourceFormat: 'md',
    sourceSha256: SOURCE_HASH,
    suggestedFilename: 'report.pdf',
    appliedOptions: [{ name: 'pageSize', value: 'letter' }],
    engineVersions: [{ name: 'squisq', version: '2.0.0' }],
    createdAt: '2026-07-13T12:00:00.000Z',
    expiresAt: '2026-07-13T13:00:00.000Z',
    ...overrides,
  };
}

function diagnostic(overrides: Partial<McpDiagnostic> = {}): McpDiagnostic {
  return {
    code: 'image-degraded',
    severity: 'warning',
    stage: 'convert',
    format: 'pdf',
    count: 1,
    message: 'One image could not be embedded.',
    remediation: 'Use rendered-fidelity output.',
    retryable: false,
    location: { kind: 'block', blockId: 'block-1', nodeType: 'image' },
    ...overrides,
  };
}

function conversionResultValue() {
  return {
    version: DOCBLOCKS_MCP_WIRE_VERSION,
    kind: 'conversion' as const,
    sourceFormat: 'md',
    targetFormat: 'pdf',
    artifact: artifact(),
    fidelity: 'editable-native' as const,
    appliedThemeId: null,
    appliedTransformId: null,
    sourceAssets: [],
    sourceAssetCount: 0,
    diagnostics: [],
  };
}

function themeDescriptionValue() {
  return {
    id: 'modern',
    name: 'Modern',
    description: 'A restrained visual theme.',
    colors: {
      primary: '#224488',
      secondary: '#cc8844',
      background: '#ffffff',
      text: '#111111',
      highlight: '#ffee88',
    },
    bodyFont: 'Inter',
    titleFont: 'Inter Display',
  };
}

function templateProfileValue() {
  return {
    hasImage: false,
    imageCount: 0,
    hasVideo: false,
    hasBlockquote: false,
    hasList: true,
    hasTable: false,
    hasDate: false,
    hasNumberHighlight: false,
    wordCount: 12,
    hasAsciiDiagram: false,
    hasTimeline: false,
    hasTree: false,
  };
}

describe('DocBlocks MCP wire contracts', () => {
  it('is available from the isolated MCP package entry point', () => {
    expect(mcpPackage.parseDocumentSource).to.be.a('function');
    expect(mcpPackage.DOCBLOCKS_MCP_WIRE_VERSION).to.equal(1);
  });

  describe('artifact references', () => {
    it('accepts exact bounded artifact metadata with conversion provenance', () => {
      expect(parseArtifactRef(artifact())).to.deep.equal(artifact());
      const scopedEngine = artifact({
        engineVersions: [{ name: '@bendyline/squisq-cli', version: '2.0.0' }],
      });
      expect(parseArtifactRef(scopedEngine)).to.deep.equal(scopedEngine);
    });

    it('rejects unknown fields and an artifact URI which does not name its id', () => {
      expect(parseArtifactRef({ ...artifact(), authority: 'path' })).to.equal(null);
      expect(
        parseArtifactRef({ ...artifact(), uri: 'docblocks://artifacts/different-artifact' }),
      ).to.equal(null);
      expect(parseArtifactRef({ ...artifact(), uri: 'docblocks://ARTIFACTS/artifact-1' })).to.equal(
        null,
      );
    });

    it('rejects malformed provenance, duplicates, oversized artifacts, and unsafe filenames', () => {
      expect(parseArtifactRef({ ...artifact(), sourceSha256: 'not-a-hash' })).to.equal(null);
      expect(
        parseArtifactRef({
          ...artifact(),
          engineVersions: [{ name: '@scope/../engine', version: '2.0.0' }],
        }),
      ).to.equal(null);
      expect(
        parseArtifactRef({
          ...artifact(),
          appliedOptions: [
            { name: 'pageSize', value: 'letter' },
            { name: 'pageSize', value: 'a4' },
          ],
        }),
      ).to.equal(null);
      expect(parseArtifactRef({ ...artifact(), size: MCP_WIRE_LIMITS.artifactBytes + 1 })).to.equal(
        null,
      );
      expect(parseArtifactRef({ ...artifact(), suggestedFilename: '../report.pdf' })).to.equal(
        null,
      );
      expect(parseArtifactRef({ ...artifact(), expiresAt: '2026-07-13T11:59:59.999Z' })).to.equal(
        null,
      );
    });

    it('keeps the artifact-size Zod ceiling aligned with the exact parser', () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const maximum = artifact({
        id,
        uri: `docblocks://artifacts/${id}`,
        size: MCP_WIRE_LIMITS.artifactBytes,
      });
      const oversized = { ...maximum, size: MCP_WIRE_LIMITS.artifactBytes + 1 };
      expect(artifactRefSchema.safeParse(maximum).success).to.equal(true);
      expect(parseArtifactRef(maximum)).to.deep.equal(maximum);
      expect(artifactRefSchema.safeParse(oversized).success).to.equal(false);
      expect(parseArtifactRef(oversized)).to.equal(null);
    });

    it('keeps semantic artifact invariants aligned between Zod and the exact parser', () => {
      const invalidArtifacts = [
        { ...artifact(), uri: 'docblocks://artifacts/different-artifact' },
        { ...artifact(), suggestedFilename: '../report.pdf' },
        { ...artifact(), expiresAt: '2026-07-13T11:59:59.999Z' },
        {
          ...artifact(),
          appliedOptions: [
            { name: 'pageSize', value: 'letter' },
            { name: 'pageSize', value: 'a4' },
          ],
        },
        {
          ...artifact(),
          engineVersions: [
            { name: 'squisq', version: '2.0.0' },
            { name: 'squisq', version: '2.0.1' },
          ],
        },
      ];

      for (const candidate of invalidArtifacts) {
        expect(parseArtifactRef(candidate), JSON.stringify(candidate)).to.equal(null);
        expect(artifactRefSchema.safeParse(candidate).success, JSON.stringify(candidate)).to.equal(
          false,
        );
      }
    });
  });

  describe('document sources', () => {
    it('accepts inline Markdown, scoped files, and artifact URIs', () => {
      expect(
        parseDocumentSource({ kind: 'markdown', markdown: '# Hello', name: null }),
      ).to.deep.equal({ kind: 'markdown', markdown: '# Hello', name: null });
      expect(
        parseDocumentSource({
          kind: 'file',
          rootId: 'source-root',
          path: 'documents/report.docx',
          format: 'docx',
        }),
      ).to.deep.equal({
        kind: 'file',
        rootId: 'source-root',
        path: 'documents/report.docx',
        format: 'docx',
      });
      expect(
        parseDocumentSource({ kind: 'artifact', uri: 'docblocks://artifacts/artifact-1' }),
      ).to.deep.equal({ kind: 'artifact', uri: 'docblocks://artifacts/artifact-1' });
    });

    it('accepts bundle assets backed by exactly one file or artifact source', () => {
      const source = {
        kind: 'bundle',
        markdown: '![Chart](media/chart.png)',
        name: 'report.md',
        assets: [
          {
            path: 'media/chart.png',
            source: { kind: 'file', rootId: 'source-root', path: 'images/chart.png' },
            mimeType: 'image/png',
            altText: 'Quarterly sales chart',
            credit: null,
            license: null,
          },
          {
            path: 'media/logo.svg',
            source: { kind: 'artifact', uri: 'docblocks://artifacts/logo-1' },
            mimeType: null,
            altText: 'Company logo',
            credit: 'Example Inc.',
            license: 'CC-BY-4.0',
          },
        ],
      };

      expect(parseDocumentSource(source)).to.deep.equal(source);
    });

    it('rejects traversal, non-canonical paths, duplicate bundle paths, and mixed content authority', () => {
      expect(
        parseDocumentSource({ kind: 'file', rootId: 'root', path: '../secret.docx', format: null }),
      ).to.equal(null);
      expect(
        parseDocumentSource({
          kind: 'file',
          rootId: 'root',
          path: 'docs//report.md',
          format: null,
        }),
      ).to.equal(null);

      const asset = {
        path: 'media/chart.png',
        source: { kind: 'artifact', uri: 'docblocks://artifacts/chart-1' },
        mimeType: 'image/png',
        altText: null,
        credit: null,
        license: null,
      };
      expect(
        parseDocumentSource({
          kind: 'bundle',
          markdown: '',
          name: null,
          assets: [asset, asset],
        }),
      ).to.equal(null);
      expect(
        parseDocumentSource({
          kind: 'bundle',
          markdown: '',
          name: null,
          assets: [
            {
              ...asset,
              source: {
                kind: 'artifact',
                uri: 'docblocks://artifacts/chart-1',
                rootId: 'smuggled-root',
              },
            },
          ],
        }),
      ).to.equal(null);
    });

    it('keeps the published Zod source schema in parity with exact wire rejection rules', () => {
      const invalidSources: unknown[] = [
        {
          kind: 'markdown',
          markdown: '# Hello',
          name: 'n'.repeat(MCP_WIRE_LIMITS.labelCharacters + 1),
        },
        { kind: 'markdown', markdown: '# Hello\0', name: null },
        {
          kind: 'file',
          rootId: 'source root',
          path: 'documents/report.docx',
          format: 'docx',
        },
        {
          kind: 'file',
          rootId: 'source-root',
          path: 'documents/report.docx',
          format: 'PPTX',
        },
        { kind: 'artifact', uri: 'docblocks://ARTIFACTS/artifact-1' },
        {
          kind: 'bundle',
          markdown: '# Report',
          name: null,
          assets: [
            {
              path: 'media/chart.png',
              source: { kind: 'artifact', uri: 'docblocks://artifacts/chart-1' },
              mimeType: 'not-a-mime',
              altText: null,
              credit: null,
              license: null,
            },
          ],
        },
        {
          kind: 'bundle',
          markdown: '# Report',
          name: null,
          assets: Array.from({ length: MCP_WIRE_LIMITS.bundleAssets + 1 }, (_unused, index) => ({
            path: `media/chart-${index}.png`,
            source: { kind: 'artifact', uri: `docblocks://artifacts/chart-${index}` },
            mimeType: 'image/png',
            altText: null,
            credit: null,
            license: null,
          })),
        },
      ];

      for (const source of invalidSources) {
        expect(documentSourceSchema.safeParse(source).success, JSON.stringify(source)).to.equal(
          false,
        );
        expect(parseDocumentSource(source), JSON.stringify(source)).to.equal(null);
      }

      const canonical = {
        kind: 'bundle',
        markdown: '# Report',
        name: 'report.md',
        assets: [
          {
            path: 'media/chart.png',
            source: { kind: 'artifact', uri: 'docblocks://artifacts/chart-1' },
            mimeType: 'image/png',
            altText: 'Chart',
            credit: null,
            license: null,
          },
        ],
      };
      expect(documentSourceSchema.safeParse(canonical).success).to.equal(true);
      expect(parseDocumentSource(canonical)).to.deep.equal(canonical);

      const conciseSources: Array<[unknown, unknown]> = [
        [
          { kind: 'markdown', markdown: '# Unnamed' },
          { kind: 'markdown', markdown: '# Unnamed', name: null },
        ],
        [
          { kind: 'file', rootId: 'source-root', path: 'documents/report.md' },
          {
            kind: 'file',
            rootId: 'source-root',
            path: 'documents/report.md',
            format: null,
          },
        ],
        [
          { kind: 'bundle', markdown: '# Unnamed', assets: [] },
          { kind: 'bundle', markdown: '# Unnamed', assets: [], name: null },
        ],
      ];
      for (const [concise, expected] of conciseSources) {
        expect(documentSourceSchema.safeParse(concise).success, JSON.stringify(concise)).to.equal(
          true,
        );
        expect(parseDocumentSource(concise)).to.deep.equal(expected);
      }
    });
  });

  describe('diagnostics and operation results', () => {
    it('accepts typed diagnostics and rejects extra or malformed locations', () => {
      expect(parseMcpDiagnostic(diagnostic())).to.deep.equal(diagnostic());
      expect(parseMcpDiagnostic({ ...diagnostic(), stack: 'secret' })).to.equal(null);
      expect(
        parseMcpDiagnostic({ ...diagnostic(), location: { kind: 'source', line: 0, column: 1 } }),
      ).to.equal(null);
    });

    it('accepts exact machine-readable failures and rejects ambient error data', () => {
      const result = {
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'error',
        result: null,
        error: {
          code: 'busy',
          message: 'The operation queue is full.',
          stage: 'convert',
          format: 'pptx',
          hint: 'Retry after another operation completes.',
          retryable: true,
          operationLoad: { active: 2, capacity: 2 },
        },
      };
      expect(parseMcpErrorResult(result)).to.deep.equal(result);
      expect(
        parseMcpErrorResult({ ...result, error: { ...result.error, stack: 'not-on-wire' } }),
      ).to.equal(null);
      expect(
        parseMcpErrorResult({ ...result, error: { ...result.error, stage: 'unknown-stage' } }),
      ).to.equal(null);
      expect(
        parseMcpErrorResult({
          ...result,
          error: { ...result.error, operationLoad: { active: 3, capacity: 2 } },
        }),
      ).to.equal(null);
    });

    it('publishes mutually exclusive exact success and error output branches', () => {
      const schema = toolOutputSchema(z.object({ value: z.string() }).strict());
      const detail = {
        code: 'operation-failed',
        message: 'The operation failed.',
        stage: null,
        format: null,
        hint: null,
        retryable: false,
        operationLoad: null,
      };
      expect(
        schema.safeParse({
          version: 1,
          kind: 'success',
          result: { value: 'ok' },
          error: null,
        }).success,
      ).to.equal(true);
      expect(
        schema.safeParse({ version: 1, kind: 'error', result: null, error: detail }).success,
      ).to.equal(true);
      expect(
        schema.safeParse({ version: 1, kind: 'success', result: null, error: detail }).success,
      ).to.equal(false);
      expect(
        schema.safeParse({
          version: 1,
          kind: 'error',
          result: { value: 'impossible' },
          error: null,
        }).success,
      ).to.equal(false);
    });

    it('advertises mutually exclusive root-object branches to MCP JSON Schema clients', () => {
      const schema = toolOutputSchema(z.object({ value: z.string().max(32) }).strict());
      const published = recordOf(z4.toJSONSchema(schema, { target: 'draft-7' }));
      expect(published.type).to.equal('object');
      expect(published.additionalProperties).to.equal(false);
      const branches = arrayOfRecords(published.oneOf);
      expect(branches).to.have.length(2);
      expect(branches.map(outputBranchKind)).to.have.members(['success', 'error']);

      const success = branches.find((branch) => outputBranchKind(branch) === 'success');
      const error = branches.find((branch) => outputBranchKind(branch) === 'error');
      expect(success).to.not.equal(undefined);
      expect(error).to.not.equal(undefined);
      const successProperties = recordOf(recordOf(success).properties);
      const errorProperties = recordOf(recordOf(error).properties);
      expect(recordOf(successProperties.error).type).to.equal('null');
      expect(recordOf(errorProperties.result).type).to.equal('null');
      expect(recordOf(recordOf(successProperties.result).properties).value).to.deep.include({
        type: 'string',
        maxLength: 32,
      });
    });

    it('advertises canonical artifact format, MIME, filename, size, and timestamp bounds', () => {
      const published = recordOf(
        z4.toJSONSchema(toolOutputSchema(artifactRefSchema), { target: 'draft-7' }),
      );
      const success = arrayOfRecords(published.oneOf).find(
        (branch) => outputBranchKind(branch) === 'success',
      );
      const artifactProperties = recordOf(
        recordOf(recordOf(recordOf(success).properties).result).properties,
      );
      expect(recordOf(artifactProperties.format)).to.include({
        maxLength: MCP_WIRE_LIMITS.formatCharacters,
        pattern: '^[a-z0-9][a-z0-9.+_-]*$',
      });
      expect(recordOf(artifactProperties.mimeType)).to.include({
        maxLength: MCP_WIRE_LIMITS.mimeTypeCharacters,
      });
      expect(recordOf(artifactProperties.size).maximum).to.equal(MCP_WIRE_LIMITS.artifactBytes);
      expect(recordOf(artifactProperties.suggestedFilename)).to.include({
        maxLength: MCP_WIRE_LIMITS.labelCharacters,
      });
      expect(recordOf(artifactProperties.createdAt).pattern).to.equal(
        '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
      );
    });

    it('advertises parser-aligned bounds for every structured result family', () => {
      const conversion = publishedSuccessResultProperties(toolOutputSchema(conversionResultSchema));
      expect(recordOf(conversion.sourceAssets).maxItems).to.equal(MCP_WIRE_LIMITS.arrayEntries);
      expect(recordOf(conversion.sourceAssetCount).maximum).to.equal(MCP_WIRE_LIMITS.arrayEntries);

      const inspection = publishedSuccessResultProperties(toolOutputSchema(inspectionResultSchema));
      expect(recordOf(inspection.blocks).maxItems).to.equal(MCP_WIRE_LIMITS.arrayEntries);
      const block = recordOf(recordOf(inspection.blocks).items);
      expect(recordOf(recordOf(block.properties).text).maxLength).to.equal(
        MCP_WIRE_LIMITS.excerptCharacters,
      );
      const outline = recordOf(recordOf(inspection.outline).items);
      expect(recordOf(recordOf(outline.properties).level).maximum).to.equal(6);

      const preview = publishedSuccessResultProperties(toolOutputSchema(previewResultSchema));
      expect(recordOf(preview.items).maxItems).to.equal(MCP_WIRE_LIMITS.previewItems);
      const previewItem = recordOf(recordOf(preview.items).items);
      expect(recordOf(recordOf(previewItem.properties).width).maximum).to.equal(
        MCP_WIRE_LIMITS.imageDimension,
      );

      const comparison = publishedSuccessResultProperties(toolOutputSchema(comparisonResultSchema));
      expect(recordOf(comparison.metrics).maxItems).to.equal(MCP_WIRE_LIMITS.arrayEntries);
      const change = recordOf(recordOf(comparison.changes).items);
      const path = arrayOfRecords(recordOf(recordOf(change.properties).path).anyOf).find(
        (alternative) => alternative.type === 'string',
      );
      expect(path).to.include({
        type: 'string',
        maxLength: MCP_WIRE_LIMITS.pathCharacters,
      });

      const saved = publishedSuccessResultProperties(
        DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.save_artifact,
      );
      const destination = recordOf(saved.destination);
      const destinationPath = recordOf(recordOf(destination.properties).path);
      expect(destinationPath).to.include({
        type: 'string',
        maxLength: MCP_WIRE_LIMITS.pathCharacters,
      });
      expect(destinationPath.pattern).to.be.a('string').and.not.equal('');
    });

    it('owns one exact output schema for every canonical MCP tool', () => {
      expect(Object.keys(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS)).to.deep.equal([
        ...DOCBLOCKS_MCP_TOOL_NAMES,
      ]);
      expect(Object.keys(DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS)).to.deep.equal([
        ...DOCBLOCKS_MCP_TOOL_NAMES,
      ]);
      expect(DOCBLOCKS_MCP_TOOL_NAMES).to.have.length(20);

      const error = {
        version: 1,
        kind: 'error' as const,
        result: null,
        error: {
          code: 'operation-failed',
          message: 'Failed safely.',
          stage: null,
          format: null,
          hint: null,
          retryable: false,
          operationLoad: null,
        },
      };
      for (const name of DOCBLOCKS_MCP_TOOL_NAMES) {
        expect(
          DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS[name].safeParse(error).success,
          `${name} error envelope`,
        ).to.equal(true);
      }
    });

    it('accepts exact auxiliary payloads and rejects unknown fields at every nesting level', () => {
      const theme = themeDescriptionValue();
      const template = {
        id: 'feature',
        label: 'Feature',
        description: 'Feature layout',
      };
      const layout = {
        layoutPath: 'ppt/slideLayouts/slideLayout1.xml',
        name: 'Title and content',
        masterName: 'Main',
        type: 'obj',
        slideCount: 2,
        verdict: 'builtin' as const,
        templateId: 'title-content',
        notes: ['Matched by placeholders.'],
      };
      const auxiliaryResults = {
        list_roots: {
          roots: [{ id: 'root-1', label: 'Workspace', read: true, write: false }],
        },
        save_artifact: {
          artifact: artifact(),
          destination: { rootId: 'root-1', path: 'exports/report.pdf' },
          sha256: ARTIFACT_HASH,
        },
        list_formats: {
          formats: [
            {
              id: 'md',
              label: 'Markdown',
              mimeType: 'text/markdown',
              extensions: ['.md'],
              import: { supported: true as const, tool: 'inspect_document' as const },
              export: { supported: true as const, tool: 'convert_document' as const },
            },
          ],
        },
        list_themes: { themes: [{ id: 'modern', name: 'Modern', description: 'Clean' }] },
        list_transform_styles: {
          styles: [{ id: 'magazine', name: 'Magazine', description: 'Editorial' }],
        },
        list_templates: { templates: [template] },
        describe_template: {
          template: {
            ...template,
            inputs: [
              {
                key: 'image',
                description: 'Image path',
                type: 'string',
                required: true,
                values: [],
                valueHint: 'media/hero.png',
              },
            ],
          },
          annotationExample: '# Heading {[feature image="media/hero.png"]}',
        },
        get_authoring_context: {
          goal: 'content-first' as const,
          targetFormat: 'pptx',
          defaultTemplateId: 'content',
          defaultFidelity: 'editable-native' as const,
          workflow: ['Author complete content first.'],
          syntax: {
            headingAnnotation: '# Heading {[content]}',
            standaloneAnnotation: '{[content]}',
            standaloneWarning: 'Standalone annotations create another block.',
          },
          formats: [
            {
              id: 'pptx',
              label: 'PowerPoint',
              mimeType: 'application/vnd.test',
              extensions: ['.pptx'],
              import: { supported: true as const, tool: 'inspect_document' as const },
              export: { supported: true as const, tool: 'convert_document' as const },
            },
          ],
          templates: [
            {
              ...template,
              inputs: [],
              role: 'content' as const,
              bodyPolicy: 'complete' as const,
              safeForContentFirst: true,
              placement: 'heading' as const,
              annotationExample: '# Heading {[feature]}',
            },
          ],
          themes: [{ id: 'modern', name: 'Modern', description: 'Clean' }],
          transformStyles: [{ id: 'magazine', name: 'Magazine', description: 'Editorial' }],
          recommendations: [],
          totalBlocks: null,
          truncated: false,
        },
        recommend_templates: {
          recommendations: [
            {
              blockId: 'block-1',
              title: 'Overview',
              profile: templateProfileValue(),
              recommendedTemplateIds: ['feature'],
            },
          ],
          totalBlocks: 1,
          truncated: false,
        },
        describe_theme: { theme, source: 'built-in' as const },
        infer_theme_from_file: {
          sourceFormat: 'pptx',
          sourceSha256: SOURCE_HASH,
          theme,
          layouts: [{ id: 'layout-1', name: 'Layout 1', description: 'Inferred' }],
          warnings: [],
        },
        inspect_pptx_layouts: {
          slideSize: { cx: 12_192_000, cy: 6_858_000 },
          layouts: [layout],
        },
        apply_inferred_theme: {
          result: conversionResultValue(),
          theme,
          layoutIds: ['layout-1'],
          warnings: [],
        },
      } as const;

      for (const [name, value] of Object.entries(auxiliaryResults)) {
        const schema = DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS[name as keyof typeof auxiliaryResults];
        expect(schema.safeParse(value).success, `${name} valid payload`).to.equal(true);
        expect(
          schema.safeParse({ ...value, ambientAuthority: true }).success,
          `${name} exact top-level shape`,
        ).to.equal(false);
      }

      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_roots.safeParse({
          roots: [{ ...auxiliaryResults.list_roots.roots[0], absolutePath: 'C:\\secret' }],
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_formats.safeParse({
          formats: [
            {
              ...auxiliaryResults.list_formats.formats[0],
              import: { supported: true, tool: 'inspect_document', fallback: 'legacy' },
            },
          ],
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.describe_theme.safeParse({
          theme: { ...theme, colors: { ...theme.colors, css: 'not-on-wire' } },
          source: 'built-in',
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.inspect_pptx_layouts.safeParse({
          slideSize: auxiliaryResults.inspect_pptx_layouts.slideSize,
          layouts: [{ ...layout, sourceXml: '<p:sldLayout/>' }],
        }).success,
      ).to.equal(false);
    });

    it('enforces auxiliary output identifiers, text, path, hash, count, and collection bounds', () => {
      const root = { id: 'root-1', label: 'Workspace', read: true, write: false };
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_roots.safeParse({
          roots: Array.from({ length: 65 }, () => root),
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_roots.safeParse({
          roots: [{ ...root, id: 'bad id' }],
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.save_artifact.safeParse({
          artifact: artifact(),
          destination: { rootId: 'root-1', path: 'x'.repeat(MCP_WIRE_LIMITS.pathCharacters + 1) },
          sha256: ARTIFACT_HASH,
        }).success,
      ).to.equal(false);
      for (const path of [
        '../report.pdf',
        'nested/../report.pdf',
        'nested//report.pdf',
        'nested\\report.pdf',
        '/absolute/report.pdf',
        'C:/absolute/report.pdf',
        'nested/report.pdf/',
        'nested/control\u0001.pdf',
      ]) {
        expect(
          DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.save_artifact.safeParse({
            artifact: artifact(),
            destination: { rootId: 'root-1', path },
            sha256: ARTIFACT_HASH,
          }).success,
          `save destination rejects non-canonical path ${JSON.stringify(path)}`,
        ).to.equal(false);
      }
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.save_artifact.safeParse({
          artifact: artifact(),
          destination: { rootId: 'root-1', path: 'exports/report.pdf' },
          sha256: 'A'.repeat(64),
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_formats.safeParse({
          formats: [
            {
              id: 'PPTX',
              label: 'PowerPoint',
              mimeType: 'application/vnd.test',
              extensions: ['.pptx'],
              import: { supported: false, excludedReason: '' },
              export: { supported: true, tool: 'convert_document' },
            },
          ],
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_themes.safeParse({
          themes: [{ id: 'modern', name: 'Modern', description: 'bad\u007ftext' }],
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.recommend_templates.safeParse({
          recommendations: [],
          totalBlocks: Number.MAX_SAFE_INTEGER + 1,
          truncated: false,
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.infer_theme_from_file.safeParse({
          sourceFormat: 'pptx',
          sourceSha256: SOURCE_HASH,
          theme: themeDescriptionValue(),
          layouts: Array.from({ length: 1_001 }, (_, index) => ({
            id: `layout-${index}`,
            name: `Layout ${index}`,
            description: '',
          })),
          warnings: [],
        }).success,
      ).to.equal(false);
      expect(
        DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.inspect_pptx_layouts.safeParse({
          slideSize: { cx: 1, cy: 1 },
          layouts: Array.from({ length: 2_049 }, (_, index) => ({
            layoutPath: `ppt/slideLayouts/slideLayout${index}.xml`,
            name: `Layout ${index}`,
            masterName: null,
            type: null,
            slideCount: 0,
            verdict: 'plain',
            templateId: null,
            notes: [],
          })),
        }).success,
      ).to.equal(false);
    });

    it('validates conversion/artifact format and source provenance consistency', () => {
      const result = {
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'conversion',
        sourceFormat: 'md',
        targetFormat: 'pdf',
        artifact: artifact(),
        fidelity: 'editable-native',
        appliedThemeId: 'modern',
        appliedTransformId: null,
        sourceAssets: [],
        sourceAssetCount: 0,
        diagnostics: [diagnostic()],
      };
      expect(parseConversionResult(result)).to.deep.equal(result);
      expect(parseConversionResult({ ...result, artifact: artifact({ format: 'pptx' }) })).to.equal(
        null,
      );
      expect(
        parseConversionResult({
          ...result,
          artifact: artifact({ sourceFormat: 'docx' }),
        }),
      ).to.equal(null);
      expect(parseConversionResult({ ...result, sourceAssetCount: 1 })).to.equal(null);
      expect(conversionResultSchema.safeParse(result).success).to.equal(true);
      for (const invalid of [
        { ...result, artifact: artifact({ format: 'pptx' }) },
        { ...result, artifact: artifact({ sourceFormat: 'docx' }) },
        { ...result, sourceAssetCount: 1 },
      ]) {
        expect(conversionResultSchema.safeParse(invalid).success).to.equal(false);
      }
    });

    it('validates inspection counts, uniqueness, ranges, and exact shapes', () => {
      const result = {
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'inspection',
        sourceFormat: 'md',
        metadata: { title: 'Report', author: null, description: null },
        statistics: {
          blockCount: 1,
          wordCount: 2,
          characterCount: 11,
          tableCount: 0,
          linkCount: 0,
          assetCount: 1,
          pageCount: null,
          slideCount: null,
          sheetCount: null,
        },
        outline: [{ id: 'heading-1', title: 'Hello', level: 1, blockIndex: 0 }],
        blocks: [
          {
            id: 'block-1',
            type: 'heading',
            text: 'Hello world',
            wordCount: 2,
            templateId: null,
            sourceRange: { start: 0, end: 11 },
          },
        ],
        blockOffset: 0,
        nextCursor: null,
        tables: [],
        links: [],
        items: [],
        assets: [
          {
            path: 'media/chart.png',
            mimeType: 'image/png',
            size: 100,
            sha256: ARTIFACT_HASH,
            altText: 'Chart',
            credit: null,
            license: null,
          },
        ],
        theme: {
          id: 'modern',
          name: 'Modern',
          source: 'built-in',
          layouts: ['title', 'content'],
        },
        truncated: false,
        detailsTruncated: false,
        diagnostics: [],
      };

      expect(parseInspectionResult(result)).to.deep.equal(result);
      expect(
        parseInspectionResult({
          ...result,
          statistics: { ...result.statistics, blockCount: 2 },
        }),
      ).to.equal(null);
      expect(
        parseInspectionResult({
          ...result,
          outline: [result.outline[0], result.outline[0]],
        }),
      ).to.equal(null);
      expect(inspectionResultSchema.safeParse(result).success).to.equal(true);
      expect(
        inspectionResultSchema.safeParse({
          ...result,
          outline: [{ ...result.outline[0], level: 7 }],
        }).success,
      ).to.equal(false);
      expect(
        inspectionResultSchema.safeParse({
          ...result,
          blocks: [
            { ...result.blocks[0], text: 'x'.repeat(MCP_WIRE_LIMITS.excerptCharacters + 1) },
          ],
        }).success,
      ).to.equal(false);
    });

    it('requires validation summaries and valid status to agree with diagnostic counts', () => {
      const warning = diagnostic({ count: 2 });
      const result = {
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'validation',
        sourceFormat: 'md',
        targetFormat: 'pdf',
        valid: true,
        summary: { errorCount: 0, warningCount: 2, infoCount: 0 },
        diagnostics: [warning],
      };
      expect(parseValidationResult(result)).to.deep.equal(result);
      expect(
        parseValidationResult({
          ...result,
          summary: { ...result.summary, warningCount: 1 },
        }),
      ).to.equal(null);
      expect(parseValidationResult({ ...result, valid: false })).to.equal(null);
    });

    it('accepts bounded image previews and enforces total/truncation semantics', () => {
      const imageArtifact = artifact({
        id: 'preview-1',
        uri: 'docblocks://artifacts/preview-1',
        format: 'png',
        mimeType: 'image/png',
        sourceFormat: 'pdf',
        suggestedFilename: 'preview.png',
      });
      const result = {
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'preview',
        sourceFormat: 'pdf',
        previewBasis: 'reconstructed-import',
        totalItems: 1,
        items: [
          {
            kind: 'page',
            index: 0,
            label: 'Page 1',
            artifact: imageArtifact,
            width: 1_200,
            height: 1_600,
          },
        ],
        truncated: false,
        diagnostics: [],
      };
      expect(parsePreviewResult(result)).to.deep.equal(result);
      expect(parsePreviewResult({ ...result, totalItems: 2 })).to.equal(null);
      expect(
        parsePreviewResult({
          ...result,
          items: [{ ...result.items[0], artifact: artifact() }],
        }),
      ).to.equal(null);
      expect(previewResultSchema.safeParse(result).success).to.equal(true);
      expect(
        previewResultSchema.safeParse({
          ...result,
          items: [{ ...result.items[0], artifact: artifact() }],
        }).success,
      ).to.equal(false);
      expect(previewResultSchema.safeParse({ ...result, totalItems: 2 }).success).to.equal(false);
    });

    it('validates structured comparison scores and equivalence claims', () => {
      const result = {
        version: DOCBLOCKS_MCP_WIRE_VERSION,
        kind: 'comparison',
        leftFormat: 'md',
        rightFormat: 'pdf',
        equivalent: false,
        score: 0.9,
        changes: [
          {
            category: 'media',
            status: 'degraded',
            path: 'media/chart.png',
            message: 'The image was represented as alt text.',
          },
        ],
        metrics: [{ name: 'textRetention', leftValue: 100, rightValue: 100, similarity: 1 }],
        diagnostics: [diagnostic()],
      };
      expect(parseComparisonResult(result)).to.deep.equal(result);
      expect(parseComparisonResult({ ...result, score: 1.01 })).to.equal(null);
      expect(parseComparisonResult({ ...result, equivalent: true, score: 1 })).to.equal(null);
      expect(comparisonResultSchema.safeParse(result).success).to.equal(true);
      expect(comparisonResultSchema.safeParse({ ...result, score: 1.01 }).success).to.equal(false);
      expect(
        comparisonResultSchema.safeParse({ ...result, equivalent: true, score: 1 }).success,
      ).to.equal(false);
      expect(
        comparisonResultSchema.safeParse({
          ...result,
          metrics: [result.metrics[0], result.metrics[0]],
        }).success,
      ).to.equal(false);
    });
  });

  describe('safe materialization', () => {
    it('permits no-replace writes and hash-conditional replacements', () => {
      expect(
        parseMaterializationOptions({
          rootId: 'output-root',
          path: 'exports/report.pdf',
          ifExists: 'error',
          expectedSha256: null,
        }),
      ).to.deep.equal({
        rootId: 'output-root',
        path: 'exports/report.pdf',
        ifExists: 'error',
        expectedSha256: null,
      });
      expect(
        parseMaterializationOptions({
          rootId: 'output-root',
          path: 'exports/report.pdf',
          ifExists: 'replace',
          expectedSha256: ARTIFACT_HASH,
        }),
      ).to.deep.equal({
        rootId: 'output-root',
        path: 'exports/report.pdf',
        ifExists: 'replace',
        expectedSha256: ARTIFACT_HASH,
      });

      const concise = {
        rootId: 'output-root',
        path: 'exports/concise.pdf',
        ifExists: 'error',
      };
      expect(materializationOptionsSchema.safeParse(concise).success).to.equal(true);
      expect(parseMaterializationOptions(concise)).to.deep.equal({
        ...concise,
        expectedSha256: null,
      });
    });

    it('cannot express an unconditional overwrite or root mutation', () => {
      expect(
        parseMaterializationOptions({
          rootId: 'output-root',
          path: 'exports/report.pdf',
          ifExists: 'replace',
          expectedSha256: null,
        }),
      ).to.equal(null);
      expect(
        parseMaterializationOptions({
          rootId: 'output-root',
          path: '',
          ifExists: 'error',
          expectedSha256: null,
        }),
      ).to.equal(null);
    });
  });
});

function recordOf(value: unknown): Record<string, unknown> {
  expect(value).to.be.an('object').and.not.equal(null);
  return value as Record<string, unknown>;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  expect(value).to.be.an('array');
  return (value as unknown[]).map(recordOf);
}

function outputBranchKind(branch: Record<string, unknown>): string | undefined {
  const properties = recordOf(branch.properties);
  const kind = recordOf(properties.kind).const;
  return typeof kind === 'string' ? kind : undefined;
}

function publishedSuccessResultProperties(schema: z4.ZodType): Record<string, unknown> {
  const published = recordOf(z4.toJSONSchema(schema, { target: 'draft-7' }));
  const success = arrayOfRecords(published.oneOf).find(
    (branch) => outputBranchKind(branch) === 'success',
  );
  const result = recordOf(recordOf(recordOf(success).properties).result);
  return recordOf(result.properties);
}
