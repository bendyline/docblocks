import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EVAL_PROMPT_PROFILES } from './cases.js';
import { judgeMarkdown } from './markdown-judge.js';
import { generationOutputSchema, LLM_JUDGE_OUTPUT_SCHEMA } from './schemas.js';
import { resolveCodexCommand, runCapturedProcess } from './subprocess.js';
import type {
  EvalCase,
  EvalPromptProfile,
  GenerationFinalResult,
  LlmJudgeResult,
  McpTraceMetrics,
  ProcessCapture,
  TokenUsage,
} from './types.js';

export const LLM_JUDGE_CONTRACT_VERSION = 3;

const generationResultSchema = z
  .object({
    artifactPath: z.string().min(1),
    targetFormat: z.enum(['pptx', 'docx']),
    fidelity: z.string().min(1),
    markdown: z.string().min(1),
    summary: z.string().min(1),
    validationRepairs: z.array(z.string()),
  })
  .strict();

const llmJudgeResultSchema = z
  .object({
    scores: z
      .object({
        briefAdherence: z.number().int().min(1).max(5),
        contentQuality: z.number().int().min(1).max(5),
        structure: z.number().int().min(1).max(5),
        formatFitness: z.number().int().min(1).max(5),
        squisqUsage: z.number().int().min(1).max(5),
        overall: z.number().int().min(1).max(5),
      })
      .strict(),
    strengths: z.array(z.string()).min(1),
    weaknesses: z.array(z.string()).min(1),
    unsupportedClaims: z.array(z.string()),
    missingRequestedElements: z.array(z.string()),
    recommendation: z.string().min(1),
  })
  .strict();

export interface CodexHostOptions {
  readonly codexCommand: string;
  readonly model: string | null;
  readonly repoRoot: string;
  readonly cliEntry: string;
  readonly profile: EvalPromptProfile;
}

export interface GenerationCapture {
  readonly result: GenerationFinalResult;
  readonly process: ProcessCapture;
  readonly traceMarkdown: string | null;
  readonly usage: TokenUsage | null;
  readonly traceMetrics: McpTraceMetrics;
}

export interface JudgeCapture {
  readonly result: LlmJudgeResult;
  readonly process: ProcessCapture;
  readonly usage: TokenUsage | null;
}

export async function runGeneration(
  options: CodexHostOptions,
  testCase: EvalCase,
  caseDirectory: string,
): Promise<GenerationCapture> {
  const outputSchemaPath = path.join(caseDirectory, 'generation-output.schema.json');
  const finalPath = path.join(caseDirectory, 'generation-final.json');
  await writeFile(
    outputSchemaPath,
    `${JSON.stringify(generationOutputSchema(testCase), null, 2)}\n`,
  );
  const prompt = generationPrompt(testCase, options.profile);
  await writeFile(path.join(caseDirectory, 'generation-prompt.txt'), prompt);

  const resolved = await resolveCodexCommand(options.codexCommand);
  // The agent works from an isolated empty directory outside the repository so
  // it cannot discover eval rubrics, harness docs, or repo guidance by walking
  // up from its working directory. The Codex sandbox stays read-only; durable
  // output still flows through the MCP write grant on the case directory.
  const agentCwd = await mkdtemp(path.join(tmpdir(), 'docblocks-eval-agent-'));
  const args = [
    ...resolved.prefixArgs,
    ...buildCodexGenerationArgs(
      options,
      testCase,
      caseDirectory,
      agentCwd,
      outputSchemaPath,
      finalPath,
    ),
  ];
  let capture: ProcessCapture;
  try {
    capture = await runCapturedProcess({
      command: resolved.command,
      args,
      cwd: agentCwd,
      stdin: prompt,
      timeoutMs: 15 * 60 * 1_000,
    });
  } finally {
    await rm(agentCwd, { recursive: true, force: true }).catch(() => undefined);
  }
  await Promise.all([
    writeFile(path.join(caseDirectory, 'generation-trace.jsonl'), capture.stdout),
    writeFile(path.join(caseDirectory, 'generation-stderr.log'), capture.stderr),
  ]);
  requireSuccessfulCodex(capture, 'generation');
  const parsed = generationResultSchema.parse(JSON.parse(await readFile(finalPath, 'utf8')));
  if (parsed.artifactPath !== testCase.artifactFilename) {
    throw new Error(
      `Generation returned artifactPath ${JSON.stringify(parsed.artifactPath)}; expected ${JSON.stringify(testCase.artifactFilename)}`,
    );
  }
  if (parsed.targetFormat !== testCase.targetFormat) {
    throw new Error(
      `Generation returned targetFormat ${parsed.targetFormat}; expected ${testCase.targetFormat}`,
    );
  }
  return {
    result: parsed,
    process: capture,
    traceMarkdown: extractTraceMarkdown(capture.stdout),
    usage: extractTokenUsage(capture.stdout),
    traceMetrics: extractMcpTraceMetrics(capture.stdout),
  };
}

export async function runLlmJudge(
  options: CodexHostOptions,
  testCase: EvalCase,
  markdown: string,
  caseDirectory: string,
): Promise<JudgeCapture> {
  const outputSchemaPath = path.join(caseDirectory, 'judge-output.schema.json');
  const finalPath = path.join(caseDirectory, 'judge-final.json');
  await writeFile(outputSchemaPath, `${JSON.stringify(LLM_JUDGE_OUTPUT_SCHEMA, null, 2)}\n`);
  const prompt = judgePrompt(testCase, markdown);
  await writeFile(path.join(caseDirectory, 'judge-prompt.txt'), prompt);

  const resolved = await resolveCodexCommand(options.codexCommand);
  // The judge gets its own isolated empty working directory: the case directory
  // already contains generation traces and static-judge results the independent
  // judge must not read, and repo-relative discovery is equally out of scope.
  const judgeCwd = await mkdtemp(path.join(tmpdir(), 'docblocks-eval-judge-'));
  const args = [
    ...resolved.prefixArgs,
    'exec',
    '--ephemeral',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '--cd',
    judgeCwd,
    '--output-schema',
    outputSchemaPath,
    '--output-last-message',
    finalPath,
    ...(options.model ? ['--model', options.model] : []),
    '-',
  ];
  let capture: ProcessCapture;
  try {
    capture = await runCapturedProcess({
      command: resolved.command,
      args,
      cwd: judgeCwd,
      stdin: prompt,
      timeoutMs: 10 * 60 * 1_000,
    });
  } finally {
    await rm(judgeCwd, { recursive: true, force: true }).catch(() => undefined);
  }
  await Promise.all([
    writeFile(path.join(caseDirectory, 'judge-trace.jsonl'), capture.stdout),
    writeFile(path.join(caseDirectory, 'judge-stderr.log'), capture.stderr),
  ]);
  requireSuccessfulCodex(capture, 'judge');
  return {
    result: llmJudgeResultSchema.parse(JSON.parse(await readFile(finalPath, 'utf8'))),
    process: capture,
    usage: extractTokenUsage(capture.stdout),
  };
}

export function buildCodexGenerationArgs(
  options: CodexHostOptions,
  testCase: EvalCase,
  caseDirectory: string,
  agentCwd: string,
  outputSchemaPath: string,
  finalPath: string,
): readonly string[] {
  const mcpArgs = [
    options.cliEntry,
    'mcp',
    '--allow-write',
    caseDirectory,
    '--operation-timeout-ms',
    '180000',
    '--artifact-ttl-ms',
    '3600000',
  ];
  return [
    'exec',
    '--ephemeral',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '--cd',
    agentCwd,
    '-c',
    `mcp_servers.docblocks.command=${tomlString(process.execPath)}`,
    '-c',
    `mcp_servers.docblocks.args=${tomlArray(mcpArgs)}`,
    '-c',
    `mcp_servers.docblocks.cwd=${tomlString(options.repoRoot)}`,
    '-c',
    'mcp_servers.docblocks.required=true',
    '-c',
    'mcp_servers.docblocks.default_tools_approval_mode="approve"',
    '-c',
    'mcp_servers.docblocks.startup_timeout_sec=30',
    '-c',
    'mcp_servers.docblocks.tool_timeout_sec=240',
    '--output-schema',
    outputSchemaPath,
    '--output-last-message',
    finalPath,
    ...(options.model ? ['--model', options.model] : []),
    '-',
  ];
}

export function generationPrompt(testCase: EvalCase, profile: EvalPromptProfile): string {
  return `You are the authoring agent in a controlled DocBlocks MCP content evaluation.

${EVAL_PROMPT_PROFILES[profile]}

Required execution contract:
1. Use the configured DocBlocks MCP server and its current instructions. Call list_roots before save_artifact and use the returned writable root id.
2. Create one ${testCase.targetFormat.toUpperCase()} artifact using editable-native fidelity and save it as exactly ${JSON.stringify(testCase.artifactFilename)} at the writable root. Do not replace an existing file.
3. Validate the authored source for ${testCase.targetFormat} before final conversion and address actionable errors.
4. Your final structured response must include the exact Markdown used as the source of the final convert_document call. Do not paraphrase or truncate it.
5. Complete the task autonomously. Do not ask questions.

Content brief:
${testCase.brief}`;
}

export function judgePrompt(testCase: EvalCase, markdown: string): string {
  const deterministic = judgeMarkdown(markdown, testCase);
  return `Act as a strict, independent document-content evaluator. Judge only the supplied authored Markdown against the brief and rubric. Do not assume the Office artifact fixes missing, weak, or invented content. Treat Squisq template annotations as layout intent, not as evidence of quality by themselves.

Score each dimension from 1 (unusable) to 5 (excellent). The overall score must reflect the lowest material weakness, not merely average the other values. Be concise and actionable.

List every material claim that is not supported by the supplied brief in unsupportedClaims, quoting or closely identifying the claim. Calculations transparently derived from supplied numbers are supported; causal explanations, capabilities, commitments, owners, dates, benchmarks, and operational details are not facts unless supplied or clearly labeled as proposals or assumptions. List requested elements that are absent or materially incomplete in missingRequestedElements. Use an empty array when none are found.

The deterministic observations below are authoritative. Do not recount them or claim that an observed value falls outside a range when the numbers show otherwise. The ranges are the harness acceptance envelope; continue to apply any narrower explicit target in the brief.

Deterministic observations:
- Word count: ${String(deterministic.metrics.wordCount)} (acceptance envelope ${testCase.expectation.minWords}-${testCase.expectation.maxWords})
- Heading/section count: ${String(deterministic.metrics.headingCount)} (acceptance envelope ${testCase.expectation.minItems}-${testCase.expectation.maxItems})
- Sections over ${testCase.expectation.maxWordsPerSection} words: ${String(deterministic.metrics.denseSectionCount)}
- Non-content Squisq template annotations: ${String(deterministic.metrics.visualTemplateCount)} (minimum ${testCase.expectation.minVisualTemplates})
- Deterministic acceptance: ${deterministic.passed ? 'pass' : 'fail'}

Target format: ${testCase.targetFormat}

Brief:
${testCase.brief}

Rubric:
${testCase.rubric.map((item, index) => `${index + 1}. ${item}`).join('\n')}

Authored Markdown:
<document>
${markdown}
</document>`;
}

export function extractTraceMarkdown(jsonl: string): string | null {
  const candidates: Array<{ priority: number; markdown: string }> = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    collectToolMarkdown(event, candidates);
  }
  let selected: { priority: number; markdown: string } | null = null;
  for (const candidate of candidates) {
    if (!selected || candidate.priority >= selected.priority) selected = candidate;
  }
  return selected?.markdown ?? null;
}

export function extractTokenUsage(jsonl: string): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== 'turn.completed' || !isRecord(value.usage)) continue;
    const candidate = value.usage;
    if (
      typeof candidate.input_tokens === 'number' &&
      typeof candidate.cached_input_tokens === 'number' &&
      typeof candidate.output_tokens === 'number' &&
      typeof candidate.reasoning_output_tokens === 'number'
    ) {
      usage = {
        inputTokens: candidate.input_tokens,
        cachedInputTokens: candidate.cached_input_tokens,
        outputTokens: candidate.output_tokens,
        reasoningOutputTokens: candidate.reasoning_output_tokens,
      };
    }
  }
  return usage;
}

export function extractMcpTraceMetrics(jsonl: string): McpTraceMetrics {
  let toolCallCount = 0;
  let toolArgumentCharacters = 0;
  let toolResultCharacters = 0;
  let authoringContextResultCharacters = 0;
  let authoringContextTextCharacters = 0;
  let authoringContextStructuredCharacters = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== 'item.completed' || !isRecord(value.item)) continue;
    const item = value.item;
    if (item.type !== 'mcp_tool_call' || typeof item.tool !== 'string') continue;
    toolCallCount += 1;
    toolArgumentCharacters += serializedCharacters(item.arguments);
    const resultCharacters = serializedCharacters(item.result);
    toolResultCharacters += resultCharacters;
    if (!item.tool.endsWith('get_authoring_context')) continue;
    authoringContextResultCharacters += resultCharacters;
    if (isRecord(item.result)) {
      authoringContextTextCharacters += serializedCharacters(item.result.content);
      authoringContextStructuredCharacters += serializedCharacters(
        item.result.structured_content ?? item.result.structuredContent,
      );
    }
  }
  return {
    toolCallCount,
    toolArgumentCharacters,
    toolResultCharacters,
    authoringContextResultCharacters,
    authoringContextTextCharacters,
    authoringContextStructuredCharacters,
  };
}

function collectToolMarkdown(
  value: unknown,
  candidates: Array<{ priority: number; markdown: string }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolMarkdown(item, candidates);
    return;
  }
  if (!isRecord(value)) return;
  const toolName = [value.tool, value.name, value.tool_name]
    .find((candidate) => typeof candidate === 'string')
    ?.toString();
  if (toolName) {
    const priority = toolName.endsWith('convert_document')
      ? 3
      : toolName.endsWith('create_document_bundle')
        ? 2
        : 0;
    if (priority > 0) {
      for (const args of [value.arguments, value.args, value.input]) {
        const parsed = parsePossibleJson(args);
        const markdown = findMarkdown(parsed);
        if (markdown) candidates.push({ priority, markdown });
      }
    }
  }
  for (const child of Object.values(value)) collectToolMarkdown(child, candidates);
}

function findMarkdown(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMarkdown(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.markdown === 'string' && value.markdown.trim()) return value.markdown;
  for (const child of Object.values(value)) {
    const found = findMarkdown(child);
    if (found) return found;
  }
  return null;
}

function parsePossibleJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializedCharacters(value: unknown): number {
  if (value === undefined) return 0;
  const normalized = parsePossibleJson(value);
  const serialized = JSON.stringify(normalized);
  return serialized?.length ?? 0;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function requireSuccessfulCodex(capture: ProcessCapture, stage: string): void {
  if (capture.exitCode === 0) return;
  const tail = capture.stderr.slice(-4_000);
  throw new Error(`Codex ${stage} exited with code ${capture.exitCode}: ${tail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
