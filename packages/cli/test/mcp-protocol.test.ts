import { expect } from 'chai';
import { getPackageVersion } from '../src/version.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const TOOL_NAMES = [
  'export_markdown_to_docx',
  'export_markdown_to_pdf',
  'export_markdown_to_pptx',
  'export_markdown_to_html',
  'export_markdown_to_video',
  'convert_docx_to_markdown',
  'convert_pptx_to_markdown',
  'convert_pdf_to_markdown',
  'analyze_markdown',
  'restyle_markdown',
  'list_themes',
  'list_transform_styles',
  'list_export_formats',
] as const;

const PROMPT_ARGUMENTS = {
  'create-presentation': [
    { name: 'topic', required: true },
    { name: 'style', required: false },
  ],
  'create-video': [
    { name: 'topic', required: true },
    { name: 'orientation', required: false },
  ],
  'create-document': [
    { name: 'topic', required: true },
    { name: 'format', required: false },
  ],
} as const;

type ListedTool = Awaited<ReturnType<McpHarness['client']['listTools']>>['tools'][number];
type PromptResult = Awaited<ReturnType<McpHarness['client']['getPrompt']>>;

describe('MCP protocol surface', function () {
  this.timeout(10_000);

  let h: McpHarness;

  before(async () => {
    h = await startMcpHarness();

    // The authority is initialized lazily by tools that need it. Resolve it
    // before protocol-only tests remove the harness root during teardown.
    const ready = await callTool(h.client, 'analyze_markdown', { markdown: '# Ready' });
    expect(ready.isError).to.equal(false);
  });

  after(async () => {
    await h.dispose();
  });

  it('reports the DocBlocks identity and its initialized protocol capabilities', async () => {
    await h.client.ping();

    expect(h.client.getServerVersion()).to.deep.equal({
      name: 'docblocks',
      version: getPackageVersion(),
    });

    const capabilities = h.client.getServerCapabilities();
    expect(capabilities).to.not.equal(undefined);
    expect(Object.keys(capabilities ?? {})).to.have.members(['prompts', 'resources', 'tools']);
    expect(capabilities?.prompts?.listChanged).to.equal(true);
    expect(capabilities?.resources?.listChanged).to.equal(true);
    expect(capabilities?.tools?.listChanged).to.equal(true);
  });

  it('advertises the exact supported tool set', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).to.have.length(TOOL_NAMES.length);
    expect(names).to.have.members([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).to.be.a('string');
      expect(tool.description?.length ?? 0, `${tool.name} description length`).to.be.greaterThan(0);
      expect(tool.inputSchema.type, `${tool.name} schema type`).to.equal('object');
      expect(tool.inputSchema.additionalProperties, `${tool.name} strict schema`).to.equal(false);
      expect(tool.annotations, `${tool.name} annotations`).to.be.an('object');
      expect(tool.annotations?.openWorldHint, `${tool.name} open-world hint`).to.equal(false);
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotence hint`).to.equal(true);
    }

    for (const name of [
      'analyze_markdown',
      'list_themes',
      'list_transform_styles',
      'list_export_formats',
    ]) {
      const annotations = findTool(tools, name).annotations;
      expect(annotations?.readOnlyHint, name).to.equal(true);
      expect(annotations?.destructiveHint, name).to.equal(false);
    }
    for (const name of TOOL_NAMES.filter(
      (toolName) =>
        ![
          'analyze_markdown',
          'list_themes',
          'list_transform_styles',
          'list_export_formats',
        ].includes(toolName),
    )) {
      const annotations = findTool(tools, name).annotations;
      expect(annotations?.readOnlyHint, name).to.equal(false);
      expect(annotations?.destructiveHint, name).to.equal(true);
    }

    for (const name of [
      'export_markdown_to_docx',
      'export_markdown_to_pdf',
      'export_markdown_to_pptx',
      'export_markdown_to_html',
      'export_markdown_to_video',
      'analyze_markdown',
      'list_themes',
      'list_transform_styles',
      'list_export_formats',
    ]) {
      const outputSchema = findTool(tools, name).outputSchema;
      expect(outputSchema?.type, `${name} output schema`).to.equal('object');
      expect(outputSchema?.additionalProperties, `${name} strict output`).to.equal(false);
    }
  });

  it('publishes bounded schemas for markdown, conversion, and video inputs', async () => {
    const { tools } = await h.client.listTools();
    const exportTools = TOOL_NAMES.filter((name) => name.startsWith('export_markdown_to_'));

    for (const name of exportTools) {
      const tool = findTool(tools, name);
      expect(tool.inputSchema.required).to.deep.equal(['outputPath']);
      expect(tool.inputSchema.additionalProperties).to.equal(false);
      expect(schemaProperty(tool, 'outputPath')).to.include({
        type: 'string',
        minLength: 1,
        maxLength: 4096,
      });
      expectMarkdownSourceSchema(tool);
    }

    const video = findTool(tools, 'export_markdown_to_video');
    expect(schemaProperty(video, 'fps')).to.include({
      type: 'integer',
      minimum: 1,
      maximum: 120,
    });
    expect(schemaProperty(video, 'orientation').enum).to.deep.equal(['landscape', 'portrait']);
    expect(schemaProperty(video, 'quality').enum).to.deep.equal(['draft', 'normal', 'high']);

    for (const name of [
      'convert_docx_to_markdown',
      'convert_pptx_to_markdown',
      'convert_pdf_to_markdown',
    ]) {
      const tool = findTool(tools, name);
      expect(tool.inputSchema.required).to.deep.equal(['inputPath']);
      expect(schemaProperty(tool, 'inputPath')).to.include({
        type: 'string',
        minLength: 1,
        maxLength: 4096,
      });
      expect(schemaProperty(tool, 'outputPath')).to.include({ type: 'string', maxLength: 4096 });
    }

    expectMarkdownSourceSchema(findTool(tools, 'analyze_markdown'));

    const restyle = findTool(tools, 'restyle_markdown');
    expect(restyle.inputSchema.required).to.deep.equal(['style']);
    expect(schemaProperty(restyle, 'style')).to.include({ type: 'string', maxLength: 256 });
    expectMarkdownSourceSchema(restyle);

    for (const name of ['list_themes', 'list_transform_styles', 'list_export_formats']) {
      const tool = findTool(tools, name);
      expect(tool.inputSchema.properties).to.deep.equal({});
    }
  });

  it('keeps the formats resource aligned with the callable tool inventory', async () => {
    const listed = await h.client.listResources();
    expect(listed.resources).to.have.length(1);
    expect(listed.resources[0]).to.include({
      name: 'formats',
      uri: 'docblocks://formats',
    });

    const read = await h.client.readResource({ uri: 'docblocks://formats' });
    expect(read.contents).to.have.length(1);
    const content = read.contents[0];
    expect(content).to.include({
      uri: 'docblocks://formats',
      mimeType: 'application/json',
    });
    expect(content).to.have.property('text');
    if (!content || !('text' in content)) throw new Error('Expected a text resource');

    const payload = JSON.parse(content.text) as {
      description?: unknown;
      inputFormats?: unknown;
      outputFormats?: unknown;
    };
    expect(payload.description).to.be.a('string');
    expect(
      typeof payload.description === 'string' ? payload.description.length : 0,
    ).to.be.greaterThan(0);
    expect(payload.inputFormats).to.be.an('array').with.length(6);
    expect(payload.inputFormats).to.have.members(['.md', '.zip', '.dbk', '.docx', '.pptx', '.pdf']);
    expect(payload.outputFormats).to.be.an('array').with.length(6);

    const listedFormatsResult = await h.client.callTool({
      name: 'list_export_formats',
      arguments: {},
    });
    expect(listedFormatsResult.isError).to.not.equal(true);
    const listedFormatsText = listedFormatsResult.content.find(
      (item): item is Extract<(typeof listedFormatsResult.content)[number], { type: 'text' }> =>
        item.type === 'text',
    );
    if (!listedFormatsText) throw new Error('Expected list_export_formats text content');
    const listedFormats = JSON.parse(listedFormatsText.text) as {
      input: Array<{ ext: string; tool?: string }>;
      output: Array<{ format: string; tool: string }>;
    };
    const listedInputs = listedFormats.input.flatMap(({ ext }) =>
      ext === '.zip/.dbk' ? ['.zip', '.dbk'] : [ext],
    );
    expect(payload.inputFormats).to.have.members(listedInputs);
    expect(payload.outputFormats).to.have.members([
      ...listedFormats.output.map(({ format }) => format),
      'markdown',
    ]);

    const advertisedTools = new Set((await h.client.listTools()).tools.map(({ name }) => name));
    for (const entry of [...listedFormats.input, ...listedFormats.output]) {
      if (entry.tool) expect(advertisedTools.has(entry.tool), entry.tool).to.equal(true);
    }
    expect(listedFormatsResult.structuredContent).to.deep.equal(listedFormats);
  });

  it('lists all prompt templates and their required and optional arguments', async () => {
    const { prompts } = await h.client.listPrompts();
    const expectedNames = Object.keys(PROMPT_ARGUMENTS);

    expect(prompts.map((prompt) => prompt.name)).to.have.members(expectedNames);
    expect(prompts).to.have.length(expectedNames.length);

    for (const prompt of prompts) {
      expect(prompt.description, `${prompt.name} description`).to.be.a('string');
      expect(
        prompt.description?.length ?? 0,
        `${prompt.name} description length`,
      ).to.be.greaterThan(0);
      const expected = PROMPT_ARGUMENTS[prompt.name as keyof typeof PROMPT_ARGUMENTS];
      expect(expected, `${prompt.name} is known`).to.not.equal(undefined);
      const actual = (prompt.arguments ?? []).map(({ name, required }) => ({ name, required }));
      expect(actual).to.have.length(expected.length);
      expect(actual).to.deep.have.members([...expected]);
    }
  });

  it('gets presentation, video, and document prompts with defaults and overrides', async () => {
    const presentationDefault = promptText(
      await h.client.getPrompt({
        name: 'create-presentation',
        arguments: { topic: 'Orbital habitats' },
      }),
    );
    expect(presentationDefault).to.include('Create a presentation about: Orbital habitats');
    expect(presentationDefault).to.include('style="documentary"');
    expect(presentationDefault).to.include('export_markdown_to_pptx');

    const presentationOption = promptText(
      await h.client.getPrompt({
        name: 'create-presentation',
        arguments: { topic: 'Orbital habitats', style: 'minimal' },
      }),
    );
    expect(presentationOption).to.include('style="minimal"');

    const videoDefault = promptText(
      await h.client.getPrompt({ name: 'create-video', arguments: { topic: 'Tides' } }),
    );
    expect(videoDefault).to.include('Create a video about: Tides');
    expect(videoDefault).to.include('orientation="landscape"');
    expect(videoDefault).to.include('export_markdown_to_video');

    const videoOption = promptText(
      await h.client.getPrompt({
        name: 'create-video',
        arguments: { topic: 'Tides', orientation: 'portrait' },
      }),
    );
    expect(videoOption).to.include('orientation="portrait"');

    const documentDefault = promptText(
      await h.client.getPrompt({ name: 'create-document', arguments: { topic: 'Wetlands' } }),
    );
    expect(documentDefault).to.include('Create a professional document about: Wetlands');
    expect(documentDefault).to.include('export_markdown_to_pdf');

    const documentOption = promptText(
      await h.client.getPrompt({
        name: 'create-document',
        arguments: { topic: 'Wetlands', format: 'docx' },
      }),
    );
    expect(documentOption).to.include('export_markdown_to_docx');

    const styles = JSON.parse(
      (await callTool(h.client, 'list_transform_styles', {})).text,
    ) as Array<{
      id: string;
    }>;
    expect(styles.map(({ id }) => id)).to.include('documentary');

    const toolNames = new Set((await h.client.listTools()).tools.map(({ name }) => name));
    for (const text of [presentationDefault, videoDefault, documentDefault]) {
      for (const toolName of text.match(/(?:list|restyle|analyze|export)_[a-z0-9_]+/g) ?? []) {
        expect(toolNames.has(toolName), `${toolName} referenced by a prompt`).to.equal(true);
      }
    }
  });

  it('rejects invalid prompt arguments at the protocol boundary', async () => {
    await expectInvalidPromptArguments(
      h.client.getPrompt({ name: 'create-presentation', arguments: {} }),
      'create-presentation',
    );
    await expectInvalidPromptArguments(
      h.client.getPrompt({
        name: 'create-video',
        arguments: { topic: 'Tides', orientation: 'square' },
      }),
      'create-video',
    );
    await expectInvalidPromptArguments(
      h.client.getPrompt({
        name: 'create-document',
        arguments: { topic: 'Wetlands', format: 'markdown' },
      }),
      'create-document',
    );
    await expectInvalidPromptArguments(
      h.client.getPrompt({
        name: 'create-presentation',
        arguments: { topic: 'Orbital habitats', style: 'x'.repeat(257) },
      }),
      'create-presentation',
    );
    await expectInvalidPromptArguments(
      h.client.getPrompt({
        name: 'create-document',
        arguments: { topic: 'Wetlands', unexpected: 'must be rejected' },
      }),
      'create-document',
    );
  });
});

function findTool(tools: readonly ListedTool[], name: string): ListedTool {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `${name} is advertised`).to.not.equal(undefined);
  if (!tool) throw new Error(`MCP tool is missing: ${name}`);
  return tool;
}

function schemaProperty(tool: ListedTool, name: string): Record<string, unknown> {
  const property = tool.inputSchema.properties?.[name];
  expect(property, `${tool.name}.${name} schema`).to.be.an('object');
  return property as Record<string, unknown>;
}

function expectMarkdownSourceSchema(tool: ListedTool): void {
  const source = schemaProperty(tool, 'source');
  const alternatives = source.anyOf as Array<Record<string, unknown>>;
  expect(alternatives, `${tool.name}.source alternatives`).to.be.an('array').with.length(2);

  const kinds = alternatives.map((alternative) => {
    const properties = alternative.properties as Record<string, Record<string, unknown>>;
    return properties.kind?.const;
  });
  expect(kinds).to.have.members(['text', 'file']);
  for (const alternative of alternatives) {
    expect(alternative.additionalProperties).to.equal(false);
  }

  expect(schemaProperty(tool, 'markdown')).to.include({
    type: 'string',
    maxLength: 20 * 1024 * 1024,
  });
}

function promptText(result: PromptResult): string {
  expect(result.messages).to.have.length(1);
  const message = result.messages[0];
  expect(message?.role).to.equal('user');
  expect(message?.content.type).to.equal('text');
  if (!message || message.content.type !== 'text') throw new Error('Expected one text prompt');
  return message.content.text;
}

async function expectInvalidPromptArguments(
  promise: Promise<unknown>,
  promptName: string,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught: unknown) {
    error = caught;
  }

  expect(error).to.be.instanceOf(Error);
  const message = (error as Error).message;
  expect(message).to.include('-32602');
  expect(message).to.include(`Invalid arguments for prompt ${promptName}`);
}
