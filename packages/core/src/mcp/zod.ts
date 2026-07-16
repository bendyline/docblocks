import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import {
  MCP_WIRE_LIMITS,
  parseArtifactRef,
  parseComparisonResult,
  parseConversionResult,
  parseInspectionResult,
  parsePreviewResult,
  parseValidationResult,
} from './wire.js';
import type {
  DescribeTemplateResult,
  DescribeThemeResult,
  DocBlocksMcpToolName,
  FormatCapabilitySummary,
  FormatDirectionCapability,
  InferThemeResult,
  InspectPptxLayoutsResult,
  ListFormatsResult,
  ListRootsResult,
  ListTemplatesResult,
  ListThemesResult,
  ListTransformStylesResult,
  PptxLayoutSummary,
  RecommendTemplatesResult,
  RootGrantSummary,
  TemplateContentProfile,
  TemplateInputSummary,
  TemplateRecommendation,
  TemplateSummary,
  ThemeCatalogEntry,
  ThemeDescription,
  TransformStyleSummary,
} from './types.js';

/** Canonical Zod projection of the exact MCP wire contract for protocol SDKs. */

export const MAX_MARKDOWN_CHARACTERS = 20 * 1024 * 1024;
export const MAX_PATH_CHARACTERS = 4_096;
const MAX_ID_CHARACTERS = 256;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FORMAT_PATTERN = /^[a-z0-9][a-z0-9.+_-]*$/u;
const INPUT_FORMAT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;
const ARTIFACT_URI_PATTERN = /^docblocks:\/\/artifacts\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/* eslint-disable no-control-regex -- Wire contracts must publish explicit control-byte exclusions. */
const WIRE_STRING_PATTERN = new RegExp('^[^\\u0000\\u007f]*$', 'u');
const WORKSPACE_PATH_PATTERN = new RegExp(
  '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)(?:\\.{1,2})(?:/|$))(?!.*//)(?!.*[\\\\\\u0000-\\u001f\\u007f])(?!.*/$).+$',
  'u',
);
const SAFE_FILENAME_PATTERN = new RegExp('^(?!\\.{1,2}$)[^/\\\\\\u0000\\u007f]+$', 'u');
/* eslint-enable no-control-regex */

const boundedString = z
  .string()
  .max(MCP_WIRE_LIMITS.messageCharacters)
  .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire');
const boundedNonEmptyString = z
  .string()
  .min(1)
  .max(MCP_WIRE_LIMITS.messageCharacters)
  .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire');
const labelSchema = z
  .string()
  .max(MCP_WIRE_LIMITS.labelCharacters)
  .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire');
const nonEmptyLabelSchema = labelSchema.min(1);
const excerptSchema = z
  .string()
  .max(MCP_WIRE_LIMITS.excerptCharacters)
  .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire');
const uriTextSchema = z
  .string()
  .min(1)
  .max(MCP_WIRE_LIMITS.uriCharacters)
  .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire');
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().min(1).max(MAX_ID_CHARACTERS).regex(IDENTIFIER_PATTERN);
export const formatSchema = z
  .string()
  .min(1)
  .max(MCP_WIRE_LIMITS.formatCharacters)
  .regex(FORMAT_PATTERN);
/** Case-insensitive format input which handlers normalize before publishing it on the wire. */
export const formatInputSchema = z
  .string()
  .min(1)
  .max(MCP_WIRE_LIMITS.formatCharacters)
  .regex(INPUT_FORMAT_PATTERN);
const mimeTypeSchema = z
  .string()
  .min(3)
  .max(MCP_WIRE_LIMITS.mimeTypeCharacters)
  .regex(MIME_TYPE_PATTERN);
const isoTimestampSchema = z
  .string()
  .regex(ISO_TIMESTAMP_PATTERN)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }, 'Expected a canonical UTC timestamp with millisecond precision');
const engineNameSchema = z
  .string()
  .min(1)
  .max(MAX_ID_CHARACTERS)
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._:-]*|@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u,
  );
const workspacePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARACTERS)
  .regex(WORKSPACE_PATH_PATTERN, 'Expected a canonical root-relative forward-slash path')
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !/^[a-zA-Z]:/u.test(value) &&
      !value.split('/').some((segment) => !segment || segment === '.' || segment === '..') &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
    'Expected a canonical root-relative forward-slash path',
  );
export const artifactUriSchema = z
  .string()
  .max('docblocks://artifacts/'.length + MAX_ID_CHARACTERS)
  .regex(ARTIFACT_URI_PATTERN);

const assetSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), rootId: idSchema, path: workspacePathSchema }).strict(),
  z.object({ kind: z.literal('artifact'), uri: artifactUriSchema }).strict(),
]);

export const bundleAssetSchema = z
  .object({
    path: workspacePathSchema,
    source: assetSourceSchema,
    mimeType: mimeTypeSchema.nullable(),
    altText: labelSchema.nullable(),
    credit: labelSchema.nullable(),
    license: labelSchema.nullable(),
  })
  .strict();

export const bundleDocumentSourceSchema = z
  .object({
    kind: z.literal('bundle'),
    markdown: z
      .string()
      .max(MAX_MARKDOWN_CHARACTERS)
      .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire'),
    assets: z.array(bundleAssetSchema).max(MCP_WIRE_LIMITS.bundleAssets),
    name: labelSchema.nullable().optional().default(null),
  })
  .strict();

export const documentSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('markdown'),
      markdown: z
        .string()
        .max(MAX_MARKDOWN_CHARACTERS)
        .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire'),
      name: labelSchema.nullable().optional().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      rootId: idSchema,
      path: workspacePathSchema,
      format: formatSchema.nullable().optional().default(null),
    })
    .strict(),
  z.object({ kind: z.literal('artifact'), uri: artifactUriSchema }).strict(),
  bundleDocumentSourceSchema,
]);

const appliedOptionSchema = z
  .object({
    name: idSchema,
    value: z.union([boundedString, z.number().finite(), z.boolean(), z.null()]),
  })
  .strict();
const engineVersionSchema = z
  .object({ name: engineNameSchema, version: boundedNonEmptyString })
  .strict();

export const artifactRefSchema = z
  .object({
    id: idSchema,
    uri: artifactUriSchema,
    format: formatSchema,
    mimeType: mimeTypeSchema,
    size: z.number().int().nonnegative().max(MCP_WIRE_LIMITS.artifactBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceFormat: formatSchema.nullable(),
    sourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    suggestedFilename: z
      .string()
      .min(1)
      .max(MCP_WIRE_LIMITS.labelCharacters)
      .regex(SAFE_FILENAME_PATTERN),
    appliedOptions: z.array(appliedOptionSchema).max(MCP_WIRE_LIMITS.arrayEntries),
    engineVersions: z.array(engineVersionSchema).max(MCP_WIRE_LIMITS.arrayEntries),
    createdAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => addExactWireIssue(parseArtifactRef(value), context));

const diagnosticLocationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('source'),
      line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      column: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ kind: z.literal('block'), blockId: idSchema, nodeType: idSchema }).strict(),
  z.object({ kind: z.literal('asset'), path: workspacePathSchema }).strict(),
  z
    .object({
      kind: z.literal('item'),
      itemKind: z.enum(['page', 'slide', 'sheet', 'frame']),
      index: nonNegativeSafeIntegerSchema,
    })
    .strict(),
]);

export const diagnosticSchema = z
  .object({
    code: idSchema,
    severity: z.enum(['info', 'warning', 'error']),
    stage: z.enum([
      'resolve',
      'import',
      'parse',
      'inspect',
      'validate',
      'transform',
      'convert',
      'render',
      'export',
      'materialize',
      'compare',
    ]),
    format: formatSchema.nullable(),
    count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    message: boundedString,
    remediation: boundedString.nullable(),
    retryable: z.boolean(),
    location: diagnosticLocationSchema.nullable(),
  })
  .strict();

export const mcpErrorDetailSchema = z
  .object({
    code: idSchema,
    message: boundedNonEmptyString,
    stage: z
      .enum([
        'resolve',
        'import',
        'parse',
        'inspect',
        'validate',
        'transform',
        'convert',
        'render',
        'export',
        'materialize',
        'compare',
      ])
      .nullable(),
    format: formatSchema.nullable(),
    hint: boundedString.nullable(),
    retryable: z.boolean(),
    operationLoad: z
      .object({
        active: z.number().int().nonnegative().max(32),
        capacity: z.number().int().positive().max(32),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operationLoad && value.operationLoad.active > value.operationLoad.capacity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationLoad', 'active'],
        message: 'Active operation count cannot exceed capacity',
      });
    }
  });

export const mcpErrorResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('error'),
    result: z.null(),
    error: mcpErrorDetailSchema,
  })
  .strict();

/**
 * Root-object output schema compatible with MCP SDK 1.29's object normalizer.
 *
 * The SDK must see an object at the root, while clients must see the two exact
 * wire branches rather than independently-nullable fields. A Zod 4 object lets
 * us publish the branch schemas through standard JSON Schema `oneOf` metadata;
 * runtime validation still delegates to the original Zod 3 schemas so custom
 * exact-wire refinements remain authoritative.
 */
export function toolOutputSchema<T extends z.ZodTypeAny>(success: T) {
  const successEnvelope = z
    .object({
      version: z.literal(1),
      kind: z.literal('success'),
      result: success,
      error: z.null(),
    })
    .strict();
  const errorEnvelope = z
    .object({
      version: z.literal(1),
      kind: z.literal('error'),
      result: z.null(),
      error: mcpErrorDetailSchema,
    })
    .strict();
  const publishedSuccess = z4
    .object({
      version: z4.literal(1),
      kind: z4.literal('success'),
      result: projectZod3Schema(success),
      error: z4.null(),
    })
    .strict();
  const publishedError = z4
    .object({
      version: z4.literal(1),
      kind: z4.literal('error'),
      result: z4.null(),
      error: projectZod3Schema(mcpErrorDetailSchema),
    })
    .strict();
  const oneOf = [
    jsonSchemaWithoutDialect(publishedSuccess),
    jsonSchemaWithoutDialect(publishedError),
  ];

  return z4
    .object({
      version: z4.literal(1),
      kind: z4.enum(['success', 'error']),
      result: z4.unknown(),
      error: z4.unknown(),
    })
    .strict()
    .superRefine((value, context) => {
      const branch = value.kind === 'success' ? successEnvelope : errorEnvelope;
      const parsed = branch.safeParse(value);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
      }
    })
    .meta({ oneOf });
}

const assetSummarySchema = z
  .object({
    path: workspacePathSchema,
    mimeType: mimeTypeSchema,
    size: z.number().int().nonnegative().max(MCP_WIRE_LIMITS.artifactBytes),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    altText: labelSchema.nullable(),
    credit: labelSchema.nullable(),
    license: labelSchema.nullable(),
  })
  .strict();

export const conversionResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('conversion'),
    sourceFormat: formatSchema,
    targetFormat: formatSchema,
    artifact: artifactRefSchema,
    fidelity: z.enum(['semantic', 'editable-native', 'rendered-fidelity', 'hybrid']),
    appliedThemeId: idSchema.nullable(),
    appliedTransformId: idSchema.nullable(),
    sourceAssets: z.array(assetSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    sourceAssetCount: z.number().int().min(0).max(MCP_WIRE_LIMITS.arrayEntries),
    diagnostics: z.array(diagnosticSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict()
  .superRefine((value, context) => addExactWireIssue(parseConversionResult(value), context));

const metadataSchema = z
  .object({
    title: labelSchema.nullable(),
    author: labelSchema.nullable(),
    description: boundedString.nullable(),
  })
  .strict();
const statisticsSchema = z
  .object({
    blockCount: nonNegativeSafeIntegerSchema,
    wordCount: nonNegativeSafeIntegerSchema,
    characterCount: nonNegativeSafeIntegerSchema,
    tableCount: nonNegativeSafeIntegerSchema,
    linkCount: nonNegativeSafeIntegerSchema,
    assetCount: nonNegativeSafeIntegerSchema,
    pageCount: nonNegativeSafeIntegerSchema.nullable(),
    slideCount: nonNegativeSafeIntegerSchema.nullable(),
    sheetCount: nonNegativeSafeIntegerSchema.nullable(),
  })
  .strict();
const outlineEntrySchema = z
  .object({
    id: idSchema,
    title: nonEmptyLabelSchema,
    level: z.number().int().min(1).max(6),
    blockIndex: nonNegativeSafeIntegerSchema,
  })
  .strict();
const blockSummarySchema = z
  .object({
    id: idSchema,
    type: idSchema,
    text: excerptSchema,
    wordCount: nonNegativeSafeIntegerSchema,
    templateId: idSchema.nullable(),
    sourceRange: z
      .object({ start: nonNegativeSafeIntegerSchema, end: nonNegativeSafeIntegerSchema })
      .strict()
      .nullable(),
  })
  .strict();
const tableSummarySchema = z
  .object({
    index: nonNegativeSafeIntegerSchema,
    rowCount: nonNegativeSafeIntegerSchema,
    columnCount: nonNegativeSafeIntegerSchema,
    headers: z.array(labelSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict();
const linkSummarySchema = z
  .object({
    index: nonNegativeSafeIntegerSchema,
    text: labelSchema,
    target: uriTextSchema,
  })
  .strict();
const documentItemSummarySchema = z
  .object({
    kind: z.enum(['page', 'slide', 'sheet', 'frame']),
    index: nonNegativeSafeIntegerSchema,
    label: labelSchema.nullable(),
    blockIds: z.array(idSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict();
const themeSummarySchema = z
  .object({
    id: idSchema,
    name: nonEmptyLabelSchema,
    source: z.enum(['built-in', 'document', 'inferred']),
    layouts: z.array(nonEmptyLabelSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict();

export const inspectionResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('inspection'),
    sourceFormat: formatSchema,
    metadata: metadataSchema,
    statistics: statisticsSchema,
    outline: z.array(outlineEntrySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    blocks: z.array(blockSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    blockOffset: z.number().int().min(0).max(MCP_WIRE_LIMITS.arrayEntries),
    nextCursor: z
      .string()
      .max(MCP_WIRE_LIMITS.identifierCharacters)
      .regex(WIRE_STRING_PATTERN)
      .nullable(),
    tables: z.array(tableSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    links: z.array(linkSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    items: z.array(documentItemSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    assets: z.array(assetSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
    theme: themeSummarySchema.nullable(),
    truncated: z.boolean(),
    detailsTruncated: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict()
  .superRefine((value, context) => addExactWireIssue(parseInspectionResult(value), context));

export const validationResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('validation'),
    sourceFormat: formatSchema,
    targetFormat: formatSchema.nullable(),
    valid: z.boolean(),
    summary: z
      .object({
        errorCount: nonNegativeSafeIntegerSchema,
        warningCount: nonNegativeSafeIntegerSchema,
        infoCount: nonNegativeSafeIntegerSchema,
      })
      .strict(),
    diagnostics: z.array(diagnosticSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict()
  .superRefine((value, context) => addExactWireIssue(parseValidationResult(value), context));

const previewItemSchema = z
  .object({
    kind: z.enum(['page', 'slide', 'sheet', 'frame']),
    index: nonNegativeSafeIntegerSchema,
    label: labelSchema.nullable(),
    artifact: artifactRefSchema,
    width: z.number().int().min(1).max(MCP_WIRE_LIMITS.imageDimension),
    height: z.number().int().min(1).max(MCP_WIRE_LIMITS.imageDimension),
  })
  .strict();
export const previewResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('preview'),
    sourceFormat: formatSchema,
    previewBasis: z.enum(['source-render', 'reconstructed-import', 'native-extracted']),
    totalItems: nonNegativeSafeIntegerSchema,
    items: z.array(previewItemSchema).max(MCP_WIRE_LIMITS.previewItems),
    truncated: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict()
  .superRefine((value, context) => addExactWireIssue(parsePreviewResult(value), context));

const comparisonChangeSchema = z
  .object({
    category: z.enum([
      'text',
      'structure',
      'table',
      'media',
      'theme',
      'layout',
      'metadata',
      'timing',
      'accessibility',
    ]),
    status: z.enum(['retained', 'changed', 'degraded', 'omitted', 'added']),
    path: z.string().max(MCP_WIRE_LIMITS.pathCharacters).regex(WIRE_STRING_PATTERN).nullable(),
    message: boundedNonEmptyString,
  })
  .strict();
const comparisonMetricSchema = z
  .object({
    name: idSchema,
    leftValue: z.number().finite(),
    rightValue: z.number().finite(),
    similarity: z.number().min(0).max(1),
  })
  .strict();
export const comparisonResultSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('comparison'),
    leftFormat: formatSchema,
    rightFormat: formatSchema,
    equivalent: z.boolean(),
    score: z.number().min(0).max(1),
    changes: z.array(comparisonChangeSchema).max(MCP_WIRE_LIMITS.arrayEntries),
    metrics: z.array(comparisonMetricSchema).max(MCP_WIRE_LIMITS.arrayEntries),
    diagnostics: z.array(diagnosticSchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict()
  .superRefine((value, context) => addExactWireIssue(parseComparisonResult(value), context));

const boundedPathTextSchema = z
  .string()
  .min(1)
  .max(MCP_WIRE_LIMITS.pathCharacters)
  .regex(WIRE_STRING_PATTERN, 'NUL and DEL are not permitted on the MCP wire');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const convertDocumentResultSchema = z
  .object({ results: z.array(conversionResultSchema).min(1).max(12) })
  .strict();

export const rootGrantSummarySchema = z
  .object({
    id: idSchema,
    label: nonEmptyLabelSchema,
    read: z.boolean(),
    write: z.boolean(),
  })
  .strict() satisfies z.ZodType<RootGrantSummary>;

export const listRootsResultSchema = z
  .object({ roots: z.array(rootGrantSummarySchema).max(64) })
  .strict() satisfies z.ZodType<ListRootsResult>;

export const saveArtifactResultSchema = z
  .object({
    artifact: artifactRefSchema,
    destination: z.object({ rootId: idSchema, path: workspacePathSchema }).strict(),
    sha256: sha256Schema,
  })
  .strict();

export const formatDirectionCapabilitySchema = z.discriminatedUnion('supported', [
  z
    .object({
      supported: z.literal(true),
      tool: z.enum(['inspect_document', 'convert_document']),
    })
    .strict(),
  z.object({ supported: z.literal(false), excludedReason: boundedString }).strict(),
]) satisfies z.ZodType<FormatDirectionCapability>;

export const formatCapabilitySummarySchema = z
  .object({
    id: formatSchema,
    label: nonEmptyLabelSchema,
    mimeType: mimeTypeSchema,
    extensions: z.array(nonEmptyLabelSchema).max(64),
    import: formatDirectionCapabilitySchema,
    export: formatDirectionCapabilitySchema,
  })
  .strict() satisfies z.ZodType<FormatCapabilitySummary>;

export const listFormatsResultSchema = z
  .object({ formats: z.array(formatCapabilitySummarySchema).max(64) })
  .strict() satisfies z.ZodType<ListFormatsResult>;

export const themeCatalogEntrySchema = z
  .object({
    id: idSchema,
    name: nonEmptyLabelSchema,
    description: boundedString.optional(),
  })
  .strict() satisfies z.ZodType<ThemeCatalogEntry>;

export const listThemesResultSchema = z
  .object({ themes: z.array(themeCatalogEntrySchema).max(MCP_WIRE_LIMITS.arrayEntries) })
  .strict() satisfies z.ZodType<ListThemesResult>;

export const transformStyleSummarySchema = z
  .object({ id: idSchema, name: nonEmptyLabelSchema, description: boundedString })
  .strict() satisfies z.ZodType<TransformStyleSummary>;

export const listTransformStylesResultSchema = z
  .object({
    styles: z.array(transformStyleSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict() satisfies z.ZodType<ListTransformStylesResult>;

export const templateSummarySchema = z
  .object({ id: idSchema, label: nonEmptyLabelSchema, description: boundedString })
  .strict() satisfies z.ZodType<TemplateSummary>;

export const listTemplatesResultSchema = z
  .object({ templates: z.array(templateSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries) })
  .strict() satisfies z.ZodType<ListTemplatesResult>;

export const templateInputSummarySchema = z
  .object({
    key: idSchema,
    description: boundedString,
    type: nonEmptyLabelSchema,
    required: z.boolean(),
    values: z.array(labelSchema).max(MCP_WIRE_LIMITS.arrayEntries),
    valueHint: labelSchema.nullable(),
  })
  .strict() satisfies z.ZodType<TemplateInputSummary>;

export const describeTemplateResultSchema = z
  .object({
    template: templateSummarySchema
      .extend({ inputs: z.array(templateInputSummarySchema).max(MCP_WIRE_LIMITS.arrayEntries) })
      .strict(),
    annotationExample: boundedString,
  })
  .strict() satisfies z.ZodType<DescribeTemplateResult>;

export const templateContentProfileSchema = z
  .object({
    hasImage: z.boolean(),
    imageCount: nonNegativeSafeIntegerSchema,
    hasVideo: z.boolean(),
    hasBlockquote: z.boolean(),
    hasList: z.boolean(),
    hasTable: z.boolean(),
    hasDate: z.boolean(),
    hasNumberHighlight: z.boolean(),
    wordCount: nonNegativeSafeIntegerSchema,
    hasAsciiDiagram: z.boolean(),
    hasTimeline: z.boolean(),
    hasTree: z.boolean(),
  })
  .strict() satisfies z.ZodType<TemplateContentProfile>;

export const templateRecommendationSchema = z
  .object({
    blockId: idSchema,
    title: labelSchema.nullable(),
    profile: templateContentProfileSchema,
    recommendedTemplateIds: z.array(idSchema).max(256),
  })
  .strict() satisfies z.ZodType<TemplateRecommendation>;

export const recommendTemplatesResultSchema = z
  .object({
    recommendations: z.array(templateRecommendationSchema).max(100),
    totalBlocks: nonNegativeSafeIntegerSchema,
    truncated: z.boolean(),
  })
  .strict() satisfies z.ZodType<RecommendTemplatesResult>;

export const themeDescriptionSchema = z
  .object({
    id: idSchema,
    name: nonEmptyLabelSchema,
    description: boundedString,
    colors: z
      .object({
        primary: nonEmptyLabelSchema,
        secondary: nonEmptyLabelSchema,
        background: nonEmptyLabelSchema,
        text: nonEmptyLabelSchema,
        highlight: nonEmptyLabelSchema,
      })
      .strict(),
    bodyFont: boundedString,
    titleFont: boundedString,
  })
  .strict() satisfies z.ZodType<ThemeDescription>;

export const describeThemeResultSchema = z
  .object({ theme: themeDescriptionSchema, source: z.enum(['built-in', 'document']) })
  .strict() satisfies z.ZodType<DescribeThemeResult>;

export const inferredLayoutSummarySchema = z
  .object({ id: nonEmptyLabelSchema, name: nonEmptyLabelSchema, description: boundedString })
  .strict();

export const inferThemeResultSchema = z
  .object({
    sourceFormat: formatSchema,
    sourceSha256: sha256Schema,
    theme: themeDescriptionSchema,
    layouts: z.array(inferredLayoutSummarySchema).max(1_000),
    warnings: z.array(boundedString).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict() satisfies z.ZodType<InferThemeResult>;

export const pptxLayoutSummarySchema = z
  .object({
    layoutPath: boundedPathTextSchema,
    name: nonEmptyLabelSchema,
    masterName: labelSchema.nullable(),
    type: labelSchema.nullable(),
    slideCount: nonNegativeSafeIntegerSchema,
    verdict: z.enum(['builtin', 'custom', 'plain', 'skip']),
    templateId: labelSchema.nullable(),
    notes: z.array(boundedString).max(1_000),
  })
  .strict() satisfies z.ZodType<PptxLayoutSummary>;

export const inspectPptxLayoutsResultSchema = z
  .object({
    slideSize: z
      .object({ cx: nonNegativeSafeIntegerSchema, cy: nonNegativeSafeIntegerSchema })
      .strict(),
    layouts: z.array(pptxLayoutSummarySchema).max(2_048),
  })
  .strict() satisfies z.ZodType<InspectPptxLayoutsResult>;

export const applyInferredThemeResultSchema = z
  .object({
    result: conversionResultSchema,
    theme: themeDescriptionSchema,
    layoutIds: z.array(labelSchema).max(1_000),
    warnings: z.array(boundedString).max(MCP_WIRE_LIMITS.arrayEntries),
  })
  .strict();

/** Core-owned success payload schemas for every advertised canonical MCP tool. */
export const DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS: Readonly<
  Record<DocBlocksMcpToolName, z.ZodTypeAny>
> = Object.freeze({
  list_roots: listRootsResultSchema,
  get_conversion_report: conversionResultSchema,
  convert_document: convertDocumentResultSchema,
  create_document_bundle: conversionResultSchema,
  save_artifact: saveArtifactResultSchema,
  inspect_document: inspectionResultSchema,
  validate_document: validationResultSchema,
  preview_document: previewResultSchema,
  compare_documents: comparisonResultSchema,
  list_templates: listTemplatesResultSchema,
  describe_template: describeTemplateResultSchema,
  recommend_templates: recommendTemplatesResultSchema,
  describe_theme: describeThemeResultSchema,
  infer_theme_from_file: inferThemeResultSchema,
  inspect_pptx_layouts: inspectPptxLayoutsResultSchema,
  apply_inferred_theme: applyInferredThemeResultSchema,
  list_formats: listFormatsResultSchema,
  list_themes: listThemesResultSchema,
  list_transform_styles: listTransformStylesResultSchema,
});

/** Exact success/error envelopes consumed directly by MCP tool registration. */
type DocBlocksMcpToolOutputSchema = ReturnType<typeof toolOutputSchema>;
export const DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS: Readonly<
  Record<DocBlocksMcpToolName, DocBlocksMcpToolOutputSchema>
> = Object.freeze({
  list_roots: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_roots),
  get_conversion_report: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.get_conversion_report),
  convert_document: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.convert_document),
  create_document_bundle: toolOutputSchema(
    DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.create_document_bundle,
  ),
  save_artifact: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.save_artifact),
  inspect_document: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.inspect_document),
  validate_document: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.validate_document),
  preview_document: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.preview_document),
  compare_documents: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.compare_documents),
  list_templates: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_templates),
  describe_template: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.describe_template),
  recommend_templates: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.recommend_templates),
  describe_theme: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.describe_theme),
  infer_theme_from_file: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.infer_theme_from_file),
  inspect_pptx_layouts: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.inspect_pptx_layouts),
  apply_inferred_theme: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.apply_inferred_theme),
  list_formats: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_formats),
  list_themes: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_themes),
  list_transform_styles: toolOutputSchema(DOCBLOCKS_MCP_TOOL_RESULT_SCHEMAS.list_transform_styles),
});

export const materializationOptionsSchema = z.discriminatedUnion('ifExists', [
  z
    .object({
      rootId: idSchema,
      path: workspacePathSchema,
      ifExists: z.literal('error'),
      expectedSha256: z.null().optional().default(null),
    })
    .strict(),
  z
    .object({
      rootId: idSchema,
      path: workspacePathSchema,
      ifExists: z.literal('replace'),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
]);

function addExactWireIssue<T>(parsed: T | null, context: z.RefinementCtx): void {
  if (parsed !== null) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Value does not satisfy the exact DocBlocks MCP wire invariants',
  });
}

/** Project the Zod 3 subset used by tool outputs into Zod 4 for SDK JSON Schema publication. */
function projectZod3Schema(schema: z.ZodTypeAny): z4.ZodType {
  if (schema instanceof z.ZodEffects) return projectZod3Schema(schema.innerType());
  if (schema instanceof z.ZodOptional) return projectZod3Schema(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return projectZod3Schema(schema.unwrap()).nullable();
  if (schema instanceof z.ZodString) {
    let projected = z4.string();
    for (const check of schema._def.checks) {
      switch (check.kind) {
        case 'min':
          projected = projected.min(check.value);
          break;
        case 'max':
          projected = projected.max(check.value);
          break;
        case 'length':
          projected = projected.length(check.value);
          break;
        case 'regex':
          projected = projected.regex(check.regex);
          break;
        default:
          throw new Error(`Unsupported Zod string check in MCP output schema: ${check.kind}`);
      }
    }
    return projected;
  }
  if (schema instanceof z.ZodNumber) {
    let projected = z4.number();
    for (const check of schema._def.checks) {
      switch (check.kind) {
        case 'min':
          projected = check.inclusive ? projected.min(check.value) : projected.gt(check.value);
          break;
        case 'max':
          projected = check.inclusive ? projected.max(check.value) : projected.lt(check.value);
          break;
        case 'int':
          projected = projected.int();
          break;
        case 'multipleOf':
          projected = projected.multipleOf(check.value);
          break;
        case 'finite':
          // Zod 4 numbers reject infinities by default.
          break;
      }
    }
    return projected;
  }
  if (schema instanceof z.ZodBoolean) return z4.boolean();
  if (schema instanceof z.ZodNull) return z4.null();
  if (schema instanceof z.ZodAny) return z4.any();
  if (schema instanceof z.ZodUnknown) return z4.unknown();
  if (schema instanceof z.ZodNever) return z4.never();
  if (schema instanceof z.ZodLiteral) {
    const value: unknown = schema.value;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      value === null
    ) {
      return z4.literal(value);
    }
    throw new Error('Unsupported Zod literal in MCP output schema');
  }
  if (schema instanceof z.ZodEnum) {
    const [first, ...rest] = schema.options;
    if (first === undefined) throw new Error('Empty Zod enum in MCP output schema');
    return z4.enum([first, ...rest]);
  }
  if (schema instanceof z.ZodArray) {
    let projected = z4.array(projectZod3Schema(schema.element));
    if (schema._def.minLength) projected = projected.min(schema._def.minLength.value);
    if (schema._def.maxLength) projected = projected.max(schema._def.maxLength.value);
    if (schema._def.exactLength) projected = projected.length(schema._def.exactLength.value);
    return projected;
  }
  if (schema instanceof z.ZodObject) {
    const sourceShape = schema.shape as z.ZodRawShape;
    const shape = Object.fromEntries(
      Object.entries(sourceShape).map(([key, value]) => [key, projectZod3Schema(value)]),
    );
    if (schema._def.unknownKeys === 'passthrough') return z4.looseObject(shape);
    return z4.object(shape);
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as readonly z.ZodTypeAny[];
    return projectUnion(options.map((option) => projectZod3Schema(option)));
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as readonly z.ZodTypeAny[];
    return projectUnion(options.map((option) => projectZod3Schema(option)));
  }
  throw new Error(`Unsupported Zod type in MCP output schema: ${schema._def.typeName}`);
}

function projectUnion(options: z4.ZodType[]): z4.ZodType {
  const [first, second, ...rest] = options;
  if (!first || !second) throw new Error('MCP output unions require at least two alternatives');
  return z4.union([first, second, ...rest]);
}

function jsonSchemaWithoutDialect(schema: z4.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = z4.toJSONSchema(schema, { target: 'draft-7' });
  return jsonSchema;
}
