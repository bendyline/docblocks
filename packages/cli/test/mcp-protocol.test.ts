import { expect } from 'chai';
import { z as z4 } from 'zod/v4';
import { DOCBLOCKS_MCP_TOOL_NAMES } from '@bendyline/docblocks/mcp';
import { DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS } from '@bendyline/docblocks/mcp/zod';
import { getPackageVersion } from '../src/version.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const REQUIRED_AGENTIC_TOOL_NAMES = [
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

const LINKED_FORMAT_IDS = [
  'md',
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'csv',
  'html',
  'htmlzip',
  'epub',
  'dbk',
  'mp4',
  'gif',
] as const;

const PROMPT_ARGUMENTS = {
  'create-presentation': [
    { name: 'topic', required: true },
    { name: 'style', required: false },
    { name: 'theme', required: false },
    { name: 'template', required: false },
  ],
  'create-video': [
    { name: 'topic', required: true },
    { name: 'orientation', required: false },
    { name: 'theme', required: false },
    { name: 'template', required: false },
  ],
  'create-document': [
    { name: 'topic', required: true },
    { name: 'format', required: false },
    { name: 'theme', required: false },
    { name: 'template', required: false },
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
    const ready = await callTool(h.client, 'inspect_document', {
      source: { kind: 'markdown', markdown: '# Ready', name: null },
    });
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
    expect(h.client.getInstructions()).to.include('get_authoring_context');
    expect(h.client.getInstructions()).to.include('list_roots before drafting');
    expect(h.client.getInstructions()).to.include('--allow-write');
    expect(h.client.getInstructions()).to.include('do not fall back');
    expect(h.client.getInstructions()).to.include('plain text or ordinary Markdown');
    expect(h.client.getInstructions()).to.include('no preflight');
    expect(h.client.getInstructions()).to.include('optional layout hints');
    expect(h.client.getInstructions()).to.include('directly to convert_document');
    expect(h.client.getInstructions()).to.include('reused by two or more');
    expect(h.client.getInstructions()).to.include('never invent root ids');
    expect(h.client.getInstructions()).not.to.include('validate_document');

    const capabilities = h.client.getServerCapabilities();
    expect(capabilities).to.not.equal(undefined);
    expect(Object.keys(capabilities ?? {})).to.have.members([
      'completions',
      'prompts',
      'resources',
      'tools',
    ]);
    expect(capabilities?.prompts?.listChanged).to.equal(true);
    expect(capabilities?.resources?.listChanged).to.equal(true);
    expect(capabilities?.tools?.listChanged).to.equal(true);
  });

  it('dynamically audits every advertised tool and includes the complete agentic surface', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).to.equal(names.length);
    expect(names).to.have.members([...REQUIRED_AGENTIC_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).to.be.a('string');
      expect(tool.description?.length ?? 0, `${tool.name} description length`).to.be.greaterThan(0);
      expect(tool.inputSchema.type, `${tool.name} schema type`).to.equal('object');
      expect(tool.inputSchema.additionalProperties, `${tool.name} strict schema`).to.equal(false);
      expect(tool.outputSchema, `${tool.name} output schema`).to.be.an('object');
      expectExactObjectSchemas(tool.inputSchema, `${tool.name}.input`);
      if (tool.outputSchema) {
        expect(tool.outputSchema.type, `${tool.name} output schema type`).to.equal('object');
        expect(
          tool.outputSchema.additionalProperties,
          `${tool.name} strict output schema`,
        ).to.equal(false);
        expectExactObjectSchemas(tool.outputSchema, `${tool.name}.output`);
      }
      expect(tool.annotations, `${tool.name} annotations`).to.be.an('object');
      expect(tool.annotations?.openWorldHint, `${tool.name} open-world hint`).to.equal(false);
      expect(tool.annotations?.readOnlyHint, `${tool.name} read-only hint`).to.be.a('boolean');
      expect(tool.annotations?.destructiveHint, `${tool.name} destructive hint`).to.be.a('boolean');
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotence hint`).to.be.a('boolean');
    }

    for (const name of [
      'list_roots',
      'inspect_document',
      'compare_documents',
      'get_authoring_context',
      'list_templates',
      'describe_template',
      'recommend_templates',
      'describe_theme',
      'infer_theme_from_file',
      'inspect_pptx_layouts',
      'get_conversion_report',
      'list_formats',
      'list_themes',
      'list_transform_styles',
    ]) {
      const annotations = findTool(tools, name).annotations;
      expect(annotations?.readOnlyHint, name).to.equal(true);
      expect(annotations?.destructiveHint, name).to.equal(false);
      expect(annotations?.idempotentHint, name).to.equal(true);
    }
    for (const name of [
      'convert_document',
      'create_document_bundle',
      'preview_document',
      'apply_inferred_theme',
    ]) {
      const annotations = findTool(tools, name).annotations;
      expect(annotations?.readOnlyHint, name).to.equal(false);
      expect(annotations?.destructiveHint, name).to.equal(false);
      expect(annotations?.idempotentHint, name).to.equal(false);
    }
    const saveAnnotations = findTool(tools, 'save_artifact').annotations;
    expect(saveAnnotations?.readOnlyHint).to.equal(false);
    expect(saveAnnotations?.destructiveHint).to.equal(true);
    expect(saveAnnotations?.idempotentHint).to.equal(false);
  });

  it('publishes one canonical conversion schema without legacy aliases', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map(({ name }) => name)).to.not.include.members([
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
      'list_export_formats',
    ]);
    const convert = findTool(tools, 'convert_document');
    expect(convert.inputSchema.required).to.deep.equal(['source', 'targets']);
    for (const name of ['list_formats', 'list_themes', 'list_transform_styles']) {
      const tool = findTool(tools, name);
      expect(tool.inputSchema.properties).to.deep.equal({});
    }
  });

  it('publishes the exact core-owned bounded output contract for all 19 tools', async () => {
    const { tools } = await h.client.listTools();
    expect(DOCBLOCKS_MCP_TOOL_NAMES).to.deep.equal(REQUIRED_AGENTIC_TOOL_NAMES);
    expect(Object.keys(DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS)).to.deep.equal([
      ...DOCBLOCKS_MCP_TOOL_NAMES,
    ]);

    for (const name of DOCBLOCKS_MCP_TOOL_NAMES) {
      const tool = findTool(tools, name);
      const coreSchema = z4.toJSONSchema(DOCBLOCKS_MCP_TOOL_OUTPUT_SCHEMAS[name], {
        target: 'draft-7',
      });
      expect(tool.outputSchema, `${name} uses the core output schema`).to.deep.equal(coreSchema);
      expectBoundedOutputCollectionsAndText(tool.outputSchema, `${name}.output`);
    }
  });

  it('publishes bounded discriminated schemas for canonical sources and all linked targets', async () => {
    const { tools } = await h.client.listTools();
    const convert = findTool(tools, 'convert_document');
    expect(convert.inputSchema.required).to.deep.equal(['source', 'targets']);

    const source = schemaProperty(convert, 'source');
    const sourceAlternatives = requireSchemaArray(source.anyOf, 'convert_document.source.anyOf');
    const sourceKinds = sourceAlternatives.map((alternative) => schemaConst(alternative, 'kind'));
    expect(sourceKinds).to.have.members(['markdown', 'file', 'artifact', 'bundle']);

    const bundle = sourceAlternatives.find(
      (alternative) => schemaConst(alternative, 'kind') === 'bundle',
    );
    expect(bundle, 'bundle source schema').to.not.equal(undefined);
    const bundleAssets = schemaPropertyFromSchema(
      requireSchema(bundle, 'bundle source schema'),
      'assets',
    );
    expect(bundleAssets.maxItems).to.be.a('number').and.greaterThan(0);
    const bundleAsset = requireSchema(bundleAssets.items, 'bundle asset item');
    expect(bundleAsset.additionalProperties).to.equal(false);
    expect(bundleAsset.required).to.deep.equal([
      'path',
      'source',
      'mimeType',
      'altText',
      'credit',
      'license',
    ]);
    const assetSources = requireSchemaArray(
      schemaPropertyFromSchema(bundleAsset, 'source').anyOf,
      'bundle asset source alternatives',
    );
    expect(assetSources.map((alternative) => schemaConst(alternative, 'kind'))).to.have.members([
      'file',
      'artifact',
    ]);

    const targets = schemaProperty(convert, 'targets');
    expect(targets.minItems).to.equal(1);
    expect(targets.maxItems).to.equal(12);
    const targetAlternatives = requireSchemaArray(
      requireSchema(targets.items, 'conversion targets').anyOf,
      'conversion target alternatives',
    );
    expect(
      targetAlternatives.map((alternative) => schemaConst(alternative, 'format')),
    ).to.have.members([...LINKED_FORMAT_IDS]);
    const expectedFidelities: Record<string, string[]> = {
      md: ['semantic'],
      docx: ['semantic', 'editable-native'],
      pdf: ['semantic', 'rendered-fidelity', 'hybrid'],
      pptx: ['semantic', 'editable-native', 'rendered-fidelity', 'hybrid'],
      xlsx: ['semantic', 'editable-native'],
      csv: ['semantic'],
      html: ['semantic'],
      htmlzip: ['semantic'],
      epub: ['semantic'],
      dbk: ['semantic', 'editable-native'],
      mp4: ['rendered-fidelity'],
      gif: ['rendered-fidelity'],
    };
    for (const target of targetAlternatives) {
      const format = schemaConst(target, 'format');
      if (typeof format !== 'string') throw new Error('Expected conversion target format');
      const fidelity = schemaPropertyFromSchema(target, 'fidelity');
      const advertised = Array.isArray(fidelity.enum)
        ? fidelity.enum
        : fidelity.const === undefined
          ? []
          : [fidelity.const];
      expect(advertised, `${format} fidelities`).to.deep.equal(expectedFidelities[format]);
    }

    const preview = findTool(tools, 'preview_document');
    expect(preview.inputSchema.properties).to.not.have.property('targetFormat');
    expect(preview.description).to.include('previewBasis');
    expect(preview.description).to.include('reconstructed-import');
    expect(preview.description).to.include('native-extracted');

    expect(findTool(tools, 'list_roots').description).to.include('durable local output');
    expect(findTool(tools, 'create_document_bundle').description).to.include('two or more');
    expect(findTool(tools, 'inspect_document').description).to.include('never required');
    expect(findTool(tools, 'get_authoring_context').description).to.include(
      'Plain Markdown can be converted without calling this tool',
    );

    const save = findTool(tools, 'save_artifact');
    expect(save.inputSchema.required).to.deep.equal(['artifactUri', 'destination']);
    const destinationAlternatives = requireSchemaArray(
      schemaProperty(save, 'destination').anyOf,
      'save_artifact.destination alternatives',
    );
    expect(
      destinationAlternatives.map((alternative) => schemaConst(alternative, 'ifExists')),
    ).to.have.members(['error', 'replace']);
    const replace = destinationAlternatives.find(
      (alternative) => schemaConst(alternative, 'ifExists') === 'replace',
    );
    expect(requireSchema(replace, 'replace materialization').required).to.include('expectedSha256');
  });

  it('enumerates resources/templates and keeps discovery aligned with linked Squisq', async () => {
    const listed = await h.client.listResources();
    expect(new Set(listed.resources.map((resource) => resource.uri)).size).to.equal(
      listed.resources.length,
    );
    const formatsResource = listed.resources.find(
      (resource) => resource.uri === 'docblocks://formats',
    );
    expect(formatsResource).to.include({
      name: 'formats',
      uri: 'docblocks://formats',
    });
    const authoringResource = listed.resources.find(
      (resource) => resource.uri === 'docblocks://authoring-guide',
    );
    expect(authoringResource?.annotations).to.deep.equal({
      audience: ['assistant'],
      priority: 1,
    });
    for (const resource of listed.resources) {
      expect(resource.description, `${resource.uri} description`).to.be.a('string');
      expect(resource.mimeType, `${resource.uri} mime type`).to.be.a('string');
      if (resource.uri !== 'docblocks://formats') {
        const response = await h.client.readResource({ uri: resource.uri });
        expect(response.contents.length, `${resource.uri} contents`).to.be.greaterThan(0);
        for (const entry of response.contents) {
          expect(entry.uri, `${resource.uri} content URI`).to.equal(resource.uri);
          expect('text' in entry || 'blob' in entry, `${resource.uri} content payload`).to.equal(
            true,
          );
        }
      }
    }

    const templates = await h.client.listResourceTemplates();
    expect(
      new Set(templates.resourceTemplates.map((template) => template.uriTemplate)).size,
    ).to.equal(templates.resourceTemplates.length);
    const artifactTemplate = templates.resourceTemplates.find(
      (template) => template.uriTemplate === 'docblocks://artifacts/{id}',
    );
    expect(artifactTemplate).to.include({ name: 'artifact' });
    expect(artifactTemplate?.description).to.be.a('string').and.not.equal('');
    const reportTemplate = templates.resourceTemplates.find(
      (template) => template.uriTemplate === 'docblocks://reports/{id}',
    );
    expect(reportTemplate).to.include({ name: 'conversion-report' });
    expect(reportTemplate?.description).to.be.a('string').and.not.equal('');

    const read = await h.client.readResource({ uri: 'docblocks://formats' });
    expect(read.contents).to.have.length(1);
    const content = read.contents[0];
    expect(content).to.include({
      uri: 'docblocks://formats',
      mimeType: 'application/json',
    });
    expect(content).to.have.property('text');
    if (!content || !('text' in content)) throw new Error('Expected a text resource');

    const payload = JSON.parse(content.text) as { formats?: unknown };
    const formats = requireFormatCapabilities(payload.formats);
    expect(formats.map((format) => format.id)).to.have.members([...LINKED_FORMAT_IDS]);

    const authoring = await h.client.readResource({ uri: 'docblocks://authoring-guide' });
    const authoringContent = authoring.contents[0];
    if (!authoringContent || !('text' in authoringContent)) {
      throw new Error('Expected the authoring guide as text JSON');
    }
    const authoringPayload = JSON.parse(authoringContent.text) as {
      version?: unknown;
      markdownAnnotation?: unknown;
      standaloneWarning?: unknown;
      workflow?: unknown[];
      templates?: Array<{ id?: unknown; bodyPolicy?: unknown; annotationExample?: unknown }>;
    };
    expect(authoringPayload.version).to.equal(8);
    expect(authoringPayload.markdownAnnotation).to.equal('# Heading {[templateId key="value"]}');
    expect(authoringPayload.standaloneWarning).to.include('heading-less block');
    expect(
      authoringPayload.workflow?.some((step) =>
        String(step).includes('directly to convert_document'),
      ),
    ).to.equal(true);
    expect(
      authoringPayload.workflow?.some((step) =>
        String(step).includes('without a preflight or template annotations'),
      ),
    ).to.equal(true);
    expect(authoringPayload.templates?.find(({ id }) => id === 'content')).to.include({
      bodyPolicy: 'complete',
      annotationExample: '# Heading {[content]}',
    });

    const listedFormatsResult = await h.client.callTool({ name: 'list_formats', arguments: {} });
    expect(listedFormatsResult.isError).to.not.equal(true);
    const listedFormatsText = listedFormatsResult.content.find(
      (item): item is Extract<(typeof listedFormatsResult.content)[number], { type: 'text' }> =>
        item.type === 'text',
    );
    if (!listedFormatsText) throw new Error('Expected list_formats text content');
    const listedFormats = JSON.parse(listedFormatsText.text) as { formats?: unknown };
    expect(requireFormatCapabilities(listedFormats.formats)).to.deep.equal(formats);

    const advertisedTools = new Set((await h.client.listTools()).tools.map(({ name }) => name));
    for (const format of formats) {
      for (const operation of [format.import, format.export]) {
        expect(operation.supported).to.be.a('boolean');
        if (operation.supported) {
          expect(operation.tool).to.be.a('string');
          expect(advertisedTools.has(operation.tool ?? ''), operation.tool).to.equal(true);
          expect(operation.excludedReason).to.equal(undefined);
        } else {
          expect(operation.tool).to.equal(undefined);
          expect(operation.excludedReason).to.be.a('string').and.not.equal('');
        }
      }
    }
    expect(listedFormatsResult.structuredContent).to.deep.equal({
      version: 1,
      kind: 'success',
      result: listedFormats,
      error: null,
    });
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

  it('completes presentation styles from the linked Squisq transform registry', async () => {
    const result = await h.client.complete({
      ref: { type: 'ref/prompt', name: 'create-presentation' },
      argument: { name: 'style', value: 'doc' },
      context: { arguments: { topic: 'Orbital habitats' } },
    });

    expect(result.completion.values).to.include('documentary');
    expect(result.completion.values.every((value) => value.startsWith('doc'))).to.equal(true);
    expect(result.completion.values.length).to.be.at.most(100);
  });

  it('completes linked theme and template vocabulary in authoring prompts', async () => {
    const theme = await h.client.complete({
      ref: { type: 'ref/prompt', name: 'create-document' },
      argument: { name: 'theme', value: 'doc' },
      context: { arguments: { topic: 'Orbital habitats' } },
    });
    expect(theme.completion.values).to.include('documentary');
    expect(theme.completion.values.every((value) => value.startsWith('doc'))).to.equal(true);

    const template = await h.client.complete({
      ref: { type: 'ref/prompt', name: 'create-presentation' },
      argument: { name: 'template', value: 'sta' },
      context: { arguments: { topic: 'Orbital habitats' } },
    });
    expect(template.completion.values.some((value) => value.startsWith('sta'))).to.equal(true);
    expect(template.completion.values.length).to.be.at.most(100);
  });

  it('keeps every prompt executable through the artifact-first workflow', async () => {
    const presentationDefault = promptText(
      await h.client.getPrompt({
        name: 'create-presentation',
        arguments: { topic: 'Orbital habitats' },
      }),
    );
    expect(presentationDefault).to.include('Create a presentation about: Orbital habitats');
    expect(presentationDefault).to.include('get_authoring_context');
    expect(presentationDefault).to.include('Author plain Markdown');
    expect(presentationDefault).to.include('optional layout hints');
    expect(presentationDefault).to.include('No validation, inspection, or preview is required');
    expect(presentationDefault).to.include('list_roots before drafting');
    expect(presentationDefault).to.include('do not use a shell or CLI converter');
    expect(presentationDefault).to.include('level-one heading');
    expect(presentationDefault).to.match(/\bpptx\b/iu);

    const presentationOption = promptText(
      await h.client.getPrompt({
        name: 'create-presentation',
        arguments: { topic: 'Orbital habitats', style: 'minimal' },
      }),
    );
    expect(presentationOption).to.include('minimal');

    const videoDefault = promptText(
      await h.client.getPrompt({ name: 'create-video', arguments: { topic: 'Tides' } }),
    );
    expect(videoDefault).to.include('Create a video about: Tides');
    expect(videoDefault).to.include('landscape');
    expect(videoDefault).to.match(/\bmp4\b/iu);

    const videoOption = promptText(
      await h.client.getPrompt({
        name: 'create-video',
        arguments: { topic: 'Tides', orientation: 'portrait' },
      }),
    );
    expect(videoOption).to.include('portrait');

    const documentDefault = promptText(
      await h.client.getPrompt({ name: 'create-document', arguments: { topic: 'Wetlands' } }),
    );
    expect(documentDefault).to.include('Create a document about: Wetlands');
    expect(documentDefault).to.include('Author plain Markdown');
    expect(documentDefault).to.match(/\bpdf\b/iu);

    const documentOption = promptText(
      await h.client.getPrompt({
        name: 'create-document',
        arguments: { topic: 'Wetlands', format: 'docx' },
      }),
    );
    expect(documentOption).to.match(/\bdocx\b/iu);

    const toolNames = new Set((await h.client.listTools()).tools.map(({ name }) => name));
    for (const text of [presentationDefault, videoDefault, documentDefault]) {
      expect(text).to.include('convert_document');
      expect(text).to.include('preview_document');
      expect(text).to.include('save_artifact');
      expect(text).not.to.include('validate_document');
      expect(text).not.to.include('export_markdown_to_');
      for (const toolName of text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu) ?? []) {
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

function schemaPropertyFromSchema(
  schema: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const properties = requireSchema(schema.properties, 'schema properties');
  return requireSchema(properties[name], `schema property ${name}`);
}

function requireSchema(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).to.be.an('object').and.not.equal(null);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected JSON schema object: ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireSchemaArray(value: unknown, label: string): Record<string, unknown>[] {
  expect(value, label).to.be.an('array');
  if (!Array.isArray(value)) throw new Error(`Expected JSON schema array: ${label}`);
  return value.map((entry, index) => requireSchema(entry, `${label}[${index}]`));
}

function schemaConst(schema: Record<string, unknown>, propertyName: string): unknown {
  return schemaPropertyFromSchema(schema, propertyName).const;
}

function expectExactObjectSchemas(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectExactObjectSchemas(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') {
    expect(schema.additionalProperties, `${path} rejects unknown properties`).to.equal(false);
  }
  for (const [key, nested] of Object.entries(schema)) {
    expectExactObjectSchemas(nested, `${path}.${key}`);
  }
}

function expectBoundedOutputCollectionsAndText(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      expectBoundedOutputCollectionsAndText(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'array') {
    expect(schema.maxItems, `${path} has a finite collection bound`).to.be.a('number');
  }
  const hasStringType =
    schema.type === 'string' ||
    (Array.isArray(schema.type) && schema.type.some((type) => type === 'string'));
  if (hasStringType) {
    const bounded =
      typeof schema.maxLength === 'number' ||
      typeof schema.pattern === 'string' ||
      Array.isArray(schema.enum) ||
      typeof schema.const === 'string';
    expect(bounded, `${path} has a finite text bound or vocabulary`).to.equal(true);
  }
  for (const [key, nested] of Object.entries(schema)) {
    expectBoundedOutputCollectionsAndText(nested, `${path}.${key}`);
  }
}

interface FormatOperationCapability {
  supported: boolean;
  tool?: string;
  excludedReason?: string;
}

interface FormatCapability {
  id: string;
  label: string;
  mimeType: string;
  extensions: string[];
  import: FormatOperationCapability;
  export: FormatOperationCapability;
}

function requireFormatCapabilities(value: unknown): FormatCapability[] {
  expect(value, 'format capability manifest').to.be.an('array');
  if (!Array.isArray(value)) throw new Error('Expected format capability manifest array');
  return value.map((entry, index) => {
    const capability = requireSchema(entry, `formats[${index}]`);
    expect(Object.keys(capability), `formats[${index}] exact keys`).to.have.members([
      'id',
      'label',
      'mimeType',
      'extensions',
      'import',
      'export',
    ]);
    expect(capability.id).to.be.a('string').and.not.equal('');
    expect(capability.label).to.be.a('string').and.not.equal('');
    expect(capability.mimeType).to.be.a('string').and.not.equal('');
    expect(capability.extensions).to.be.an('array');
    if (!Array.isArray(capability.extensions)) {
      throw new Error(`Expected formats[${index}].extensions array`);
    }
    expect(capability.extensions.length).to.be.greaterThan(0);
    for (const extension of capability.extensions) {
      expect(extension, `formats[${index}] extension`).to.be.a('string').and.match(/^\./u);
    }
    return {
      id: requireString(capability.id, `formats[${index}].id`),
      label: requireString(capability.label, `formats[${index}].label`),
      mimeType: requireString(capability.mimeType, `formats[${index}].mimeType`),
      extensions: capability.extensions.map((extension, extensionIndex) =>
        requireString(extension, `formats[${index}].extensions[${extensionIndex}]`),
      ),
      import: requireFormatOperation(capability.import, `formats[${index}].import`),
      export: requireFormatOperation(capability.export, `formats[${index}].export`),
    };
  });
}

function requireFormatOperation(value: unknown, label: string): FormatOperationCapability {
  const operation = requireSchema(value, label);
  expect(operation.supported, `${label}.supported`).to.be.a('boolean');
  if (typeof operation.supported !== 'boolean') throw new Error(`Expected ${label}.supported`);
  const allowedKeys = operation.supported ? ['supported', 'tool'] : ['supported', 'excludedReason'];
  expect(Object.keys(operation), `${label} exact keys`).to.have.members(allowedKeys);
  return {
    supported: operation.supported,
    ...(typeof operation.tool === 'string' ? { tool: operation.tool } : {}),
    ...(typeof operation.excludedReason === 'string'
      ? { excludedReason: operation.excludedReason }
      : {}),
  };
}

function requireString(value: unknown, label: string): string {
  expect(value, label).to.be.a('string');
  if (typeof value !== 'string') throw new Error(`Expected string: ${label}`);
  return value;
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
