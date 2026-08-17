import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_DASHBOARD_RESOLUTION_IDS, MCP_DASHBOARD_STYLE_IDS } from './conversion-service.js';
import {
  MOTION_SELECTION_GUIDANCE,
  STYLE_SELECTION_GUIDANCE,
  TRANSFORM_SELECTION_GUIDANCE,
} from './style-guidance.js';

const MAX_ID_CHARACTERS = 256;
const MAX_TOPIC_CHARACTERS = 10_000;

/** Artifact-first authoring prompts whose named calls are all current MCP tools. */
export function registerAuthoringPrompts(server: McpServer): void {
  const style = completable(
    z
      .string()
      .max(MAX_ID_CHARACTERS)
      .optional()
      .describe(
        'Optional exact Squisq Summarize/transform style id. Usually let the model infer this from the brief.',
      ),
    async (prefix) => {
      const { getTransformStyleIds } = await import('@bendyline/squisq/transform');
      return complete(getTransformStyleIds(), prefix);
    },
  );
  const theme = completable(
    z
      .string()
      .max(MAX_ID_CHARACTERS)
      .optional()
      .describe(
        'Optional exact Squisq theme id. Usually let the model infer this from the brief or the selected transform.',
      ),
    async (prefix) => {
      const { getAvailableThemes } = await import('@bendyline/squisq/schemas');
      return complete(getAvailableThemes(), prefix);
    },
  );
  const template = completable(
    z.string().max(MAX_ID_CHARACTERS).optional().describe('Preferred Squisq template id.'),
    async (prefix) => {
      const { getAvailableTemplates } = await import('@bendyline/squisq/doc');
      return complete(getAvailableTemplates(), prefix);
    },
  );

  const presentationArgs = z
    .object({
      topic: z.string().max(MAX_TOPIC_CHARACTERS).describe('Presentation topic or subject.'),
      style,
      theme,
      template,
    })
    .strict();
  const presentation = server.registerPrompt(
    'create-presentation',
    {
      description: 'Convert model-authored Markdown into an artifact-first presentation.',
      argsSchema: presentationArgs.shape,
    },
    async (args) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: presentationPrompt(args.topic, args.style, args.theme, args.template),
          },
        },
      ],
    }),
  );
  presentation.argsSchema = presentationArgs;

  const videoArgs = z
    .object({
      topic: z.string().max(MAX_TOPIC_CHARACTERS).describe('Video topic or subject.'),
      orientation: z.enum(['landscape', 'portrait']).optional(),
      theme,
      template,
    })
    .strict();
  const video = server.registerPrompt(
    'create-video',
    {
      description: 'Convert model-authored Markdown into an artifact-first MP4 video.',
      argsSchema: videoArgs.shape,
    },
    async (args) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: videoPrompt(args.topic, args.orientation, args.theme, args.template),
          },
        },
      ],
    }),
  );
  video.argsSchema = videoArgs;

  const dashboardArgs = z
    .object({
      topic: z.string().max(MAX_TOPIC_CHARACTERS).describe('Dashboard topic or subject.'),
      resolution: z
        .enum(MCP_DASHBOARD_RESOLUTION_IDS)
        .optional()
        .describe('Named output size for the image.'),
      style: z
        .enum(MCP_DASHBOARD_STYLE_IDS)
        .optional()
        .describe('Cell dressing around each block.'),
      theme,
      template,
    })
    .strict();
  const dashboard = server.registerPrompt(
    'create-dashboard',
    {
      description: 'Convert model-authored Markdown into an artifact-first dashboard image.',
      argsSchema: dashboardArgs.shape,
    },
    async (args) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: dashboardPrompt(
              args.topic,
              args.resolution,
              args.style,
              args.theme,
              args.template,
            ),
          },
        },
      ],
    }),
  );
  dashboard.argsSchema = dashboardArgs;

  const documentArgs = z
    .object({
      topic: z.string().max(MAX_TOPIC_CHARACTERS).describe('Document topic or subject.'),
      format: z.enum(['docx', 'pdf']).optional(),
      theme,
      template,
    })
    .strict();
  const document = server.registerPrompt(
    'create-document',
    {
      description: 'Convert model-authored Markdown into an artifact-first document.',
      argsSchema: documentArgs.shape,
    },
    async (args) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: documentPrompt(args.topic, args.format, args.theme, args.template),
          },
        },
      ],
    }),
  );
  document.argsSchema = documentArgs;
}

function presentationPrompt(
  topic: string,
  style: string | undefined,
  theme: string | undefined,
  template: string | undefined,
): string {
  const templateHint = template
    ? ` Use the requested \`${template}\` annotation where appropriate.`
    : '';
  const themeHint = theme ? ` with themeId \`${theme}\`` : '';
  const styleHint = style ? ` and transformId \`${style}\`` : '';
  const selectionHint =
    style || theme
      ? `Honor the caller-supplied ${style ? `transform style \`${style}\`` : ''}${
          style && theme ? ' and ' : ''
        }${theme ? `theme \`${theme}\`` : ''}; do not ask for another style choice.${
          style && !theme
            ? " Because no exact theme was requested, omit themeId so Squisq can apply the transform style's preferred compatible theme."
            : ''
        }`
      : `${STYLE_SELECTION_GUIDANCE} ${TRANSFORM_SELECTION_GUIDANCE}`;
  return `Create a presentation about: ${topic}

1. For durable output, call list_roots before drafting. If no returned root is write-enabled, stop and explain that the MCP server must restart with --allow-write; do not use a shell or CLI converter.
2. ${selectionHint} ${MOTION_SELECTION_GUIDANCE} Call get_authoring_context only when the linked theme and Summarize descriptions would materially improve the choice.
3. Author plain Markdown. One level-one heading (\`#\`) creates each deliberate slide boundary; headings alone create the boundaries, so do not add \`---\` between them unless a visible horizontal rule is intended. Unstructured text is also accepted. Squisq annotations are optional layout hints.${templateHint}
4. Pass the Markdown directly to convert_document with a pptx target${themeHint}${styleHint}. Use a bundle source only when assets must travel with the document. No validation, inspection, or preview is required.
5. Use inspect_document or preview_document only when the user explicitly asks for document analysis or visual evidence.
6. Call save_artifact only when a durable file is required.`;
}

function videoPrompt(
  topic: string,
  orientation: 'landscape' | 'portrait' | undefined,
  theme: string | undefined,
  template: string | undefined,
): string {
  const templateHint = template
    ? ` Use the requested \`${template}\` annotation where appropriate.`
    : '';
  const themeHint = theme ? ` and themeId \`${theme}\`` : '';
  return `Create a video about: ${topic}

1. For durable output, call list_roots before drafting and stop if no root is write-enabled; do not use a shell or CLI converter.
2. Author plain Markdown. Squisq annotations are optional layout hints.${templateHint} Call get_authoring_context only when exact annotation examples or theme details would help.
3. Pass the Markdown directly to convert_document with an mp4 target, orientation "${orientation ?? 'landscape'}"${themeHint}. Use a bundle source only when assets must travel with the document. No validation, inspection, or preview is required.
4. Use preview_document only when the user explicitly asks for visual evidence.
5. Call save_artifact only when a durable file is required.`;
}

function dashboardPrompt(
  topic: string,
  resolution: string | undefined,
  style: string | undefined,
  theme: string | undefined,
  template: string | undefined,
): string {
  const templateHint = template
    ? ` Use the requested \`${template}\` annotation where appropriate.`
    : '';
  const themeHint = theme ? ` and themeId \`${theme}\`` : '';
  const sizeHint = resolution ? `, resolution "${resolution}"` : '';
  const styleHint = style ? `, style "${style}"` : '';
  return `Create a dashboard image about: ${topic}

1. For durable output, call list_roots before drafting and stop if no root is write-enabled; do not use a shell or CLI converter.
2. A dashboard renders the WHOLE document onto one canvas, one block per cell, so write for a single screen. Aim for four to eight short, self-contained blocks — a lead statement, a table or metric, a short list, a closing note. Long prose does not fit a cell and will be clipped.${templateHint} Call get_authoring_context only when exact annotation examples or theme details would help.
3. Pass the Markdown directly to convert_document with a png target${sizeHint}${styleHint}${themeHint}. Omit layout to let the block count pick one. Use a bundle source only when assets must travel with the document. No validation, inspection, or preview is required.
4. Use preview_document only when the user explicitly asks for visual evidence.
5. Call save_artifact only when a durable file is required.`;
}

function documentPrompt(
  topic: string,
  format: 'docx' | 'pdf' | undefined,
  theme: string | undefined,
  template: string | undefined,
): string {
  const target = format ?? 'pdf';
  const templateHint = template
    ? ` Use the requested \`${template}\` annotation where appropriate.`
    : '';
  const themeHint = theme ? ` and themeId \`${theme}\`` : '';
  return `Create a document about: ${topic}

1. For durable output, call list_roots before drafting and stop if no root is write-enabled; do not use a shell or CLI converter.
2. Author plain Markdown. Squisq annotations are optional layout hints.${templateHint} Call get_authoring_context only when exact annotation examples or theme details would help.
3. Pass the Markdown directly to convert_document with a ${target} target${themeHint}. Use a bundle source only when assets must travel with the document. No validation, inspection, or preview is required.
4. Use inspect_document or preview_document only when the user explicitly asks for document analysis or visual evidence.
5. Call save_artifact only when a durable file is required.`;
}

function complete(values: readonly string[], prefix: string | undefined): string[] {
  const value = prefix ?? '';
  return values.filter((candidate) => candidate.startsWith(value)).slice(0, 100);
}
