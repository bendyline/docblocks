/**
 * DocBlocks MCP Server
 *
 * Exposes document conversion, analysis, and transformation tools
 * via the Model Context Protocol (MCP) over stdio.
 *
 * Designed for AI agents: tools accept raw markdown text so agents
 * can write content and immediately export it without temp files.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile, rm, rename, stat, mkdtemp } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { MarkdownDocument, MarkdownImage } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { getPackageVersion } from '../version.js';
import { McpFileAuthority, type McpFileAuthorityOptions } from './authority.js';

const MAX_MARKDOWN_CHARACTERS = 20 * 1024 * 1024;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_ID_CHARACTERS = 256;
const MAX_TOPIC_CHARACTERS = 10_000;
const MAX_EXPORT_BYTES = 500 * 1024 * 1024;
const MAX_REVERSE_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_OPERATIONS = 2;

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const FILE_WRITING_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const pathSchema = z.string().min(1).max(MAX_PATH_CHARACTERS);
const legacyMarkdownSchema = z
  .string()
  .max(MAX_MARKDOWN_CHARACTERS)
  .optional()
  .describe(
    'Deprecated raw markdown text. Use only when source is omitted; a value is never inferred as a file path.',
  );
const markdownSourceSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string().max(MAX_MARKDOWN_CHARACTERS) }).strict(),
    z.object({ kind: z.literal('file'), path: pathSchema }).strict(),
  ])
  .describe(
    'Canonical markdown input. Provide exactly one of source or the deprecated markdown field.',
  );

type MarkdownSource = z.infer<typeof markdownSourceSchema>;

export interface McpServerOptions extends McpFileAuthorityOptions {
  maxConcurrentOperations?: number;
}

class OperationGuard {
  private active = 0;

  public constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error('Invalid MCP operation concurrency limit');
    }
  }

  public async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) throw new Error('MCP server is busy; retry later');
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }
}

/**
 * Resolve markdown input: either raw text or a file path.
 * Returns the resolved file path (writing to a temp file if given raw text).
 */
async function resolveMarkdownInput(
  authority: McpFileAuthority,
  source: MarkdownSource | undefined,
  legacyMarkdown: string | undefined,
): Promise<{ filePath: string; isTemp: boolean }> {
  const selected = selectMarkdownSource(source, legacyMarkdown);
  if (selected.kind === 'file') {
    return { filePath: await authority.authorizeRead(selected.path), isTemp: false };
  }

  // Write raw markdown to a temp file
  const tmpId = randomBytes(8).toString('hex');
  const tmpPath = join(tmpdir(), `docblocks-mcp-${tmpId}.md`);
  await writeFile(tmpPath, selected.text, 'utf-8');
  return { filePath: tmpPath, isTemp: true };
}

/**
 * Clean up a temp file if needed.
 */
async function cleanupTemp(filePath: string, isTemp: boolean): Promise<void> {
  if (isTemp) {
    await rm(filePath, { force: true });
  }
}

/**
 * Resolve markdown input to text content. Used by tools that operate
 * on the markdown string directly (analyze, restyle) rather than via file.
 */
async function resolveMarkdownText(markdown: string): Promise<string> {
  return markdown;
}

async function resolveMarkdownSourceText(
  authority: McpFileAuthority,
  source: MarkdownSource | undefined,
  legacyMarkdown: string | undefined,
): Promise<string> {
  const selected = selectMarkdownSource(source, legacyMarkdown);
  if (selected.kind === 'text') return resolveMarkdownText(selected.text);
  return authority.readText(selected.path);
}

function selectMarkdownSource(
  source: MarkdownSource | undefined,
  legacyMarkdown: string | undefined,
): MarkdownSource {
  if (source && legacyMarkdown !== undefined) {
    throw new Error('Provide either source or markdown, not both');
  }
  if (source) return source;
  if (legacyMarkdown !== undefined) return { kind: 'text', text: legacyMarkdown };
  throw new Error('A markdown source is required');
}

function validateOutputExtension(outputPath: string, format: string): void {
  if (extname(outputPath).toLowerCase() !== `.${format.toLowerCase()}`) {
    throw new Error(`MCP ${format} output path must end with .${format}`);
  }
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function inlineContainerImages(container: ContentContainer): Promise<MarkdownDocument> {
  const markdown = await container.readDocument();
  if (markdown === null) throw new Error('Imported document did not contain Markdown');

  const { parseMarkdown, walkMarkdownTree } = await import('@bendyline/squisq/markdown');
  const markdownDoc = parseMarkdown(markdown);
  const images: MarkdownImage[] = [];
  walkMarkdownTree(markdownDoc, (node) => {
    if (node.type === 'image') images.push(node);
  });

  const entries = new Map((await container.listFiles()).map((entry) => [entry.path, entry]));
  const maximumEmbeddedBytes = Math.floor((MAX_MARKDOWN_CHARACTERS * 3) / 4);
  let embeddedBytes = 0;
  for (const image of images) {
    const entry = entries.get(image.url);
    if (!entry || !entry.mimeType.startsWith('image/')) continue;
    const bytes = await container.readFile(entry.path);
    if (!bytes) continue;
    embeddedBytes += bytes.byteLength;
    if (embeddedBytes > maximumEmbeddedBytes) {
      throw new Error('Converted markdown exceeds the configured output limit');
    }
    image.url = `data:${entry.mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  return markdownDoc;
}

async function importDocxAsMarkdown(input: ArrayBuffer): Promise<MarkdownDocument> {
  const { docxToContainer } = await import('@bendyline/squisq-formats/docx');
  return inlineContainerImages(
    await docxToContainer(input, {
      maxEntryUncompressedBytes: MAX_REVERSE_ARCHIVE_BYTES,
      maxUncompressedBytes: MAX_REVERSE_ARCHIVE_BYTES,
    }),
  );
}

async function importPptxAsMarkdown(input: ArrayBuffer): Promise<MarkdownDocument> {
  const { pptxToContainer } = await import('@bendyline/squisq-formats/pptx');
  return inlineContainerImages(
    await pptxToContainer(input, {
      maxEntryUncompressedBytes: MAX_REVERSE_ARCHIVE_BYTES,
      maxUncompressedBytes: MAX_REVERSE_ARCHIVE_BYTES,
    }),
  );
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const authority = McpFileAuthority.create(options);
  const operations = new OperationGuard(
    options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS,
  );
  const server = new McpServer({
    name: 'docblocks',
    version: getPackageVersion(),
  });

  // ── Export Tools ─────────────────────────────────────────────────

  const EXPORT_FORMATS: { format: string; description: string }[] = [
    {
      format: 'docx',
      description:
        'Export markdown to a polished Microsoft Word (.docx) file. File sources require a configured read root.',
    },
    {
      format: 'pdf',
      description:
        'Export markdown to a styled PDF file. File sources require a configured read root.',
    },
    {
      format: 'pptx',
      description:
        'Export markdown to a PowerPoint presentation. File sources require a configured read root.',
    },
    {
      format: 'html',
      description:
        'Export markdown to a self-contained interactive HTML page. File sources require a configured read root; package relative media in a .dbk/.zip container.',
    },
  ];

  for (const { format, description } of EXPORT_FORMATS) {
    server.registerTool(
      `export_markdown_to_${format}`,
      {
        description,
        inputSchema: z
          .object({
            source: markdownSourceSchema.optional(),
            markdown: legacyMarkdownSchema,
            outputPath: pathSchema.describe(`Output .${format} file path`),
            theme: z
              .string()
              .max(MAX_ID_CHARACTERS)
              .optional()
              .describe('Visual theme ID (use list_themes to see options)'),
            transform: z
              .string()
              .max(MAX_ID_CHARACTERS)
              .optional()
              .describe(
                'Transform style to apply before export (use list_transform_styles to see options)',
              ),
          })
          .strict(),
        outputSchema: z
          .object({
            outputPath: z.string(),
            fileSize: z.number().nonnegative(),
            format: z.string(),
          })
          .strict(),
        annotations: FILE_WRITING_TOOL_ANNOTATIONS,
      },
      async ({ source, markdown, outputPath, theme, transform }) =>
        operations.run(async () => {
          validateOutputExtension(outputPath, format);
          const fileAuthority = await authority;
          const { filePath, isTemp } = await resolveMarkdownInput(fileAuthority, source, markdown);
          try {
            const { runConvert } = await import('../commands/convert.js');
            const resolvedOutput = await fileAuthority.authorizeWrite(outputPath);
            const stagingDirectory = await mkdtemp(
              join(dirname(resolvedOutput), '.docblocks-mcp-export-'),
            );
            try {
              const result = await runConvert(filePath, {
                outputDir: stagingDirectory,
                formats: format,
                theme,
                transform,
              });
              const file = result.outputFiles[0];
              if (file.size > MAX_EXPORT_BYTES) {
                throw new Error('MCP export exceeds the configured output limit');
              }
              await rename(file.path, resolvedOutput);
              file.path = resolvedOutput;
              const payload = {
                outputPath: file.path,
                fileSize: file.size,
                format,
              };
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(payload),
                  },
                ],
                structuredContent: payload,
              };
            } finally {
              await rm(stagingDirectory, { recursive: true, force: true });
            }
          } finally {
            await cleanupTemp(filePath, isTemp);
          }
        }),
    );
  }

  server.registerTool(
    'export_markdown_to_video',
    {
      description:
        'Render markdown as an MP4 video with narration-synced animations. File sources require a configured read root.',
      inputSchema: z
        .object({
          source: markdownSourceSchema.optional(),
          markdown: legacyMarkdownSchema,
          outputPath: pathSchema.describe('Output .mp4 file path'),
          fps: z
            .number()
            .int()
            .min(1)
            .max(120)
            .optional()
            .describe('Frames per second (default: 30)'),
          quality: z
            .enum(['draft', 'normal', 'high'])
            .optional()
            .describe('Encoding quality (default: normal)'),
          orientation: z
            .enum(['landscape', 'portrait'])
            .optional()
            .describe('Video orientation (default: landscape)'),
          captions: z
            .enum(['off', 'standard', 'social'])
            .optional()
            .describe('Caption style (default: off)'),
          width: z.number().int().min(16).max(7680).optional().describe('Override video width'),
          height: z.number().int().min(16).max(4320).optional().describe('Override video height'),
        })
        .strict(),
      outputSchema: z
        .object({
          outputPath: z.string(),
          duration: z.number().nonnegative(),
          frameCount: z.number().int().nonnegative(),
        })
        .strict(),
      annotations: FILE_WRITING_TOOL_ANNOTATIONS,
    },
    async ({ source, markdown, outputPath, fps, quality, orientation, captions, width, height }) =>
      operations.run(async () => {
        validateOutputExtension(outputPath, 'mp4');
        const fileAuthority = await authority;
        const { filePath, isTemp } = await resolveMarkdownInput(fileAuthority, source, markdown);
        try {
          const { runVideo } = await import('../commands/video.js');
          const authorizedOutput = await fileAuthority.authorizeWrite(outputPath);
          const result = await runVideo(filePath, {
            output: authorizedOutput,
            fps,
            quality,
            orientation,
            captions,
            width,
            height,
          });
          const outputInfo = await stat(result.outputPath);
          if (!outputInfo.isFile() || outputInfo.size > MAX_EXPORT_BYTES) {
            await rm(result.outputPath, { force: true });
            throw new Error('MCP video export exceeds the configured output limit');
          }
          const payload = {
            outputPath: result.outputPath,
            duration: result.duration,
            frameCount: result.frameCount,
          };
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(payload),
              },
            ],
            structuredContent: payload,
          };
        } finally {
          await cleanupTemp(filePath, isTemp);
        }
      }),
  );

  // ── Reverse Conversion Tools ─────────────────────────────────────

  const REVERSE_FORMATS: {
    ext: 'docx' | 'pptx' | 'pdf';
    description: string;
    loader: () => Promise<(input: ArrayBuffer) => Promise<MarkdownDocument>>;
  }[] = [
    {
      ext: 'docx',
      description:
        'Convert a Microsoft Word (.docx) file to Markdown. Preserves headings, paragraphs, emphasis, lists, tables, and embedded images on a best-effort basis.',
      loader: async () => importDocxAsMarkdown,
    },
    {
      ext: 'pptx',
      description:
        'Convert a PowerPoint (.pptx) file to Markdown. Preserves ordered slide titles, body content, tables, embedded images, and inferred presentation metadata on a best-effort basis.',
      loader: async () => importPptxAsMarkdown,
    },
    {
      ext: 'pdf',
      description:
        'Convert a PDF file to Markdown. Heuristically recovers headings, lists, tables, code, blockquotes, and links on a best-effort basis.',
      loader: async () => (await import('@bendyline/squisq-formats/pdf')).pdfToMarkdownDoc,
    },
  ];

  for (const { ext, description, loader } of REVERSE_FORMATS) {
    server.registerTool(
      `convert_${ext}_to_markdown`,
      {
        description,
        inputSchema: z
          .object({
            inputPath: pathSchema.describe(`Path to the source .${ext} file`),
            outputPath: pathSchema
              .optional()
              .describe('If provided, write the resulting markdown to this file path'),
          })
          .strict(),
        annotations: FILE_WRITING_TOOL_ANNOTATIONS,
      },
      async ({ inputPath, outputPath }) =>
        operations.run(async () => {
          const fileAuthority = await authority;
          const convert = await loader();
          const { stringifyMarkdown } = await import('@bendyline/squisq/markdown');
          const input = ownedArrayBuffer(await fileAuthority.readFile(inputPath));
          const markdown = stringifyMarkdown(await convert(input));
          if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
            throw new Error('Converted markdown exceeds the configured output limit');
          }
          if (outputPath) {
            await fileAuthority.writeText(outputPath, markdown, MAX_MARKDOWN_CHARACTERS);
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: markdown,
              },
            ],
          };
        }),
    );
  }

  // ── Markdown Intelligence Tools ──────────────────────────────────

  server.registerTool(
    'analyze_markdown',
    {
      description:
        "Analyze a markdown document's structure. File sources require a configured read root.",
      inputSchema: z
        .object({
          source: markdownSourceSchema.optional(),
          markdown: legacyMarkdownSchema,
        })
        .strict(),
      outputSchema: z
        .object({
          stats: z
            .object({
              blockCount: z.number().int().nonnegative(),
              headingCount: z.number().int().nonnegative(),
              paragraphCount: z.number().int().nonnegative(),
              wordCount: z.number().int().nonnegative(),
              characterCount: z.number().int().nonnegative(),
            })
            .strict(),
          extracted: z.record(z.unknown()),
        })
        .strict(),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ source, markdown }) =>
      operations.run(async () => {
        const content = await resolveMarkdownSourceText(await authority, source, markdown);

        const { parseMarkdown } = await import('@bendyline/squisq/markdown');
        const { extractContent, stripMarkdown } = await import('@bendyline/squisq/generate');
        const { countBlocks, markdownToDoc } = await import('@bendyline/squisq/doc');

        const markdownDoc = parseMarkdown(content);
        const doc = markdownToDoc(markdownDoc);

        // Extract content elements
        const plainContent = stripMarkdown(content);
        const extracted = extractContent(plainContent);

        // Compute structure stats
        const stats = {
          blockCount: countBlocks(doc.blocks),
          headingCount: 0,
          paragraphCount: 0,
          wordCount: plainContent.split(/\s+/).filter(Boolean).length,
          characterCount: content.length,
        };

        if (markdownDoc.children) {
          for (const node of markdownDoc.children) {
            if (node.type === 'heading') stats.headingCount++;
            if (node.type === 'paragraph') stats.paragraphCount++;
          }
        }

        const payload = { stats, extracted };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        };
      }),
  );

  server.registerTool(
    'restyle_markdown',
    {
      description:
        'Restyle markdown with a presentation transform. File sources require a configured read root.',
      inputSchema: z
        .object({
          source: markdownSourceSchema.optional(),
          markdown: legacyMarkdownSchema,
          style: z
            .string()
            .max(MAX_ID_CHARACTERS)
            .describe('Transform style ID (use list_transform_styles to see options)'),
          theme: z
            .string()
            .max(MAX_ID_CHARACTERS)
            .optional()
            .describe('Visual theme ID to apply (use list_themes to see options)'),
          outputPath: pathSchema
            .optional()
            .describe('If provided, write the transformed markdown to this file path'),
        })
        .strict(),
      annotations: FILE_WRITING_TOOL_ANNOTATIONS,
    },
    async ({ source, markdown, style, theme, outputPath }) =>
      operations.run(async () => {
        const fileAuthority = await authority;
        const content = await resolveMarkdownSourceText(fileAuthority, source, markdown);

        const { getTransformStyleIds } = await import('@bendyline/squisq/transform');
        const validStyles = getTransformStyleIds();
        if (!validStyles.includes(style)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown transform style "${style}". Available: ${validStyles.join(', ')}`,
              },
            ],
            isError: true,
          };
        }

        const { parseMarkdown, stringifyMarkdown } = await import('@bendyline/squisq/markdown');
        const markdownDoc = parseMarkdown(content);
        if (theme) {
          const { getAvailableThemes } = await import('@bendyline/squisq/schemas');
          const { readCustomThemesFromFrontmatter } = await import('@bendyline/squisq/doc');
          const customThemes = readCustomThemesFromFrontmatter(markdownDoc.frontmatter) ?? [];
          const validThemes = [
            ...getAvailableThemes(),
            ...customThemes.map((customTheme) => customTheme.id),
          ];
          if (!validThemes.includes(theme)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Unknown theme "${theme}". Available: ${validThemes.join(', ')}`,
                },
              ],
              isError: true,
            };
          }
        }

        const { MemoryContentContainer } = await import('@bendyline/squisq/storage');
        const { applyTransformToMarkdown } = await import('../commands/convert.js');

        const container = new MemoryContentContainer();
        const transformedMarkdownDoc = await applyTransformToMarkdown(
          markdownDoc,
          container,
          style,
          theme,
        );
        const transformedText = stringifyMarkdown(transformedMarkdownDoc);
        if (transformedText.length > MAX_MARKDOWN_CHARACTERS) {
          throw new Error('Transformed markdown exceeds the configured output limit');
        }

        if (outputPath) {
          await fileAuthority.writeText(outputPath, transformedText, MAX_MARKDOWN_CHARACTERS);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: transformedText,
            },
          ],
        };
      }),
  );

  // ── Discovery Tools ──────────────────────────────────────────────

  server.registerTool(
    'list_themes',
    {
      description:
        'List all available visual themes (e.g., documentary, cinematic, bold) with descriptions. Use to choose a theme before exporting.',
      inputSchema: z.object({}).strict(),
      outputSchema: z
        .object({
          themes: z.array(
            z.object({ id: z.string(), name: z.string(), description: z.string() }).strict(),
          ),
        })
        .strict(),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const { getThemeSummaries } = await import('@bendyline/squisq/schemas');
      const themes = getThemeSummaries();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(themes, null, 2),
          },
        ],
        structuredContent: { themes },
      };
    },
  );

  server.registerTool(
    'list_transform_styles',
    {
      description:
        'List all available transform styles (e.g., documentary, magazine, minimal) with descriptions. Use before calling restyle_markdown to see what styles are available.',
      inputSchema: z.object({}).strict(),
      outputSchema: z
        .object({
          styles: z.array(
            z.object({ id: z.string(), name: z.string(), description: z.string() }).strict(),
          ),
        })
        .strict(),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const { getTransformStyleSummaries } = await import('@bendyline/squisq/transform');
      const styles = getTransformStyleSummaries();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(styles, null, 2),
          },
        ],
        structuredContent: { styles },
      };
    },
  );

  server.registerTool(
    'list_export_formats',
    {
      description:
        'List all supported export formats with descriptions of what each produces. Use to help choose the right output format.',
      inputSchema: z.object({}).strict(),
      outputSchema: z
        .object({
          input: z.array(
            z
              .object({
                ext: z.string(),
                description: z.string(),
                tool: z.string().optional(),
              })
              .strict(),
          ),
          output: z.array(
            z
              .object({
                format: z.string(),
                description: z.string(),
                tool: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const formats = {
        input: [
          { ext: '.md', description: 'Markdown file' },
          { ext: '.zip/.dbk', description: 'Container archive with embedded media' },
          {
            ext: '.docx',
            description: 'Microsoft Word document — via convert_docx_to_markdown',
            tool: 'convert_docx_to_markdown',
          },
          {
            ext: '.pptx',
            description: 'PowerPoint presentation — via convert_pptx_to_markdown',
            tool: 'convert_pptx_to_markdown',
          },
          {
            ext: '.pdf',
            description: 'PDF document — via convert_pdf_to_markdown',
            tool: 'convert_pdf_to_markdown',
          },
        ],
        output: [
          {
            format: 'docx',
            description: 'Microsoft Word document with professional formatting',
            tool: 'export_markdown_to_docx',
          },
          {
            format: 'pdf',
            description: 'Styled PDF document',
            tool: 'export_markdown_to_pdf',
          },
          {
            format: 'pptx',
            description: 'PowerPoint presentation — each section becomes a slide',
            tool: 'export_markdown_to_pptx',
          },
          {
            format: 'html',
            description: 'Self-contained interactive HTML page with embedded player',
            tool: 'export_markdown_to_html',
          },
          {
            format: 'mp4',
            description: 'Video with narration-synced animations (requires ffmpeg)',
            tool: 'export_markdown_to_video',
          },
        ],
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formats, null, 2),
          },
        ],
        structuredContent: formats,
      };
    },
  );

  // ── Resources ────────────────────────────────────────────────────

  server.registerResource(
    'formats',
    'docblocks://formats',
    {
      description: 'Input and output formats exposed by the DocBlocks MCP server',
      mimeType: 'application/json',
    },
    async () => {
      return {
        contents: [
          {
            uri: 'docblocks://formats',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                description:
                  'DocBlocks supports converting markdown documents to multiple professional output formats',
                inputFormats: ['.md', '.zip', '.dbk', '.docx', '.pptx', '.pdf'],
                outputFormats: ['docx', 'pptx', 'pdf', 'html', 'mp4', 'markdown'],
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── Prompts ──────────────────────────────────────────────────────

  const createPresentationPromptArgs = z
    .object({
      topic: z
        .string()
        .max(MAX_TOPIC_CHARACTERS)
        .describe('The topic or subject for the presentation'),
      style: z
        .string()
        .max(MAX_ID_CHARACTERS)
        .optional()
        .describe(
          'Transform style (documentary, magazine, data-driven, narrative, minimal). If omitted, you will be guided to choose.',
        ),
    })
    .strict();
  const createPresentationPrompt = server.registerPrompt(
    'create-presentation',
    {
      description:
        'Create a presentation-ready document from markdown. Guides you through writing content, choosing a theme, applying a transform style, and exporting to PPTX or PDF.',
      argsSchema: createPresentationPromptArgs.shape,
    },
    async ({ topic, style }) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Create a presentation about: ${topic}

Instructions for the AI agent:

1. First, call list_themes and list_transform_styles to see available options.
2. Write well-structured markdown content about the topic. Structure it with clear sections using ## headings — each heading becomes a slide.
3. Call restyle_markdown with style="${style ?? 'documentary'}" to transform the content for presentation.
4. Review the restyled markdown and make any adjustments.
5. Call export_markdown_to_pptx to generate the PowerPoint file.

Tips for great presentations:
- Use ## for slide breaks
- Keep each section focused on one idea
- Include statistics and quotes when relevant — they become visual highlights
- Use bullet lists for key points
- Add image references with ![alt](path) for visual slides; package local media in a .dbk/.zip file source`,
            },
          },
        ],
      };
    },
  );
  // SDK 1.x accepts only a raw prompt shape and otherwise wraps it in a
  // stripping object schema. Keep the registered schema exact at the wire
  // boundary so unknown prompt arguments are rejected rather than discarded.
  createPresentationPrompt.argsSchema = createPresentationPromptArgs;

  const createVideoPromptArgs = z
    .object({
      topic: z.string().max(MAX_TOPIC_CHARACTERS).describe('The topic or subject for the video'),
      orientation: z
        .enum(['landscape', 'portrait'])
        .optional()
        .describe('Video orientation (default: landscape)'),
    })
    .strict();
  const createVideoPrompt = server.registerPrompt(
    'create-video',
    {
      description:
        'Create a video from markdown content. Guides you through writing content optimized for video, choosing a theme, and rendering to MP4.',
      argsSchema: createVideoPromptArgs.shape,
    },
    async ({ topic, orientation }) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Create a video about: ${topic}

Instructions for the AI agent:

1. First, call list_themes to see available visual themes.
2. Write markdown content optimized for video presentation. The document will be rendered as an animated sequence.
3. Call analyze_markdown to understand the content structure and choose the best theme.
4. Call export_markdown_to_video with orientation="${orientation ?? 'landscape'}" to render the video.

Tips for great video content:
- Use clear ## section headings — they create visual transitions
- Include statistics (numbers with context) — they animate dramatically
- Add quotes with attribution — they get cinematic treatment
- Keep paragraphs concise — each maps to a timed visual block
- The video player auto-times content, so focus on clarity over length`,
            },
          },
        ],
      };
    },
  );
  createVideoPrompt.argsSchema = createVideoPromptArgs;

  const createDocumentPromptArgs = z
    .object({
      topic: z.string().max(MAX_TOPIC_CHARACTERS).describe('The topic or subject for the document'),
      format: z.enum(['docx', 'pdf']).optional().describe('Output format (default: pdf)'),
    })
    .strict();
  const createDocumentPrompt = server.registerPrompt(
    'create-document',
    {
      description:
        'Create a professional document from markdown. Guides you through writing content, choosing a theme, and exporting to DOCX or PDF.',
      argsSchema: createDocumentPromptArgs.shape,
    },
    async ({ topic, format }) => {
      const outputFormat = format ?? 'pdf';
      const toolName =
        outputFormat === 'docx' ? 'export_markdown_to_docx' : 'export_markdown_to_pdf';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Create a professional document about: ${topic}

Instructions for the AI agent:

1. First, call list_themes to see available visual themes.
2. Write well-structured markdown content. Use standard markdown formatting:
   - # for the document title
   - ## for major sections
   - ### for subsections
   - **bold** and *italic* for emphasis
   - > for important quotes or callouts
   - Numbered and bullet lists for organized content
3. Optionally call restyle_markdown to apply a professional transform.
4. Call ${toolName} to generate the final document.

Tips for professional documents:
- Start with a clear title and introduction
- Use consistent heading hierarchy
- Include data and statistics where appropriate
- End with a conclusion or summary section`,
            },
          },
        ],
      };
    },
  );
  createDocumentPrompt.argsSchema = createDocumentPromptArgs;

  return server;
}
