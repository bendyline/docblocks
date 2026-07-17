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
      description: 'Create, validate, preview, and export an artifact-first presentation.',
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
      description: 'Create, validate, preview, and export an artifact-first MP4 video.',
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
      description: 'Create, validate, preview, and export an artifact-first document.',
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
  return `Create a presentation about: ${topic}

1. Call get_authoring_context with targetFormat "pptx" and goal "content-first" for the complete linked-Squisq vocabulary and workflow in one response.
2. Author complete Markdown sections with accessible alt text. Put annotations on headings, for example \`# Heading {[content]}\`; a standalone \`{[template]}\` creates an extra block. Prefer style "${style ?? 'choose from the returned transform styles'}", theme "${theme ?? 'choose from the returned themes'}", and template "${template ?? 'content until visual optimization'}".
3. Keep the draft inline or stage Markdown plus assets with create_document_bundle. Do not write a temporary local Markdown file or invent a root id.
4. Call validate_document with targetFormat "pptx" and repair actionable diagnostics before optimizing layouts.
5. Call preview_document and inspect every bounded slide image, especially overflow and body-retention diagnostics.
6. If a staged DBK needs targeted repairs, call inspect_document for block IDs and revise_document with the artifact's exact SHA-256 instead of resending the full Markdown. Only after content coverage is acceptable, replace selected \`content\` blocks with more visual recommended templates and preview again.
7. Call convert_document with a pptx target. Choose editable-native for editable Office structures, rendered-fidelity for exact Squisq visuals, or hybrid for rendered visuals plus semantic retention.
8. Use get_conversion_report for provenance and save_artifact only when a durable file is required.`;
}

function videoPrompt(
  topic: string,
  orientation: 'landscape' | 'portrait' | undefined,
  theme: string | undefined,
  template: string | undefined,
): string {
  return `Create a video about: ${topic}

1. Call get_authoring_context with targetFormat "mp4" for the complete linked-Squisq vocabulary and workflow.
2. Author concise Markdown for a ${orientation ?? 'landscape'} animated sequence using theme "${theme ?? 'choose from the returned themes'}" and template "${template ?? 'content until visual optimization'}". Bind annotations to headings.
3. If the draft is staged, use inspect_document plus revise_document for targeted repairs instead of resending the full Markdown. Call validate_document with targetFormat "mp4" and repair actionable diagnostics.
4. Call preview_document to review representative frames.
5. Call convert_document with an mp4 target and orientation "${orientation ?? 'landscape'}"; monitor progress and honor cancellation.
6. Use get_conversion_report for provenance and save_artifact only when a durable file is required.`;
}

function documentPrompt(
  topic: string,
  format: 'docx' | 'pdf' | undefined,
  theme: string | undefined,
  template: string | undefined,
): string {
  const target = format ?? 'pdf';
  return `Create a professional document about: ${topic}

1. Call get_authoring_context with targetFormat "${target}" for the complete linked-Squisq vocabulary and workflow.
2. Author structured Markdown using theme "${theme ?? 'choose from the returned themes'}" and template "${template ?? 'content until visual optimization'}". Bind annotations to headings.
3. If the draft is staged, use inspect_document plus revise_document for targeted repairs instead of resending the full Markdown. Call validate_document with targetFormat "${target}" and repair actionable diagnostics.
4. Call convert_document with a ${target} target to create an immutable artifact.
5. Call preview_document and review the bounded page images.
6. Use get_conversion_report for provenance and save_artifact only when a durable file is required.`;
}

function complete(values: readonly string[], prefix: string | undefined): string[] {
  const value = prefix ?? '';
  return values.filter((candidate) => candidate.startsWith(value)).slice(0, 100);
}
