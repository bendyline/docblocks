import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MAX_ID_CHARACTERS = 256;
const MAX_TOPIC_CHARACTERS = 10_000;

/** Artifact-first authoring prompts whose named calls are all current MCP tools. */
export function registerAuthoringPrompts(server: McpServer): void {
  const style = completable(
    z.string().max(MAX_ID_CHARACTERS).optional().describe('Preferred transform style id.'),
    async (prefix) => {
      const { getTransformStyleIds } = await import('@bendyline/squisq/transform');
      return complete(getTransformStyleIds(), prefix);
    },
  );
  const theme = completable(
    z.string().max(MAX_ID_CHARACTERS).optional().describe('Preferred Squisq theme id.'),
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
  return `Create a presentation about: ${topic}

1. For durable output, call list_roots before drafting. If no returned root is write-enabled, stop and explain that the MCP server must restart with --allow-write; do not use a shell or CLI converter.
2. Author plain Markdown. One level-one heading (\`#\`) creates each deliberate slide boundary; headings alone create the boundaries, so do not add \`---\` between them unless a visible horizontal rule is intended. Unstructured text is also accepted. Squisq annotations are optional layout hints.${templateHint} Call get_authoring_context only when exact annotation examples or theme details would help.
3. Pass the Markdown directly to convert_document with a pptx target${themeHint}${styleHint}. Use a bundle source only when assets must travel with the document. No validation, inspection, or preview is required.
4. Use inspect_document or preview_document only when the user explicitly asks for document analysis or visual evidence.
5. Call save_artifact only when a durable file is required.`;
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
