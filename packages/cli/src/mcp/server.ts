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
import { writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Resolve markdown input: either raw text or a file path.
 * Returns the resolved file path (writing to a temp file if given raw text).
 */
async function resolveMarkdownInput(
  markdown: string,
): Promise<{ filePath: string; isTemp: boolean }> {
  // If it looks like a file path (no newlines, ends with known ext or exists on disk)
  if (!markdown.includes('\n') && markdown.length < 500) {
    try {
      const resolved = resolve(markdown);
      const info = await stat(resolved);
      if (info.isFile() || info.isDirectory()) {
        return { filePath: resolved, isTemp: false };
      }
    } catch {
      // Not a valid path — treat as raw markdown
    }
  }

  // Write raw markdown to a temp file
  const tmpId = randomBytes(8).toString('hex');
  const tmpPath = join(tmpdir(), `docblocks-mcp-${tmpId}.md`);
  await writeFile(tmpPath, markdown, 'utf-8');
  return { filePath: tmpPath, isTemp: true };
}

/**
 * Clean up a temp file if needed.
 */
async function cleanupTemp(filePath: string, isTemp: boolean): Promise<void> {
  if (isTemp) {
    const { rm } = await import('node:fs/promises');
    await rm(filePath, { force: true });
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'docblocks',
    version: '0.1.0',
  });

  // ── Export Tools ─────────────────────────────────────────────────

  server.tool(
    'export_markdown_to_docx',
    'Export a markdown document to a polished Microsoft Word (.docx) file with professional formatting and themes. Accepts raw markdown text or a file path.',
    {
      markdown: z.string().describe('Raw markdown text or path to a .md/.zip/.dbk file or folder'),
      outputPath: z.string().describe('Output .docx file path'),
      theme: z.string().optional().describe('Visual theme ID (use list_themes to see options)'),
      transform: z
        .string()
        .optional()
        .describe(
          'Transform style to apply before export (use list_transform_styles to see options)',
        ),
    },
    async ({ markdown, outputPath, theme, transform }) => {
      const { filePath, isTemp } = await resolveMarkdownInput(markdown);
      try {
        const { runConvert } = await import('../commands/convert.js');
        const result = await runConvert(filePath, {
          outputDir: resolve(outputPath, '..'),
          formats: 'docx',
          theme,
          transform,
        });
        const file = result.outputFiles[0];
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                outputPath: file.path,
                fileSize: file.size,
                format: 'docx',
              }),
            },
          ],
        };
      } finally {
        await cleanupTemp(filePath, isTemp);
      }
    },
  );

  server.tool(
    'export_markdown_to_pdf',
    'Export a markdown document to a styled PDF file. Accepts raw markdown text or a file path.',
    {
      markdown: z.string().describe('Raw markdown text or path to a .md/.zip/.dbk file or folder'),
      outputPath: z.string().describe('Output .pdf file path'),
      theme: z.string().optional().describe('Visual theme ID (use list_themes to see options)'),
      transform: z
        .string()
        .optional()
        .describe(
          'Transform style to apply before export (use list_transform_styles to see options)',
        ),
    },
    async ({ markdown, outputPath, theme, transform }) => {
      const { filePath, isTemp } = await resolveMarkdownInput(markdown);
      try {
        const { runConvert } = await import('../commands/convert.js');
        const result = await runConvert(filePath, {
          outputDir: resolve(outputPath, '..'),
          formats: 'pdf',
          theme,
          transform,
        });
        const file = result.outputFiles[0];
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                outputPath: file.path,
                fileSize: file.size,
                format: 'pdf',
              }),
            },
          ],
        };
      } finally {
        await cleanupTemp(filePath, isTemp);
      }
    },
  );

  server.tool(
    'export_markdown_to_pptx',
    'Export a markdown document to a PowerPoint presentation — each section becomes a slide. Accepts raw markdown text or a file path.',
    {
      markdown: z.string().describe('Raw markdown text or path to a .md/.zip/.dbk file or folder'),
      outputPath: z.string().describe('Output .pptx file path'),
      theme: z.string().optional().describe('Visual theme ID (use list_themes to see options)'),
      transform: z
        .string()
        .optional()
        .describe(
          'Transform style to apply before export (use list_transform_styles to see options)',
        ),
    },
    async ({ markdown, outputPath, theme, transform }) => {
      const { filePath, isTemp } = await resolveMarkdownInput(markdown);
      try {
        const { runConvert } = await import('../commands/convert.js');
        const result = await runConvert(filePath, {
          outputDir: resolve(outputPath, '..'),
          formats: 'pptx',
          theme,
          transform,
        });
        const file = result.outputFiles[0];
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                outputPath: file.path,
                fileSize: file.size,
                format: 'pptx',
              }),
            },
          ],
        };
      } finally {
        await cleanupTemp(filePath, isTemp);
      }
    },
  );

  server.tool(
    'export_markdown_to_html',
    'Export a markdown document to a self-contained interactive HTML page with an embedded player. Accepts raw markdown text or a file path.',
    {
      markdown: z.string().describe('Raw markdown text or path to a .md/.zip/.dbk file or folder'),
      outputPath: z.string().describe('Output .html file path'),
      theme: z.string().optional().describe('Visual theme ID (use list_themes to see options)'),
      transform: z
        .string()
        .optional()
        .describe(
          'Transform style to apply before export (use list_transform_styles to see options)',
        ),
    },
    async ({ markdown, outputPath, theme, transform }) => {
      const { filePath, isTemp } = await resolveMarkdownInput(markdown);
      try {
        const { runConvert } = await import('../commands/convert.js');
        const result = await runConvert(filePath, {
          outputDir: resolve(outputPath, '..'),
          formats: 'html',
          theme,
          transform,
        });
        const file = result.outputFiles[0];
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                outputPath: file.path,
                fileSize: file.size,
                format: 'html',
              }),
            },
          ],
        };
      } finally {
        await cleanupTemp(filePath, isTemp);
      }
    },
  );

  server.tool(
    'export_markdown_to_video',
    'Render a markdown document as an MP4 video with narration-synced animations. Requires ffmpeg and Playwright. Accepts raw markdown text or a file path.',
    {
      markdown: z.string().describe('Raw markdown text or path to a .md/.zip/.dbk file or folder'),
      outputPath: z.string().describe('Output .mp4 file path'),
      fps: z.number().min(1).max(120).optional().describe('Frames per second (default: 30)'),
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
      width: z.number().optional().describe('Override video width in pixels'),
      height: z.number().optional().describe('Override video height in pixels'),
    },
    async ({ markdown, outputPath, fps, quality, orientation, captions, width, height }) => {
      const { filePath, isTemp } = await resolveMarkdownInput(markdown);
      try {
        const { runVideo } = await import('../commands/video.js');
        const result = await runVideo(filePath, {
          output: outputPath,
          fps,
          quality,
          orientation,
          captions: captions as 'off' | 'standard' | 'social',
          width,
          height,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                outputPath: result.outputPath,
                duration: result.duration,
                frameCount: result.frameCount,
              }),
            },
          ],
        };
      } finally {
        await cleanupTemp(filePath, isTemp);
      }
    },
  );

  // ── Markdown Intelligence Tools ──────────────────────────────────

  server.tool(
    'analyze_markdown',
    "Analyze a markdown document's structure, extracting key content elements: statistics, quotes, dates, facts, comparisons, and lists. Use this to understand what a document contains before choosing a theme or transform. Accepts raw markdown text or a file path.",
    {
      markdown: z.string().describe('Raw markdown text or path to a .md file'),
    },
    async ({ markdown }) => {
      // Read content — either from file or use directly
      let content = markdown;
      if (!markdown.includes('\n') && markdown.length < 500) {
        try {
          const resolved = resolve(markdown);
          const info = await stat(resolved);
          if (info.isFile()) {
            content = await readFile(resolved, 'utf-8');
          }
        } catch {
          // Use as-is
        }
      }

      const { parseMarkdown } = await import('@bendyline/squisq/markdown');
      const { extractContent } = await import('@bendyline/squisq/generate');
      const { markdownToDoc } = await import('@bendyline/squisq/doc');

      const markdownDoc = parseMarkdown(content);
      const doc = markdownToDoc(markdownDoc);

      // Extract content elements
      const extracted = extractContent(content);

      // Compute structure stats
      const stats = {
        blockCount: doc.blocks?.length ?? 0,
        headingCount: 0,
        paragraphCount: 0,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        characterCount: content.length,
      };

      if (markdownDoc.children) {
        for (const node of markdownDoc.children) {
          if (node.type === 'heading') stats.headingCount++;
          if (node.type === 'paragraph') stats.paragraphCount++;
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ stats, extracted }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    'restyle_markdown',
    'Restyle a markdown document by applying a visual transform — restructures content for a specific presentation style (documentary, magazine, data-driven, narrative, minimal). Returns the transformed markdown text. Use list_transform_styles to see available styles. Accepts raw markdown text or a file path.',
    {
      markdown: z.string().describe('Raw markdown text or path to a .md file'),
      style: z.string().describe('Transform style ID (use list_transform_styles to see options)'),
      theme: z
        .string()
        .optional()
        .describe('Visual theme ID to apply (use list_themes to see options)'),
      outputPath: z
        .string()
        .optional()
        .describe('If provided, write the transformed markdown to this file path'),
    },
    async ({ markdown, style, theme, outputPath }) => {
      // Read content
      let content = markdown;
      if (!markdown.includes('\n') && markdown.length < 500) {
        try {
          const resolved = resolve(markdown);
          const info = await stat(resolved);
          if (info.isFile()) {
            content = await readFile(resolved, 'utf-8');
          }
        } catch {
          // Use as-is
        }
      }

      const { parseMarkdown, stringifyMarkdown } = await import('@bendyline/squisq/markdown');
      const { markdownToDoc, docToMarkdown } = await import('@bendyline/squisq/doc');
      const { applyTransform, extractDocImages, getTransformStyleIds } =
        await import('@bendyline/squisq/transform');

      // Validate style
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

      const markdownDoc = parseMarkdown(content);
      const doc = markdownToDoc(markdownDoc);
      const images = extractDocImages(doc.blocks);
      const result = applyTransform(doc, style, { themeId: theme, images });
      const transformedMarkdownDoc = docToMarkdown(result.doc);
      const transformedText = stringifyMarkdown(transformedMarkdownDoc);

      if (outputPath) {
        await writeFile(resolve(outputPath), transformedText, 'utf-8');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: transformedText,
          },
        ],
      };
    },
  );

  // ── Discovery Tools ──────────────────────────────────────────────

  server.tool(
    'list_themes',
    'List all available visual themes (e.g., documentary, cinematic, bold) with descriptions. Use to choose a theme before exporting.',
    {},
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
      };
    },
  );

  server.tool(
    'list_transform_styles',
    'List all available transform styles (e.g., documentary, magazine, minimal) with descriptions. Use before calling restyle_markdown to see what styles are available.',
    {},
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
      };
    },
  );

  server.tool(
    'list_export_formats',
    'List all supported export formats with descriptions of what each produces. Use to help choose the right output format.',
    {},
    async () => {
      const formats = {
        input: [
          { ext: '.md', description: 'Markdown file' },
          { ext: '.zip/.dbk', description: 'Container archive with embedded media' },
          { ext: 'folder', description: 'Directory with markdown and media files' },
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
      };
    },
  );

  // ── Resources ────────────────────────────────────────────────────

  server.resource('formats', 'docblocks://formats', async () => {
    return {
      contents: [
        {
          uri: 'docblocks://formats',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              description:
                'DocBlocks supports converting markdown documents to multiple professional output formats',
              inputFormats: ['.md', '.zip', '.dbk', 'folder'],
              outputFormats: ['docx', 'pptx', 'pdf', 'html', 'mp4', 'dbk'],
            },
            null,
            2,
          ),
        },
      ],
    };
  });

  // ── Prompts ──────────────────────────────────────────────────────

  server.prompt(
    'create-presentation',
    'Create a presentation-ready document from markdown. Guides you through writing content, choosing a theme, applying a transform style, and exporting to PPTX or PDF.',
    {
      topic: z.string().describe('The topic or subject for the presentation'),
      style: z
        .string()
        .optional()
        .describe(
          'Transform style (documentary, magazine, data-driven, narrative, minimal). If omitted, you will be guided to choose.',
        ),
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
- Add image references with ![alt](path) for visual slides`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    'create-video',
    'Create a video from markdown content. Guides you through writing content optimized for video, choosing a theme, and rendering to MP4.',
    {
      topic: z.string().describe('The topic or subject for the video'),
      orientation: z
        .enum(['landscape', 'portrait'])
        .optional()
        .describe('Video orientation (default: landscape)'),
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

  server.prompt(
    'create-document',
    'Create a professional document from markdown. Guides you through writing content, choosing a theme, and exporting to DOCX or PDF.',
    {
      topic: z.string().describe('The topic or subject for the document'),
      format: z.enum(['docx', 'pdf']).optional().describe('Output format (default: pdf)'),
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

  return server;
}
