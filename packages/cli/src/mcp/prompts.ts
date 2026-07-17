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
2. Treat the topic facts as a closed evidence set. Preserve them exactly, use temporal or correlational wording unless causality is supplied, and label calculations, assumptions, hypotheses, recommendations, and examples. Causal links, rhetorical performance labels, superlatives, sole causes, capabilities, owners, dates, channels, and operational details must be supplied or explicitly framed. Do not connect separate metrics, audiences, segments, or workflows unless the relationship is supplied. Prefer observed, coincided with, intended to, or proposed over drove, addresses, protects, or proves. Add decision value through supplied baselines, goals, targets, rankings, and transparent calculations. Do not call choices a sequence or capacity allocation unless order, timing, or resources were supplied. When the requested content needs unsupplied operating details, add one proposed operating model scope note that applies to them.
3. Match every explicitly requested slide count exactly. Use exactly one level-one Markdown heading (\`#\`) per slide and no level-two through level-six headings because every heading becomes a slide by default; use lists, tables, or bold labels within a slide. Target at most 80 words per slide. Make slide one a supported point-of-view thesis, not a generic title or unsupported flourish. For requested choices, state concrete opportunity costs grounded in supplied alternatives and one clearly labeled proposed accountable role per choice. Label any unsupplied capacity or outcome assumption as \`Assumption:\` or \`Potential tradeoff:\`. Author complete Markdown sections with accessible alt text. Put annotations on headings, for example \`# Heading {[content]}\`; a standalone \`{[template]}\` creates an extra block. Prefer style "${style ?? 'choose from the returned transform styles'}", theme "${theme ?? 'choose from the returned themes'}", and template "${template ?? 'content until visual optimization'}".
4. Keep the complete Markdown as the authoritative draft. Pass it—or a bundle source when assets are needed—directly to convert_document. Use create_document_bundle only when the same materially large Markdown-and-asset bundle will feed several operations. Do not write a temporary local Markdown file or invent a root id.
5. Before conversion, count slide sections, verify every requested element, and rewrite or label every unsupported claim. Label any new review cadence or measurement procedure as proposed. Use validate_document when syntax, accessibility, retention, or target diagnostics need review; use preview_document when visual evidence such as overflow needs review. Repair findings in the complete Markdown.
6. Only after content coverage is acceptable, replace selected \`content\` blocks with compatible visual templates such as \`definitionCard\`, \`dataTable\`, \`comparisonBar\`, or \`list\` when their semantic inputs fit. Preserve required content.
7. Call convert_document with the complete source and a pptx target. Choose editable-native for editable Office structures, rendered-fidelity for exact Squisq visuals, or hybrid for rendered visuals plus semantic retention. Revise by editing the complete Markdown and converting again.
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
3. Keep the complete Markdown as the authoritative draft and pass it—or a bundle source when assets are needed—directly to convert_document. Use validate_document for uncertain target constraints and preview_document when representative-frame evidence is useful; repair findings in the complete Markdown.
4. Call convert_document with the complete source, an mp4 target, and orientation "${orientation ?? 'landscape'}"; monitor progress and honor cancellation. Revise by editing the complete Markdown and converting again.
5. Use get_conversion_report for provenance and save_artifact only when a durable file is required.`;
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
2. Treat the topic facts as a closed evidence set. Preserve them exactly, use temporal or correlational wording unless causality is supplied, and label calculations, assumptions, hypotheses, recommendations, and examples. Causal links, superlatives, sole causes, capabilities, owners, dates, channels, and operational details must be supplied or explicitly framed. When the requested genre needs unsupplied roles, gates, timelines, channels, or procedures, add one proposed operating model scope note that applies to those details.
3. Honor the requested word range and document genre. Author structured Markdown using theme "${theme ?? 'choose from the returned themes'}" and template "${template ?? 'content until visual optimization'}". Bind annotations to headings. Use connected memo prose for executive decisions and native headings, tables, and checklists for operational documents; retain complete-body content when a visual template would discard detail.
4. Before conversion, count document words, verify every requested element, and rewrite or label every unsupported claim. Keep the complete Markdown as the authoritative draft and pass it—or a bundle source when assets are needed—directly to convert_document. Use validate_document when syntax, accessibility, retention, or target diagnostics need review, and preview_document when page-layout evidence is useful; repair findings in the complete Markdown.
5. Call convert_document with the complete source and a ${target} target to create an immutable artifact. Revise by editing the complete Markdown and converting again.
6. Use get_conversion_report for provenance and save_artifact only when a durable file is required.`;
}

function complete(values: readonly string[], prefix: string | undefined): string[] {
  const value = prefix ?? '';
  return values.filter((candidate) => candidate.startsWith(value)).slice(0, 100);
}
