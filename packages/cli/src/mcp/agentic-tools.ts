import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TemplateAuthoringMetadata } from '@bendyline/squisq/doc';
import {
  MCP_WIRE_LIMITS,
  parseComparisonResult,
  parseConversionResult,
  parseDocumentSource,
  parseInspectionResult,
  parseMaterializationOptions,
  parsePreviewResult,
  parseValidationResult,
  type ArtifactRef,
  type AuthoringContextResult,
  type ConversionFidelity,
  type DocumentSource,
} from '@bendyline/docblocks/mcp';
import { ArtifactStore } from './artifact-store.js';
import { McpFileAuthority } from './authority.js';
import {
  MCP_FORMAT_CAPABILITIES,
  MCP_FORMAT_FIDELITIES,
  convertPreparedDocument,
  type ConversionTargetRequest,
} from './conversion-service.js';
import { DocumentService, throwIfAborted, warningDiagnostic } from './document-service.js';
import {
  comparePreparedDocuments,
  inspectPreparedDocument,
  validatePreparedDocument,
} from './intelligence.js';
import {
  artifactUriSchema,
  bundleDocumentSourceSchema,
  DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS,
  documentSourceSchema,
  formatInputSchema,
  materializationOptionsSchema,
} from '@bendyline/docblocks/mcp/zod';
import {
  previewPreparedDocument,
  previewVideoSource,
  type VideoThumbnailExtractor,
} from './preview-service.js';
import { errorResult, successResult } from './error-result.js';
import { reportMcpProgress } from './progress.js';
import {
  MCP_OUTPUT_PATTERNS,
  boundNullableWireText,
  boundWireText,
  boundWireTextArray,
  boundWireWarnings,
  requireWireIdentifier,
  toWireIdentifier,
} from './output-bounds.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const ARTIFACT_CREATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const MATERIALIZING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(MCP_WIRE_LIMITS.identifierCharacters)
  .regex(MCP_OUTPUT_PATTERNS.identifier);

export interface AgenticToolContext {
  authority: Promise<McpFileAuthority>;
  artifacts: ArtifactStore;
  extractVideoThumbnail?: VideoThumbnailExtractor;
  runOperation<T>(
    signal: AbortSignal,
    work: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

const fidelitySchemas = {
  editable: z.enum(MCP_FORMAT_FIDELITIES.docx),
  pdf: z.enum(MCP_FORMAT_FIDELITIES.pdf),
  pptx: z.enum(MCP_FORMAT_FIDELITIES.pptx),
} as const;
const metadataFields = {
  title: z.string().max(4_000).optional(),
  author: z.string().max(4_000).optional(),
  description: z.string().max(8_000).optional(),
} as const;
const simpleTarget = (format: 'md' | 'dbk', fidelity: z.ZodType<ConversionFidelity>) =>
  z.object({ format: z.literal(format), fidelity: fidelity.optional() }).strict();
const conversionTargetSchema = z.discriminatedUnion('format', [
  simpleTarget('md', z.enum(MCP_FORMAT_FIDELITIES.md)),
  simpleTarget('dbk', z.enum(MCP_FORMAT_FIDELITIES.dbk)),
  z
    .object({
      format: z.literal('docx'),
      fidelity: fidelitySchemas.editable.optional(),
      ...metadataFields,
      defaultFont: z.string().max(256).optional(),
      defaultFontSize: z.number().min(6).max(96).optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('pdf'),
      fidelity: fidelitySchemas.pdf.optional(),
      title: metadataFields.title,
      author: metadataFields.author,
      pageSize: z.enum(['letter', 'a4']).optional(),
      margin: z.number().min(0).max(288).optional(),
      defaultFontSize: z.number().min(6).max(96).optional(),
      width: z.number().int().min(160).max(1_920).optional(),
      height: z.number().int().min(90).max(1_920).optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('pptx'),
      fidelity: fidelitySchemas.pptx.optional(),
      ...metadataFields,
      slideBreak: z.enum(['h1', 'h2', 'heading']).optional(),
      defaultFont: z.string().max(256).optional(),
      defaultFontSize: z.number().min(6).max(96).optional(),
      width: z.number().int().min(160).max(1_920).optional(),
      height: z.number().int().min(90).max(1_920).optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('xlsx'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.xlsx).optional(),
      title: metadataFields.title,
      author: metadataFields.author,
      sheetNamePrefix: z.string().max(31).optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('csv'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.csv).optional(),
      delimiter: z.string().min(1).max(4).optional(),
      tableIndex: z.number().int().nonnegative().max(10_000).optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('html'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.html).optional(),
      mode: z.enum(['slideshow', 'static']).optional(),
      autoPlay: z.boolean().optional(),
      title: metadataFields.title,
    })
    .strict(),
  z
    .object({
      format: z.literal('htmlzip'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.htmlzip).optional(),
      mode: z.enum(['slideshow', 'static']).optional(),
      autoPlay: z.boolean().optional(),
      title: metadataFields.title,
    })
    .strict(),
  z
    .object({
      format: z.literal('epub'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.epub).optional(),
      ...metadataFields,
      language: z.string().max(64).optional(),
      publisher: z.string().max(4_000).optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('mp4'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.mp4).optional(),
      fps: z.number().int().min(1).max(60).optional(),
      quality: z.enum(['draft', 'normal', 'high']).optional(),
      orientation: z.enum(['landscape', 'portrait']).optional(),
      width: z.number().int().min(16).max(3_840).optional(),
      height: z.number().int().min(16).max(3_840).optional(),
      captionStyle: z.enum(['standard', 'social']).optional(),
      coverPreRoll: z.number().min(0).max(60).optional(),
      animationsEnabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('gif'),
      fidelity: z.enum(MCP_FORMAT_FIDELITIES.gif).optional(),
      fps: z.number().int().min(1).max(30).optional(),
      orientation: z.enum(['landscape', 'portrait']).optional(),
      width: z.number().int().min(16).max(1_920).optional(),
      height: z.number().int().min(16).max(1_920).optional(),
      captionStyle: z.enum(['standard', 'social']).optional(),
      coverPreRoll: z.number().min(0).max(60).optional(),
      animationsEnabled: z.boolean().optional(),
      loop: z.number().int().min(-1).max(65_535).optional(),
      maxColors: z.number().int().min(2).max(256).optional(),
      dither: z
        .enum(['none', 'bayer', 'heckbert', 'floyd_steinberg', 'sierra2', 'sierra2_4a'])
        .optional(),
      bayerScale: z.number().int().min(0).max(5).optional(),
    })
    .strict(),
]);

/** Exact target ids accepted by convert_document's runtime input schema. */
export const MCP_CONVERSION_TARGET_FORMATS = Object.freeze(
  conversionTargetSchema.options.map((schema) => schema.shape.format.value),
);

export function registerAgenticTools(server: McpServer, context: AgenticToolContext): void {
  registerArtifactResource(server, context.artifacts);
  registerConversionReportResource(server, context.artifacts);
  registerAuthoringGuideResource(server);

  server.registerTool(
    'list_roots',
    {
      description:
        'List opaque root aliases granted when this DocBlocks MCP server started. Root aliases improve path usability but never expand authority.',
      inputSchema: z.object({}).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.list_roots,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const roots = (await context.authority).listRoots();
        return textAndStructured({ roots });
      } catch (caught: unknown) {
        return errorResult(caught, 'resolve');
      }
    },
  );

  server.registerTool(
    'get_conversion_report',
    {
      description:
        'Retrieve the original bounded diagnostics, applied options, fidelity, provenance, and source-asset manifest for a conversion-backed session artifact.',
      inputSchema: z.object({ artifactUri: artifactUriSchema }).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.get_conversion_report,
      annotations: READ_ONLY,
    },
    async ({ artifactUri }) => {
      try {
        const report = await context.artifacts.getConversionReport(artifactUri);
        requireWire(parseConversionResult(report), 'conversion report');
        return textAndStructured(report);
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect');
      }
    },
  );

  server.registerTool(
    'convert_document',
    {
      description:
        'Convert any linked-registry input into one or more immutable artifacts. Use save_artifact only when a durable filesystem file is required.',
      inputSchema: z
        .object({
          source: documentSourceSchema,
          targets: z.array(conversionTargetSchema).min(1).max(12),
          themeId: identifierSchema.optional(),
          transformId: identifierSchema.optional(),
          autoTemplates: z.boolean().optional(),
          title: z.string().max(4_000).optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.convert_document,
      annotations: ARTIFACT_CREATING,
    },
    async ({ source, targets, themeId, transformId, autoTemplates, title }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const canonical = requireDocumentSource(source);
          const documents = new DocumentService(await context.authority, context.artifacts);
          await sendProgress(extra, 0, targets.length + 1, 'Resolving document');
          const prepared = await documents.prepare(canonical, operationSignal);
          const results = await convertPreparedDocument(
            context.artifacts,
            prepared,
            {
              targets: targets.map(toConversionTarget),
              themeId,
              transformId,
              autoTemplates,
              title,
            },
            operationSignal,
            (completed, total, message) => sendProgress(extra, completed + 1, total + 1, message),
          );
          for (const result of results) requireWire(parseConversionResult(result), 'conversion');
          const payload = { results };
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(payload) },
              ...results.map((result) => artifactLink(result.artifact)),
            ],
            structuredContent: asStructuredContent(successResult(payload)),
          };
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'convert', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'create_document_bundle',
    {
      description:
        'Optionally stage Markdown plus authority-scoped assets as a reusable immutable DBK artifact when the same bundle will feed several operations. For normal authoring, pass complete Markdown or a bundle source directly to convert_document.',
      inputSchema: z.object({ source: bundleDocumentSourceSchema }).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.create_document_bundle,
      annotations: ARTIFACT_CREATING,
    },
    async ({ source }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const canonical = requireDocumentSource(source);
          const documents = new DocumentService(await context.authority, context.artifacts);
          const prepared = await documents.prepare(canonical, operationSignal);
          const [result] = await convertPreparedDocument(
            context.artifacts,
            prepared,
            { targets: [{ format: 'dbk', fidelity: 'semantic' }] },
            operationSignal,
          );
          if (!result) throw new Error('DBK conversion produced no artifact');
          requireWire(parseConversionResult(result), 'conversion');
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result) },
              artifactLink(result.artifact),
            ],
            structuredContent: asStructuredContent(successResult(result)),
          };
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'convert', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'save_artifact',
    {
      description:
        'Materialize an immutable artifact below a configured write root. Creation is no-replace; replacement requires the current SHA-256.',
      inputSchema: z
        .object({ artifactUri: artifactUriSchema, destination: materializationOptionsSchema })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.save_artifact,
      annotations: MATERIALIZING,
    },
    async ({ artifactUri, destination }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const canonical = requireWire(
            parseMaterializationOptions(destination),
            'materialization options',
          );
          const [authority, artifact, bytes] = await Promise.all([
            context.authority,
            context.artifacts.get(artifactUri, operationSignal),
            context.artifacts.read(artifactUri, operationSignal),
          ]);
          throwIfAborted(operationSignal);
          const outputPath = await authority.authorizeRootWrite(canonical.rootId, canonical.path);
          await authority.materializeBytes(outputPath, bytes, bytes.byteLength, {
            ifExists: canonical.ifExists,
            expectedSha256: canonical.expectedSha256 ?? undefined,
            signal: operationSignal,
          });
          const payload = {
            artifact,
            destination: { rootId: canonical.rootId, path: canonical.path },
            sha256: artifact.sha256,
          };
          return textAndStructured(payload);
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'materialize', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'inspect_document',
    {
      description:
        'Inspect any linked-registry document as bounded semantic structure, block provenance, assets, metadata, theme, and diagnostics.',
      inputSchema: z
        .object({
          source: documentSourceSchema,
          maxBlocks: z.number().int().min(1).max(2_000).optional(),
          cursor: z.string().max(256).nullable().optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.inspect_document,
      annotations: READ_ONLY,
    },
    async ({ source, maxBlocks, cursor }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const prepared = await documents.prepare(requireDocumentSource(source), operationSignal);
          const result = await inspectPreparedDocument(
            documents,
            prepared,
            maxBlocks,
            cursor ?? null,
            operationSignal,
          );
          requireWire(parseInspectionResult(result), 'inspection');
          return textAndStructured(result);
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'validate_document',
    {
      description:
        'Validate document structure, templates, annotations, assets, accessibility, and optional target-format fidelity before export.',
      inputSchema: z
        .object({
          source: documentSourceSchema,
          targetFormat: formatInputSchema.nullable().optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.validate_document,
      annotations: READ_ONLY,
    },
    async ({ source, targetFormat }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const prepared = await documents.prepare(requireDocumentSource(source), operationSignal);
          const normalizedTargetFormat = targetFormat?.toLowerCase() ?? null;
          const result = await validatePreparedDocument(
            documents,
            prepared,
            normalizedTargetFormat,
            operationSignal,
          );
          requireWire(parseValidationResult(result), 'validation');
          return textAndStructured(result);
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'validate', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'compare_documents',
    {
      description:
        'Compare two supported documents semantically and report text, structure, table, media, metadata, and theme retention.',
      inputSchema: z.object({ left: documentSourceSchema, right: documentSourceSchema }).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.compare_documents,
      annotations: READ_ONLY,
    },
    async ({ left, right }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const [leftPrepared, rightPrepared] = await Promise.all([
            documents.prepare(requireDocumentSource(left), operationSignal),
            documents.prepare(requireDocumentSource(right), operationSignal),
          ]);
          const result = await comparePreparedDocuments(
            documents,
            leftPrepared,
            rightPrepared,
            operationSignal,
          );
          requireWire(parseComparisonResult(result), 'comparison');
          return textAndStructured(result);
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'compare', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'preview_document',
    {
      description:
        'Render bounded visual previews as immutable image artifacts and report previewBasis. Markdown/DBK use source-render, imported document artifacts use reconstructed-import, and MP4/GIF sources use a native-extracted first-frame JPEG. Supports pagination and protocol progress/cancellation.',
      inputSchema: z
        .object({
          source: documentSourceSchema,
          startIndex: z.number().int().nonnegative().max(100_000).optional(),
          maxItems: z.number().int().min(1).max(20).optional(),
          width: z.number().int().min(160).max(1_920).optional(),
          height: z.number().int().min(90).max(1_920).optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.preview_document,
      annotations: ARTIFACT_CREATING,
    },
    async ({ source, startIndex, maxItems, width, height }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          await sendProgress(extra, 0, 1, 'Resolving document');
          const documentSource = requireDocumentSource(source);
          const request = { startIndex, maxItems, width, height };
          const reportProgress = (completed: number, total: number, message: string) =>
            sendProgress(extra, completed, total, message);
          const result = (await isRenderedMediaPreviewSource(documentSource, context.artifacts))
            ? await previewVideoSource(
                context.artifacts,
                await documents.readBinarySource(documentSource, operationSignal),
                request,
                operationSignal,
                reportProgress,
                context.extractVideoThumbnail,
              )
            : await previewPreparedDocument(
                context.artifacts,
                await documents.prepare(documentSource, operationSignal),
                request,
                operationSignal,
                reportProgress,
              );
          requireWire(parsePreviewResult(result), 'preview');
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result) },
              ...result.items.map((item) => artifactLink(item.artifact)),
            ],
            structuredContent: asStructuredContent(successResult(result)),
          };
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'render', null, extra.signal);
      }
    },
  );

  registerTemplateTools(server, context);
  registerThemeTools(server, context);
}

function registerArtifactResource(server: McpServer, artifacts: ArtifactStore): void {
  const template = new ResourceTemplate('docblocks://artifacts/{id}', {
    list: undefined,
    complete: { id: (prefix) => artifacts.completeIds(prefix) },
  });
  server.registerResource(
    'artifact',
    template,
    {
      description:
        'Session-scoped immutable DocBlocks artifact. Large artifacts must be materialized with save_artifact.',
    },
    async (uri, variables, extra) => {
      const rawId = variables.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) throw new Error('Artifact resource id is required');
      const { ref, bytes } = await artifacts.readResource(id, extra.signal);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: ref.mimeType,
            ...(ref.mimeType.startsWith('text/')
              ? { text: bytes.toString('utf8') }
              : { blob: bytes.toString('base64') }),
          },
        ],
      };
    },
  );
}

function registerConversionReportResource(server: McpServer, artifacts: ArtifactStore): void {
  const template = new ResourceTemplate('docblocks://reports/{id}', {
    list: undefined,
    complete: { id: (prefix) => artifacts.completeReportIds(prefix) },
  });
  server.registerResource(
    'conversion-report',
    template,
    {
      description:
        'Original machine-readable diagnostics and provenance for a conversion-backed session artifact.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const rawId = variables.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) throw new Error('Conversion report resource id is required');
      const report = await artifacts.getConversionReport(id);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );
}

function registerAuthoringGuideResource(server: McpServer): void {
  server.registerResource(
    'authoring-guide',
    'docblocks://authoring-guide',
    {
      description:
        'Compact linked-Squisq authoring vocabulary, artifact workflow, fidelity modes, templates, themes, and transform styles.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'], priority: 1 },
    },
    async () => {
      const [templates, schemaModule, transformModule] = await Promise.all([
        authoringTemplateCatalog(),
        import('@bendyline/squisq/schemas'),
        import('@bendyline/squisq/transform'),
      ]);
      const guide = {
        version: 6,
        workflow: [
          'treat supplied facts as a closed evidence set; label calculations, assumptions, hypotheses, recommendations, and examples; do not present causal links, rhetorical performance labels, superlatives, sole causes, targets, capabilities, owners, dates, channels, or operational details as established facts unless supplied',
          'when the requested genre needs unsupplied roles, gates, timelines, channels, or procedures, add one explicit proposed operating model scope note that applies to those details, then complete the requested element',
          'author complete Squisq-compatible Markdown with annotations bound to headings; ordinary headings default to the loss-averse content template',
          'for PPTX, use exactly one level-one Markdown heading per slide and no level-two through level-six headings because every heading becomes a slide by default',
          'by default, pass the complete Markdown—or a bundle source when assets are needed—directly to convert_document; revise by editing the complete Markdown and converting again',
          'use create_document_bundle only when a reusable staged DBK materially avoids repeating a large Markdown-and-asset bundle across several operations',
          'use inspect_document, validate_document, and preview_document when their semantic, diagnostic, or visual evidence is useful; they are review tools rather than required phases',
          'for visual polish, replace selected content blocks with compatible visual templates while preserving required content',
          'convert_document creates one or more immutable artifacts from the authoritative complete source',
          'save_artifact only when a durable file is required',
        ],
        markdownAnnotation: '# Heading {[templateId key="value"]}',
        standaloneAnnotation: '{[templateId key="value"]}',
        standaloneWarning:
          'A standalone annotation creates an additional heading-less block. Bind the annotation to a heading unless that extra block is deliberate.',
        fidelity: {
          semantic: 'Prioritize meaning and portability.',
          'editable-native': 'Produce editable native structures with target-specific diagnostics.',
          'rendered-fidelity': 'Preserve Squisq pixels in rendered slide/page media.',
          hybrid:
            'Preserve rendered visuals plus bounded machine-extractable semantic retention; current PPTX text is hidden and current PDF is not a tagged accessible PDF.',
        },
        fidelityByFormat: MCP_FORMAT_FIDELITIES,
        formats: boundedFormatCapabilities(),
        templates,
        themes: schemaModule
          .getThemeSummaries()
          .slice(0, MCP_WIRE_LIMITS.arrayEntries)
          .map((theme) => ({
            id: requireWireIdentifier(theme.id, 'theme id'),
            name: boundWireText(theme.name, MCP_WIRE_LIMITS.labelCharacters, theme.id),
            description: boundWireText(theme.description ?? ''),
          })),
        transformStyles: transformModule
          .getTransformStyleSummaries()
          .slice(0, MCP_WIRE_LIMITS.arrayEntries)
          .map((style) => ({
            id: requireWireIdentifier(style.id, 'transform style id'),
            name: boundWireText(style.name, MCP_WIRE_LIMITS.labelCharacters, style.id),
            description: boundWireText(style.description),
          })),
      };
      return {
        contents: [
          {
            uri: 'docblocks://authoring-guide',
            mimeType: 'application/json',
            text: JSON.stringify(guide, null, 2),
          },
        ],
      };
    },
  );
}

function registerTemplateTools(server: McpServer, context: AgenticToolContext): void {
  server.registerTool(
    'get_authoring_context',
    {
      description:
        'Get a compact agent-facing authoring contract plus the complete linked-Squisq catalog in structured content, with optional block recommendations.',
      inputSchema: z
        .object({
          targetFormat: formatInputSchema.optional(),
          goal: z.enum(['content-first', 'visual-polish']).optional(),
          source: documentSourceSchema.optional(),
          maxBlocks: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.get_authoring_context,
      annotations: READ_ONLY,
    },
    async ({ targetFormat, goal: requestedGoal, source, maxBlocks }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const goal = requestedGoal ?? 'content-first';
          const normalizedTarget = targetFormat?.toLowerCase() ?? null;
          const formats = boundedFormatCapabilities();
          if (normalizedTarget) {
            const target = formats.find((format) => format.id === normalizedTarget);
            if (!target) throw new Error(`Unknown target format "${normalizedTarget}"`);
            if (!target.export.supported) {
              throw new Error(`Format "${normalizedTarget}" is not export-capable`);
            }
          }
          const [templates, schemaModule, transformModule] = await Promise.all([
            authoringTemplateCatalog(),
            import('@bendyline/squisq/schemas'),
            import('@bendyline/squisq/transform'),
          ]);
          let recommendations: Array<{
            blockId: string;
            title: string | null;
            profile: {
              hasImage: boolean;
              imageCount: number;
              hasVideo: boolean;
              hasBlockquote: boolean;
              hasList: boolean;
              hasTable: boolean;
              hasDate: boolean;
              hasNumberHighlight: boolean;
              wordCount: number;
              hasAsciiDiagram: boolean;
              hasTimeline: boolean;
              hasTree: boolean;
            };
            recommendedTemplateIds: string[];
          }> = [];
          let totalBlocks: number | null = null;
          let truncated = false;
          if (source) {
            const documents = new DocumentService(await context.authority, context.artifacts);
            const prepared = await documents.prepare(
              requireDocumentSource(source),
              operationSignal,
            );
            const [{ flattenBlocks }, recommendModule] = await Promise.all([
              import('@bendyline/squisq/doc'),
              import('@bendyline/squisq/recommend'),
            ]);
            const blocks = flattenBlocks(prepared.doc.blocks);
            const limit = maxBlocks ?? 50;
            recommendations = blocks.slice(0, limit).map((block) => {
              const profile = recommendModule.profileBlockContents(block.contents ?? []);
              const visual = recommendModule.recommendTemplatesForBlock(
                profile,
                templates.map((template) => template.id),
              ).recommended;
              const recommendedTemplateIds =
                goal === 'content-first'
                  ? ['content', ...visual.filter((id) => id !== 'content')]
                  : visual;
              return {
                blockId: toWireIdentifier(block.id, 'block'),
                title: boundNullableWireText(block.title, MCP_WIRE_LIMITS.labelCharacters),
                profile: {
                  ...profile,
                  hasAsciiDiagram: profile.hasAsciiDiagram ?? false,
                  hasTimeline: profile.hasTimeline ?? false,
                  hasTree: profile.hasTree ?? false,
                },
                recommendedTemplateIds: recommendedTemplateIds
                  .slice(0, 256)
                  .map((id) => requireWireIdentifier(id, 'recommended template id')),
              };
            });
            totalBlocks = blocks.length;
            truncated = recommendations.length < blocks.length;
          }
          const payload: AuthoringContextResult = {
            goal,
            targetFormat: normalizedTarget,
            defaultTemplateId: 'content',
            defaultFidelity: authoringDefaultFidelity(normalizedTarget, goal),
            workflow: [
              'Treat supplied facts as a closed evidence set. Use temporal or correlational wording unless causality is supplied. Label calculations, assumptions, hypotheses, recommendations, and illustrative examples. Do not infer end-to-end feasibility from one supplied phase duration.',
              'Audit claims before conversion: causal links, rhetorical labels such as compounding, engine, healthy, strong, or constraint, superlatives, sole-cause claims, targets, capabilities, owners, dates, channels, and operational details must be supplied or explicitly framed as a hypothesis, recommendation, example, or proposal. Do not connect separate metrics, audiences, segments, or workflows unless the relationship is supplied. Prefer observed, coincided with, intended to, or proposed over drove, addresses, protects, or proves. Do not call choices a sequence or capacity allocation unless order, timing, or resource constraints were supplied.',
              'Complete every requested element without presenting invented policy as established fact. When a requested policy, playbook, or training guide needs unsupplied roles, gates, timelines, channels, or procedures, add one explicit proposed operating model scope note that applies to those details.',
              'Author complete Squisq-compatible content with heading-bound annotations; ordinary headings default to the loss-averse content template.',
              normalizedTarget === 'pptx'
                ? 'Match every explicitly requested slide count exactly. Use exactly one level-one Markdown heading (#) per slide and no level-two through level-six headings because every heading becomes a slide by default. Target at most 80 words per slide, and use lists, tables, or bold labels for within-slide structure.'
                : 'Honor the requested word range and document genre. Prefer connected memo prose for executive decisions and native headings, tables, and checklists for operational documents.',
              normalizedTarget === 'pptx'
                ? 'Make slide one a supported point-of-view thesis, not a generic title or unsupported flourish. For requested choices, state a concrete opportunity cost grounded in the supplied alternatives and name one clearly labeled proposed accountable role per choice. If a tradeoff requires an unsupplied capacity or outcome assumption, label it Assumption or Potential tradeoff rather than stating it as fact.'
                : 'When accountability is requested but not supplied, name one clearly labeled proposed accountable role per decision or workstream.',
              'Add decision value without inventing causes: interpret supplied comparisons to baselines, goals, targets, and rankings; use transparent calculations; label any new review cadence or measurement procedure as proposed.',
              'Before validation and conversion, run a content preflight: count slide sections or document words, verify every requested element, and rewrite or label every unsupported claim.',
              'Use the complete Markdown as the authoritative source. Pass it—or a bundle source when assets are needed—directly to convert_document, and revise by editing the complete Markdown and converting again.',
              'Use create_document_bundle only when reusing a large Markdown-and-asset bundle across several review or conversion operations would materially reduce retransmission.',
              'Use inspect_document or validate_document when semantic structure, content retention, accessibility, or target diagnostics need review; repair actionable findings in the authoritative Markdown.',
              'Use preview_document when visual evidence is needed, inspect previewBasis, and repair overflow or layout problems in the authoritative Markdown.',
              normalizedTarget === 'pptx'
                ? 'For visual polish, replace selected content blocks with compatible recommended templates; use patterns such as definitionCard for a definition, dataTable for a true table, comparisonBar for supported numeric comparisons, and list for concise steps when the returned catalog supports them. Preserve all required content and preview again.'
                : 'For visual polish, use native headings, tables, and checklists where they improve scanning; keep complete-body content when a visual template would discard detail, then preview again.',
              'Convert to immutable artifacts, inspect conversion reports, and save only final durable outputs.',
            ],
            syntax: {
              headingAnnotation: '# Heading {[content]}',
              standaloneAnnotation: '{[content]}',
              standaloneWarning:
                'A standalone annotation creates an additional heading-less block. Bind it to a heading unless that extra block is deliberate.',
            },
            formats,
            templates,
            themes: schemaModule
              .getThemeSummaries()
              .slice(0, MCP_WIRE_LIMITS.arrayEntries)
              .map((theme) => ({
                id: requireWireIdentifier(theme.id, 'theme id'),
                name: boundWireText(theme.name, MCP_WIRE_LIMITS.labelCharacters, theme.id),
                description: boundWireText(theme.description ?? ''),
              })),
            transformStyles: transformModule
              .getTransformStyleSummaries()
              .slice(0, MCP_WIRE_LIMITS.arrayEntries)
              .map((style) => ({
                id: requireWireIdentifier(style.id, 'transform style id'),
                name: boundWireText(style.name, MCP_WIRE_LIMITS.labelCharacters, style.id),
                description: boundWireText(style.description),
              })),
            recommendations,
            totalBlocks,
            truncated,
          };
          return textAndStructured(payload, compactAuthoringContextText(payload));
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'list_templates',
    {
      description: 'List Squisq authoring templates agents can use in Markdown annotations.',
      inputSchema: z.object({}).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.list_templates,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const templates = (await authoringTemplateCatalog()).map(({ id, label, description }) => ({
          id,
          label,
          description,
        }));
        return textAndStructured({ templates });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect');
      }
    },
  );

  server.registerTool(
    'describe_template',
    {
      description: 'Describe one Squisq template and its exact Markdown annotation inputs.',
      inputSchema: z.object({ templateId: identifierSchema }).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.describe_template,
      annotations: READ_ONLY,
    },
    async ({ templateId }) => {
      try {
        const described = (await authoringTemplateCatalog()).find(
          (template) => template.id === templateId,
        );
        if (!described) {
          return errorResult(new Error(`Unknown template "${templateId}"`), 'validate');
        }
        const template = {
          id: described.id,
          label: described.label,
          description: described.description,
          inputs: described.inputs,
        };
        return textAndStructured({
          template,
          annotationExample: described.annotationExample,
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect');
      }
    },
  );

  server.registerTool(
    'recommend_templates',
    {
      description:
        'Profile each bounded document block with the linked Squisq recommender and return content-compatible template candidates.',
      inputSchema: z
        .object({
          source: documentSourceSchema,
          candidateTemplateIds: z.array(identifierSchema).max(256).optional(),
          maxBlocks: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.recommend_templates,
      annotations: READ_ONLY,
    },
    async ({ source, candidateTemplateIds, maxBlocks }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const prepared = await documents.prepare(requireDocumentSource(source), operationSignal);
          const [{ flattenBlocks, getAvailableTemplates }, recommendModule] = await Promise.all([
            import('@bendyline/squisq/doc'),
            import('@bendyline/squisq/recommend'),
          ]);
          const available = getAvailableTemplates();
          const candidates = candidateTemplateIds ?? available;
          const unknown = candidates.find((id) => !available.includes(id));
          if (unknown) throw new Error(`Unknown template "${unknown}"`);
          const blocks = flattenBlocks(prepared.doc.blocks);
          const limit = maxBlocks ?? 50;
          const recommendations = blocks.slice(0, limit).map((block) => {
            const profile = recommendModule.profileBlockContents(block.contents ?? []);
            return {
              blockId: toWireIdentifier(block.id, 'block'),
              title: boundNullableWireText(block.title, MCP_WIRE_LIMITS.labelCharacters),
              profile: {
                ...profile,
                hasAsciiDiagram: profile.hasAsciiDiagram ?? false,
                hasTimeline: profile.hasTimeline ?? false,
                hasTree: profile.hasTree ?? false,
              },
              recommendedTemplateIds: recommendModule
                .recommendTemplatesForBlock(profile, candidates)
                .recommended.slice(0, 256)
                .map((id) => requireWireIdentifier(id, 'recommended template id')),
            };
          });
          return textAndStructured({
            recommendations,
            totalBlocks: blocks.length,
            truncated: recommendations.length < blocks.length,
          });
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect', null, extra.signal);
      }
    },
  );
}

function registerThemeTools(server: McpServer, context: AgenticToolContext): void {
  server.registerTool(
    'describe_theme',
    {
      description:
        'Describe one built-in or document-scoped custom Squisq theme before conversion.',
      inputSchema: z
        .object({
          themeId: identifierSchema,
          source: documentSourceSchema.optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.describe_theme,
      annotations: READ_ONLY,
    },
    async ({ themeId, source }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const [docModule, schemaModule] = await Promise.all([
            import('@bendyline/squisq/doc'),
            import('@bendyline/squisq/schemas'),
          ]);
          const prepared = source
            ? await new DocumentService(await context.authority, context.artifacts).prepare(
                requireDocumentSource(source),
                operationSignal,
              )
            : null;
          throwIfAborted(operationSignal);
          const documentTheme = prepared?.doc.customThemes?.find((theme) => theme.id === themeId);
          const builtIn = Object.prototype.hasOwnProperty.call(schemaModule.THEMES, themeId);
          if (!documentTheme && !builtIn) {
            return errorResult(new Error(`Unknown theme "${themeId}"`), 'validate');
          }
          const theme = docModule.resolveThemeForDoc(prepared?.doc, themeId);
          return textAndStructured({
            theme: summarizeTheme(theme),
            source: documentTheme ? ('document' as const) : ('built-in' as const),
          });
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'infer_theme_from_file',
    {
      description:
        'Infer a reusable Squisq theme and optional custom layout summaries from a DOCX, PPTX, or XLSX file/artifact.',
      inputSchema: z
        .object({ source: documentSourceSchema, inferLayouts: z.boolean().optional() })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.infer_theme_from_file,
      annotations: READ_ONLY,
    },
    async ({ source, inferLayouts }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const binary = await documents.readBinarySource(
            requireDocumentSource(source),
            operationSignal,
          );
          if (!['docx', 'pptx', 'xlsx'].includes(binary.format)) {
            throw new Error('Theme inference requires DOCX, PPTX, or XLSX input');
          }
          const { inferThemeFromFile } = await import('@bendyline/squisq-formats');
          const inferred = await inferThemeFromFile(ownedArrayBuffer(binary.bytes), {
            signal: operationSignal,
            format: binary.format as 'docx' | 'pptx' | 'xlsx',
            inferLayouts,
            nameHint: binary.filename,
            maxEntries: 2_048,
            maxEntryUncompressedBytes: 100 * 1024 * 1024,
            maxUncompressedBytes: 100 * 1024 * 1024,
          });
          throwIfAborted(operationSignal);
          const payload = {
            sourceFormat: binary.format,
            sourceSha256: binary.sha256,
            theme: summarizeTheme(inferred.theme),
            layouts: (inferred.layouts ?? []).slice(0, 1_000).map((layout, index) => ({
              id: boundWireText(
                layout.name,
                MCP_WIRE_LIMITS.labelCharacters,
                `layout-${index + 1}`,
              ),
              name: boundWireText(
                layout.label,
                MCP_WIRE_LIMITS.labelCharacters,
                `Layout ${index + 1}`,
              ),
              description: boundWireText(layout.description ?? ''),
            })),
            warnings: boundWireWarnings(inferred.warnings),
          };
          return textAndStructured(payload);
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'inspect_pptx_layouts',
    {
      description:
        'Inspect PowerPoint slide masters/layouts and show built-in matches or inferred custom-template candidates.',
      inputSchema: z.object({ source: documentSourceSchema }).strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.inspect_pptx_layouts,
      annotations: READ_ONLY,
    },
    async ({ source }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const binary = await documents.readBinarySource(
            requireDocumentSource(source),
            operationSignal,
          );
          if (binary.format !== 'pptx')
            throw new Error('PPTX layout inspection requires PPTX input');
          const { inspectPptxLayouts } = await import('@bendyline/squisq-formats/pptx');
          const result = await inspectPptxLayouts(ownedArrayBuffer(binary.bytes), {
            signal: operationSignal,
            maxEntries: 2_048,
            maxEntryUncompressedBytes: 100 * 1024 * 1024,
            maxUncompressedBytes: 100 * 1024 * 1024,
          });
          throwIfAborted(operationSignal);
          return textAndStructured({
            slideSize: result.slideSize,
            layouts: result.layouts.slice(0, 2_048).map((layout, index) => ({
              layoutPath: boundWireText(
                layout.layoutPath,
                MCP_WIRE_LIMITS.pathCharacters,
                `ppt/slideLayouts/slideLayout${index + 1}.xml`,
              ),
              name: boundWireText(
                layout.name,
                MCP_WIRE_LIMITS.labelCharacters,
                `Layout ${index + 1}`,
              ),
              masterName: boundNullableWireText(layout.masterName, MCP_WIRE_LIMITS.labelCharacters),
              type: boundNullableWireText(layout.typeAttr, MCP_WIRE_LIMITS.labelCharacters),
              slideCount: layout.slideCount,
              verdict: layout.verdict,
              templateId: boundNullableWireText(
                layout.builtinTemplate ?? layout.customTemplate?.name,
                MCP_WIRE_LIMITS.labelCharacters,
              ),
              notes: boundWireTextArray(layout.notes ?? [], 1_000),
            })),
          });
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'inspect', null, extra.signal);
      }
    },
  );

  server.registerTool(
    'apply_inferred_theme',
    {
      description:
        'Infer a theme from a DOCX, PPTX, or XLSX reference and embed it, optional custom layouts, and all source assets into a reusable DBK artifact.',
      inputSchema: z
        .object({
          source: documentSourceSchema,
          themeSource: documentSourceSchema,
          inferLayouts: z.boolean().optional(),
        })
        .strict(),
      outputSchema: DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS.apply_inferred_theme,
      annotations: ARTIFACT_CREATING,
    },
    async ({ source, themeSource, inferLayouts }, extra) => {
      try {
        return await context.runOperation(extra.signal, async (operationSignal) => {
          const documents = new DocumentService(await context.authority, context.artifacts);
          const [prepared, binary] = await Promise.all([
            documents.prepare(requireDocumentSource(source), operationSignal),
            documents.readBinarySource(requireDocumentSource(themeSource), operationSignal),
          ]);
          throwIfAborted(operationSignal);
          if (!['docx', 'pptx', 'xlsx'].includes(binary.format)) {
            throw new Error('Theme application requires DOCX, PPTX, or XLSX theme input');
          }
          const { inferThemeFromFile } = await import('@bendyline/squisq-formats');
          const inferred = await inferThemeFromFile(ownedArrayBuffer(binary.bytes), {
            signal: operationSignal,
            format: binary.format as 'docx' | 'pptx' | 'xlsx',
            inferLayouts,
            nameHint: binary.filename,
            maxEntries: 2_048,
            maxEntryUncompressedBytes: 100 * 1024 * 1024,
            maxUncompressedBytes: 100 * 1024 * 1024,
          });
          throwIfAborted(operationSignal);
          const customThemes = [
            ...(prepared.doc.customThemes ?? []).filter((theme) => theme.id !== inferred.theme.id),
            inferred.theme,
          ];
          const inferredLayoutNames = new Set(
            (inferred.layouts ?? []).map((layout) => layout.name),
          );
          const customTemplates = [
            ...(prepared.doc.customTemplates ?? []).filter(
              (template) => !inferredLayoutNames.has(template.name),
            ),
            ...(inferred.layouts ?? []),
          ];
          const themedDoc = {
            ...prepared.doc,
            themeId: inferred.theme.id,
            customThemes,
            customTemplates,
            frontmatter: {
              ...(prepared.doc.frontmatter ?? {}),
              'squisq-theme': inferred.theme.id,
            },
          };
          const [{ docToMarkdown }, { stringifyMarkdown }] = await Promise.all([
            import('@bendyline/squisq/doc'),
            import('@bendyline/squisq/markdown'),
          ]);
          const markdownDoc = docToMarkdown(themedDoc);
          const markdown = stringifyMarkdown(markdownDoc);
          const [result] = await convertPreparedDocument(
            context.artifacts,
            {
              ...prepared,
              doc: themedDoc,
              markdownDoc,
              markdown,
              diagnostics: [
                ...prepared.diagnostics,
                ...inferred.warnings.map((warning) =>
                  warningDiagnostic(warning, 'transform', binary.format),
                ),
              ],
            },
            {
              themeId: inferred.theme.id,
              targets: [{ format: 'dbk', fidelity: 'semantic' }],
            },
            operationSignal,
          );
          if (!result) throw new Error('Themed DBK conversion produced no artifact');
          requireWire(parseConversionResult(result), 'conversion');
          const payload = {
            result,
            theme: summarizeTheme(inferred.theme),
            layoutIds: (inferred.layouts ?? [])
              .slice(0, 1_000)
              .map((layout) => boundWireText(layout.name, MCP_WIRE_LIMITS.labelCharacters)),
            warnings: boundWireWarnings(inferred.warnings),
          };
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(payload) },
              artifactLink(result.artifact),
            ],
            structuredContent: asStructuredContent(successResult(payload)),
          };
        });
      } catch (caught: unknown) {
        return errorResult(caught, 'transform', null, extra.signal);
      }
    },
  );
}

function requireDocumentSource(value: unknown): DocumentSource {
  return requireWire(parseDocumentSource(value), 'document source');
}

async function isRenderedMediaPreviewSource(
  source: DocumentSource,
  artifacts: ArtifactStore,
): Promise<boolean> {
  if (source.kind === 'file') {
    const format = source.format?.toLowerCase().replace(/^\./u, '');
    return format && format !== 'auto'
      ? format === 'mp4' || format === 'gif'
      : /\.(?:mp4|gif)$/iu.test(source.path);
  }
  if (source.kind !== 'artifact') return false;
  const artifact = await artifacts.get(source.uri);
  const format = artifact.format.toLowerCase().replace(/^\./u, '');
  return format === 'mp4' || format === 'gif';
}

function requireWire<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Invalid canonical MCP ${label}`);
  return value;
}

function toConversionTarget(
  value: z.infer<typeof conversionTargetSchema>,
): ConversionTargetRequest {
  const { format, fidelity, ...options } = value;
  return {
    format,
    fidelity,
    options: Object.fromEntries(
      Object.entries(options).filter((entry) => entry[1] !== undefined),
    ) as Record<string, string | number | boolean | null>,
  };
}

function artifactLink(artifact: ArtifactRef) {
  return {
    type: 'resource_link' as const,
    uri: artifact.uri,
    name: artifact.suggestedFilename,
    description: `${artifact.format} artifact (${artifact.sha256})`,
    mimeType: artifact.mimeType,
    size: artifact.size,
  };
}

async function sendProgress(
  extra: {
    _meta?: { progressToken?: string | number };
    sendNotification(notification: {
      method: 'notifications/progress';
      params: { progressToken: string | number; progress: number; total: number; message: string };
    }): Promise<void>;
  },
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  await reportMcpProgress(extra, progress, total, message);
}

function textAndStructured<T extends object>(payload: T, text = JSON.stringify(payload, null, 2)) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: asStructuredContent(successResult(payload)),
  };
}

function compactAuthoringContextText(context: AuthoringContextResult): string {
  const target = context.targetFormat ?? 'unspecified target';
  const lines = [
    `DocBlocks authoring contract: ${target}, ${context.goal}.`,
    `Default template: ${context.defaultTemplateId}. Default fidelity: ${context.defaultFidelity ?? 'select for target'}.`,
    '',
    'Required workflow:',
    ...context.workflow.map((step, index) => `${index + 1}. ${step}`),
    '',
    `Heading annotation: ${context.syntax.headingAnnotation}`,
    `Warning: ${context.syntax.standaloneWarning}`,
    `Templates (${context.templates.length}): ${context.templates.map(({ id }) => id).join(', ')}`,
    `Themes (${context.themes.length}): ${context.themes.map(({ id }) => id).join(', ')}`,
    `Transform styles (${context.transformStyles.length}): ${context.transformStyles.map(({ id }) => id).join(', ')}`,
  ];
  if (context.recommendations.length > 0) {
    lines.push(
      `Recommended blocks: ${context.recommendations
        .map(
          ({ blockId, recommendedTemplateIds }) =>
            `${blockId} -> ${recommendedTemplateIds.join('/')}`,
        )
        .join('; ')}`,
    );
  }
  lines.push(
    '',
    'The complete exact format, template-input, theme, transform, and recommendation catalog is in structuredContent. Use describe_template for focused follow-up when structured content is unavailable.',
  );
  return lines.join('\n');
}

function asStructuredContent(payload: object): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function summarizeTheme(theme: {
  id: string;
  name: string;
  description?: string;
  colors: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    highlight: string;
  };
  typography: { bodyFont: unknown; titleFont: unknown };
}) {
  const id = requireWireIdentifier(theme.id, 'theme id');
  return {
    id,
    name: boundWireText(theme.name, MCP_WIRE_LIMITS.labelCharacters, id),
    description: boundWireText(theme.description ?? ''),
    colors: {
      primary: boundWireText(theme.colors.primary, MCP_WIRE_LIMITS.labelCharacters, '#000000'),
      secondary: boundWireText(theme.colors.secondary, MCP_WIRE_LIMITS.labelCharacters, '#000000'),
      background: boundWireText(
        theme.colors.background,
        MCP_WIRE_LIMITS.labelCharacters,
        '#ffffff',
      ),
      text: boundWireText(theme.colors.text, MCP_WIRE_LIMITS.labelCharacters, '#000000'),
      highlight: boundWireText(theme.colors.highlight, MCP_WIRE_LIMITS.labelCharacters, '#000000'),
    },
    bodyFont: boundWireText(JSON.stringify(theme.typography.bodyFont) ?? ''),
    titleFont: boundWireText(JSON.stringify(theme.typography.titleFont) ?? ''),
  };
}

async function authoringTemplateCatalog() {
  const {
    getAvailableTemplates,
    TEMPLATE_AUTHORING_METADATA,
    TEMPLATE_INPUT_DESCRIPTORS,
    TEMPLATE_METADATA,
  } = await import('@bendyline/squisq/doc');
  const authoring = TEMPLATE_AUTHORING_METADATA as Record<string, TemplateAuthoringMetadata>;
  return getAvailableTemplates()
    .slice(0, MCP_WIRE_LIMITS.arrayEntries)
    .map((id) => {
      const metadata = TEMPLATE_METADATA[id];
      const behavior = authoring[id];
      if (!behavior) throw new Error(`Template "${id}" has no authoring metadata`);
      const inputs = (TEMPLATE_INPUT_DESCRIPTORS[id] ?? [])
        .slice(0, MCP_WIRE_LIMITS.arrayEntries)
        .map((input) => ({
          key: requireWireIdentifier(input.key, 'template input key'),
          description: boundWireText(input.description),
          type: boundWireText(input.coerce ?? 'string', MCP_WIRE_LIMITS.labelCharacters, 'string'),
          required: input.required ?? false,
          values: boundWireTextArray(
            input.values ?? [],
            MCP_WIRE_LIMITS.arrayEntries,
            MCP_WIRE_LIMITS.labelCharacters,
          ),
          valueHint: boundNullableWireText(input.valueHint, MCP_WIRE_LIMITS.labelCharacters),
        }));
      const required = inputs
        .filter((input) => input.required)
        .map((input) => `${input.key}="…"`)
        .join(' ');
      return {
        id: requireWireIdentifier(id, 'template id'),
        label: boundWireText(metadata?.label ?? id, MCP_WIRE_LIMITS.labelCharacters, id),
        description: boundWireText(metadata?.description ?? ''),
        inputs,
        ...behavior,
        annotationExample: boundWireText(`# Heading {[${id}${required ? ` ${required}` : ''}]}`),
      };
    });
}

function authoringDefaultFidelity(
  targetFormat: string | null,
  goal: 'content-first' | 'visual-polish',
): ConversionFidelity | null {
  if (!targetFormat) return null;
  if (targetFormat === 'mp4' || targetFormat === 'gif') return 'rendered-fidelity';
  if (goal === 'visual-polish' && (targetFormat === 'pptx' || targetFormat === 'pdf')) {
    return 'rendered-fidelity';
  }
  if (targetFormat === 'docx' || targetFormat === 'pptx' || targetFormat === 'xlsx') {
    return 'editable-native';
  }
  return 'semantic';
}

function boundedFormatCapabilities() {
  return MCP_FORMAT_CAPABILITIES.slice(0, 64).map((format) => {
    const id = requireWireIdentifier(format.id, 'format id');
    if (id.length > MCP_WIRE_LIMITS.formatCharacters || !MCP_OUTPUT_PATTERNS.format.test(id)) {
      throw new Error('Linked Squisq returned an invalid MCP format id');
    }
    return {
      id,
      label: boundWireText(format.label, MCP_WIRE_LIMITS.labelCharacters, id),
      mimeType: format.mimeType,
      extensions: boundWireTextArray(format.extensions, 64, MCP_WIRE_LIMITS.labelCharacters),
      import: { ...format.import },
      export: { ...format.export },
    };
  });
}

export { MCP_FORMAT_CAPABILITIES };
