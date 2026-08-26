import type { WorkspacePath } from '../filesystem/workspace-path.js';

/** Version of the exact DocBlocks MCP wire envelopes in this module. */
export const DOCBLOCKS_MCP_WIRE_VERSION = 1 as const;

export type DocBlocksMcpWireVersion = typeof DOCBLOCKS_MCP_WIRE_VERSION;

/** Canonical artifact-first tools exposed by the local DocBlocks MCP server. */
export const DOCBLOCKS_MCP_TOOL_NAMES = [
  'list_roots',
  'get_conversion_report',
  'convert_document',
  'create_document_bundle',
  'save_artifact',
  'inspect_document',
  'preview_document',
  'compare_documents',
  'get_authoring_context',
  'list_templates',
  'describe_template',
  'recommend_templates',
  'describe_theme',
  'infer_theme_from_file',
  'inspect_pptx_layouts',
  'apply_inferred_theme',
  'list_formats',
  'list_themes',
  'list_transform_styles',
] as const;

export type DocBlocksMcpToolName = (typeof DOCBLOCKS_MCP_TOOL_NAMES)[number];

export type AppliedOptionValue = string | number | boolean | null;

export interface AppliedOption {
  readonly name: string;
  readonly value: AppliedOptionValue;
}

export interface EngineVersion {
  readonly name: string;
  readonly version: string;
}

/** Immutable, session-scoped output which can be read through an MCP resource. */
export interface ArtifactRef {
  readonly id: string;
  readonly uri: string;
  readonly format: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly sourceFormat: string | null;
  readonly sourceSha256: string | null;
  readonly suggestedFilename: string;
  readonly appliedOptions: readonly AppliedOption[];
  readonly engineVersions: readonly EngineVersion[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

/** Exactly one bounded, authority-scoped content source for a bundle asset. */
export type BundleAssetContentSource =
  | {
      readonly kind: 'file';
      readonly rootId: string;
      readonly path: WorkspacePath;
    }
  | {
      readonly kind: 'artifact';
      readonly uri: string;
    };

/** An asset retained beside Markdown at one canonical path in a document bundle. */
export interface BundleAssetRef {
  readonly path: WorkspacePath;
  readonly source: BundleAssetContentSource;
  readonly mimeType: string | null;
  readonly altText: string | null;
  readonly credit: string | null;
  readonly license: string | null;
}

/** Inline Markdown. Use artifact or file sources for large or binary documents. */
export interface MarkdownDocumentSource {
  readonly kind: 'markdown';
  readonly markdown: string;
  readonly name: string | null;
}

/**
 * A file selected from a server-configured, authority-scoped root.
 *
 * A null rootId means "the server's sole read-enabled root": callers on
 * a one-root server may omit it, and the authority resolves or rejects
 * with the candidate ids. It never grants new authority — resolution
 * still goes through the same root allow-list.
 */
export interface FileDocumentSource {
  readonly kind: 'file';
  readonly rootId: string | null;
  readonly path: WorkspacePath;
  readonly format: string | null;
}

/** A previously produced immutable artifact. */
export interface ArtifactDocumentSource {
  readonly kind: 'artifact';
  readonly uri: string;
}

/** Markdown plus artifact-backed media, preserving a complete document tree. */
export interface BundleDocumentSource {
  readonly kind: 'bundle';
  readonly markdown: string;
  readonly assets: readonly BundleAssetRef[];
  readonly name: string | null;
}

export type DocumentSource =
  | MarkdownDocumentSource
  | FileDocumentSource
  | ArtifactDocumentSource
  | BundleDocumentSource;

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticStage =
  | 'resolve'
  | 'import'
  | 'parse'
  | 'inspect'
  | 'transform'
  | 'convert'
  | 'render'
  | 'export'
  | 'materialize'
  | 'compare';

export type DiagnosticLocation =
  | {
      readonly kind: 'source';
      readonly line: number;
      readonly column: number;
    }
  | {
      readonly kind: 'block';
      readonly blockId: string;
      readonly nodeType: string;
    }
  | {
      readonly kind: 'asset';
      readonly path: WorkspacePath;
    }
  | {
      readonly kind: 'item';
      readonly itemKind: 'page' | 'slide' | 'sheet' | 'frame';
      readonly index: number;
    };

/** Stable, machine-actionable diagnostic shared by every MCP operation. */
export interface McpDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly stage: DiagnosticStage;
  readonly format: string | null;
  readonly count: number;
  readonly message: string;
  readonly remediation: string | null;
  readonly retryable: boolean;
  readonly location: DiagnosticLocation | null;
}

export interface McpErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly stage: DiagnosticStage | null;
  readonly format: string | null;
  readonly hint: string | null;
  readonly retryable: boolean;
  readonly operationLoad: {
    readonly active: number;
    readonly capacity: number;
  } | null;
}

/** Exact failure envelope returned as structured content by MCP tools. */
export interface McpErrorResult {
  readonly version: DocBlocksMcpWireVersion;
  readonly kind: 'error';
  readonly result: null;
  readonly error: McpErrorDetail;
}

/** Exact success envelope used by MCP tool structured content. */
export interface McpSuccessResult<T> {
  readonly version: DocBlocksMcpWireVersion;
  readonly kind: 'success';
  readonly result: T;
  readonly error: null;
}

export type ConversionFidelity = 'semantic' | 'editable-native' | 'rendered-fidelity' | 'hybrid';

export interface ConversionResult {
  readonly version: DocBlocksMcpWireVersion;
  readonly kind: 'conversion';
  readonly sourceFormat: string;
  readonly targetFormat: string;
  readonly artifact: ArtifactRef;
  readonly fidelity: ConversionFidelity;
  readonly appliedThemeId: string | null;
  readonly appliedTransformId: string | null;
  /** Source-side assets available to the conversion, including durable attribution metadata. */
  readonly sourceAssets: readonly AssetSummary[];
  readonly sourceAssetCount: number;
  readonly diagnostics: readonly McpDiagnostic[];
}

/** Successful payload returned by the canonical multi-target conversion tool. */
export interface ConvertDocumentResult {
  readonly results: readonly ConversionResult[];
}

export interface DocumentMetadataSummary {
  readonly title: string | null;
  readonly author: string | null;
  readonly description: string | null;
}

export interface DocumentStatistics {
  readonly blockCount: number;
  readonly wordCount: number;
  readonly characterCount: number;
  readonly tableCount: number;
  readonly linkCount: number;
  readonly assetCount: number;
  readonly pageCount: number | null;
  readonly slideCount: number | null;
  readonly sheetCount: number | null;
}

export interface OutlineEntry {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly blockIndex: number;
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface BlockSummary {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly wordCount: number;
  readonly templateId: string | null;
  readonly sourceRange: SourceRange | null;
}

export interface TableSummary {
  readonly index: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly headers: readonly string[];
}

export interface LinkSummary {
  readonly index: number;
  readonly text: string;
  readonly target: string;
}

export interface DocumentItemSummary {
  readonly kind: PreviewItemKind;
  readonly index: number;
  readonly label: string | null;
  readonly blockIds: readonly string[];
}

export interface AssetSummary {
  readonly path: WorkspacePath;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly altText: string | null;
  readonly credit: string | null;
  readonly license: string | null;
}

export interface ThemeSummary {
  readonly id: string;
  readonly name: string;
  readonly source: 'built-in' | 'document' | 'inferred';
  readonly layouts: readonly string[];
}

export interface InspectionResult {
  readonly version: DocBlocksMcpWireVersion;
  readonly kind: 'inspection';
  readonly sourceFormat: string;
  readonly metadata: DocumentMetadataSummary;
  readonly statistics: DocumentStatistics;
  readonly outline: readonly OutlineEntry[];
  readonly blocks: readonly BlockSummary[];
  readonly blockOffset: number;
  readonly nextCursor: string | null;
  readonly tables: readonly TableSummary[];
  readonly links: readonly LinkSummary[];
  readonly items: readonly DocumentItemSummary[];
  readonly assets: readonly AssetSummary[];
  readonly theme: ThemeSummary | null;
  readonly truncated: boolean;
  readonly detailsTruncated: boolean;
  readonly diagnostics: readonly McpDiagnostic[];
}

export type PreviewItemKind = 'page' | 'slide' | 'sheet' | 'frame';

export interface PreviewItem {
  readonly kind: PreviewItemKind;
  readonly index: number;
  readonly label: string | null;
  readonly artifact: ArtifactRef;
  readonly width: number;
  readonly height: number;
}

export interface PreviewResult {
  readonly version: DocBlocksMcpWireVersion;
  readonly kind: 'preview';
  readonly sourceFormat: string;
  readonly previewBasis: 'source-render' | 'reconstructed-import' | 'native-extracted';
  readonly totalItems: number;
  readonly items: readonly PreviewItem[];
  readonly truncated: boolean;
  readonly diagnostics: readonly McpDiagnostic[];
}

export type ComparisonCategory =
  | 'text'
  | 'structure'
  | 'table'
  | 'media'
  | 'theme'
  | 'layout'
  | 'metadata'
  | 'timing'
  | 'accessibility';

export type ComparisonStatus = 'retained' | 'changed' | 'degraded' | 'omitted' | 'added';

export interface ComparisonChange {
  readonly category: ComparisonCategory;
  readonly status: ComparisonStatus;
  readonly path: string | null;
  readonly message: string;
}

export interface ComparisonMetric {
  readonly name: string;
  readonly leftValue: number;
  readonly rightValue: number;
  readonly similarity: number;
}

export interface ComparisonResult {
  readonly version: DocBlocksMcpWireVersion;
  readonly kind: 'comparison';
  readonly leftFormat: string;
  readonly rightFormat: string;
  readonly equivalent: boolean;
  readonly score: number;
  readonly changes: readonly ComparisonChange[];
  readonly metrics: readonly ComparisonMetric[];
  readonly diagnostics: readonly McpDiagnostic[];
}

export interface RootGrantSummary {
  readonly id: string;
  readonly label: string;
  readonly read: boolean;
  readonly write: boolean;
}

export interface ListRootsResult {
  readonly roots: readonly RootGrantSummary[];
}

export interface SavedArtifactDestination {
  readonly rootId: string;
  readonly path: WorkspacePath;
}

export interface SaveArtifactResult {
  readonly artifact: ArtifactRef;
  readonly destination: SavedArtifactDestination;
  readonly sha256: string;
}

export type FormatDirectionCapability =
  | {
      readonly supported: true;
      readonly tool: 'inspect_document' | 'convert_document';
    }
  | {
      readonly supported: false;
      readonly excludedReason: string;
    };

export interface FormatCapabilitySummary {
  readonly id: string;
  readonly label: string;
  readonly mimeType: string;
  readonly extensions: readonly string[];
  readonly import: FormatDirectionCapability;
  readonly export: FormatDirectionCapability;
}

export interface ListFormatsResult {
  readonly formats: readonly FormatCapabilitySummary[];
}

export interface ThemeCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ListThemesResult {
  readonly themes: readonly ThemeCatalogEntry[];
}

export interface TransformStyleSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface ListTransformStylesResult {
  readonly styles: readonly TransformStyleSummary[];
}

export interface TemplateSummary {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface ListTemplatesResult {
  readonly templates: readonly TemplateSummary[];
}

export interface TemplateInputSummary {
  readonly key: string;
  readonly description: string;
  readonly type: string;
  readonly required: boolean;
  readonly values: readonly string[];
  readonly valueHint: string | null;
}

export interface DescribedTemplate extends TemplateSummary {
  readonly inputs: readonly TemplateInputSummary[];
}

export interface DescribeTemplateResult {
  readonly template: DescribedTemplate;
  readonly annotationExample: string;
}

export type AuthoringGoal = 'content-first' | 'visual-polish';

export type TemplateAuthoringRole =
  | 'opener'
  | 'divider'
  | 'content'
  | 'highlight'
  | 'quote'
  | 'comparison'
  | 'event'
  | 'media'
  | 'data'
  | 'spatial';

export type TemplateBodyPolicy = 'complete' | 'derived' | 'ignored' | 'structured';

export interface AuthoringTemplateSummary extends DescribedTemplate {
  readonly role: TemplateAuthoringRole;
  readonly bodyPolicy: TemplateBodyPolicy;
  readonly safeForContentFirst: boolean;
  readonly placement: 'heading';
  readonly annotationExample: string;
}

export interface AuthoringSyntaxSummary {
  readonly headingAnnotation: string;
  readonly standaloneAnnotation: string;
  readonly standaloneWarning: string;
}

/** One-call, linked-registry-backed context for agent authoring. */
export interface AuthoringContextResult {
  readonly goal: AuthoringGoal;
  readonly targetFormat: string | null;
  readonly defaultTemplateId: string;
  readonly defaultFidelity: ConversionFidelity | null;
  readonly workflow: readonly string[];
  readonly syntax: AuthoringSyntaxSummary;
  readonly formats: readonly FormatCapabilitySummary[];
  readonly templates: readonly AuthoringTemplateSummary[];
  readonly themes: readonly ThemeCatalogEntry[];
  readonly transformStyles: readonly TransformStyleSummary[];
  readonly recommendations: readonly TemplateRecommendation[];
  readonly totalBlocks: number | null;
  readonly truncated: boolean;
}

export interface TemplateContentProfile {
  readonly hasImage: boolean;
  readonly imageCount: number;
  readonly hasVideo: boolean;
  readonly hasBlockquote: boolean;
  readonly hasList: boolean;
  readonly hasTable: boolean;
  readonly hasDate: boolean;
  readonly hasNumberHighlight: boolean;
  readonly wordCount: number;
  readonly hasAsciiDiagram: boolean;
  readonly hasTimeline: boolean;
  readonly hasTree: boolean;
}

export interface TemplateRecommendation {
  readonly blockId: string;
  readonly title: string | null;
  readonly profile: TemplateContentProfile;
  readonly recommendedTemplateIds: readonly string[];
}

export interface RecommendTemplatesResult {
  readonly recommendations: readonly TemplateRecommendation[];
  readonly totalBlocks: number;
  readonly truncated: boolean;
}

export interface ThemeDescriptionColors {
  readonly primary: string;
  readonly secondary: string;
  readonly background: string;
  readonly text: string;
  readonly highlight: string;
}

export interface ThemeDescription {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly colors: ThemeDescriptionColors;
  readonly bodyFont: string;
  readonly titleFont: string;
}

export interface DescribeThemeResult {
  readonly theme: ThemeDescription;
  readonly source: 'built-in' | 'document';
}

export interface InferredLayoutSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface InferThemeResult {
  readonly sourceFormat: string;
  readonly sourceSha256: string;
  readonly theme: ThemeDescription;
  readonly layouts: readonly InferredLayoutSummary[];
  readonly warnings: readonly string[];
}

export interface PptxSlideSize {
  readonly cx: number;
  readonly cy: number;
}

export interface PptxLayoutSummary {
  readonly layoutPath: string;
  readonly name: string;
  readonly masterName: string | null;
  readonly type: string | null;
  readonly slideCount: number;
  readonly verdict: 'builtin' | 'custom' | 'plain' | 'skip';
  readonly templateId: string | null;
  readonly notes: readonly string[];
}

export interface InspectPptxLayoutsResult {
  readonly slideSize: PptxSlideSize;
  readonly layouts: readonly PptxLayoutSummary[];
}

export interface ApplyInferredThemeResult {
  readonly result: ConversionResult;
  readonly theme: ThemeDescription;
  readonly layoutIds: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Safe materialization never overwrites by default. Replacement is available
 * only as a process-serialized, hash-conditional update which revalidates the
 * observed target bytes immediately before atomic publication.
 */
export type MaterializationOptions =
  | {
      readonly rootId: string;
      readonly path: WorkspacePath;
      readonly ifExists: 'error';
      readonly expectedSha256: null;
    }
  | {
      readonly rootId: string;
      readonly path: WorkspacePath;
      readonly ifExists: 'replace';
      readonly expectedSha256: string;
    };
