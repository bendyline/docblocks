import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import JSZip from 'jszip';
import { judgeArtifact } from '../src/eval/artifact-judge.js';
import { MCP_CONTENT_EVAL_CASES, selectEvalCases } from '../src/eval/cases.js';
import {
  buildCodexGenerationArgs,
  extractMcpTraceMetrics,
  extractTokenUsage,
  extractTraceMarkdown,
  judgePrompt,
} from '../src/eval/codex-host.js';
import { judgeMarkdown } from '../src/eval/markdown-judge.js';
import { compareEvalRuns } from '../src/eval/report.js';
import { combinedScore, scoreLlmJudge } from '../src/eval/runner.js';
import type { EvalCase, EvalRunResult } from '../src/eval/types.js';

describe('MCP content eval harness', () => {
  it('selects stable quick and explicit case suites', () => {
    expect(selectEvalCases('quick').map((testCase) => testCase.id)).to.deep.equal([
      'quarterly-product-review-pptx',
      'build-vs-buy-decision-memo-docx',
    ]);
    expect(selectEvalCases('incident-response-playbook-docx')).to.have.length(1);
    expect(() => selectEvalCases('missing-case')).to.throw('Unknown eval case ids');
  });

  it('scores Markdown structure, facts, density, and visual template use', () => {
    const testCase: EvalCase = {
      id: 'test',
      title: 'Test',
      suites: ['quick'],
      targetFormat: 'pptx',
      artifactFilename: 'test.pptx',
      brief: 'Test brief',
      rubric: ['Clear'],
      expectation: {
        minItems: 2,
        maxItems: 2,
        minWords: 8,
        maxWords: 40,
        maxWordsPerSection: 20,
        minVisualTemplates: 1,
        requiredPhrases: ['42%'],
      },
    };
    const result = judgeMarkdown(
      '# Thesis {[titleSlide]}\n\nA concise opening with 42% growth.\n\n## Decision\n\nChoose the focused path now.',
      testCase,
    );
    expect(result.passed).to.equal(true);
    expect(result.metrics.visualTemplateCount).to.equal(1);
  });

  it('extracts the exact final conversion Markdown and usage from Codex JSONL', () => {
    const jsonl = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          tool: 'docblocks.get_authoring_context',
          arguments: { targetFormat: 'pptx' },
          result: {
            content: [{ type: 'text', text: 'Compact context' }],
            structured_content: { kind: 'success', result: { templates: [] } },
          },
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          tool: 'docblocks.convert_document',
          arguments: JSON.stringify({ source: { kind: 'markdown', markdown: '# Final' } }),
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      }),
    ].join('\n');
    expect(extractTraceMarkdown(jsonl)).to.equal('# Final');
    expect(extractTokenUsage(jsonl)).to.deep.equal({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 5,
    });
    expect(extractMcpTraceMetrics(jsonl)).to.deep.equal({
      toolCallCount: 2,
      toolArgumentCharacters: 74,
      toolResultCharacters: 120,
      authoringContextResultCharacters: 120,
      authoringContextTextCharacters: 42,
      authoringContextStructuredCharacters: 44,
    });
  });

  it('builds an isolated required local MCP configuration for Codex', () => {
    const testCase = MCP_CONTENT_EVAL_CASES[0];
    const args = buildCodexGenerationArgs(
      {
        codexCommand: 'codex',
        model: 'test-model',
        repoRoot: 'D:\\repo',
        cliEntry: 'D:\\repo\\packages\\cli\\dist\\bin.js',
        profile: 'baseline',
      },
      testCase,
      'D:\\run',
      'D:\\isolated-agent-cwd',
      'D:\\run\\schema.json',
      'D:\\run\\final.json',
    );
    expect(args).to.include('--ignore-user-config');
    expect(args).to.include('mcp_servers.docblocks.required=true');
    expect(args.join(' ')).to.include('--allow-write');
    expect(args.join(' ')).to.include('bin.js');
    expect(args.slice(-1)).to.deep.equal(['-']);
    const cdIndex = args.indexOf('--cd');
    expect(cdIndex).to.be.greaterThan(-1);
    expect(args[cdIndex + 1]).to.equal('D:\\isolated-agent-cwd');
    expect(args).to.not.include('D:\\run');
  });

  it('gives the LLM judge authoritative deterministic counts', () => {
    const testCase = MCP_CONTENT_EVAL_CASES[0];
    const markdown = '# Thesis {[content]}\n\nA concise opening thesis.';
    const deterministic = judgeMarkdown(markdown, testCase);
    const prompt = judgePrompt(testCase, markdown);
    expect(prompt).to.include('deterministic observations below are authoritative');
    expect(prompt).to.include(`Word count: ${String(deterministic.metrics.wordCount)}`);
    expect(prompt).to.include('Heading/section count: 1');
    expect(prompt).to.include(`acceptance envelope ${testCase.expectation.minWords}-`);
  });

  it('statically validates PPTX and DOCX package structure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'docblocks-eval-test-'));
    try {
      const pptxCase = MCP_CONTENT_EVAL_CASES.find(
        (testCase) => testCase.id === 'quarterly-product-review-pptx',
      );
      const docxCase = MCP_CONTENT_EVAL_CASES.find(
        (testCase) => testCase.id === 'build-vs-buy-decision-memo-docx',
      );
      if (!pptxCase || !docxCase) throw new Error('Missing canonical eval cases');
      const pptxPath = path.join(directory, 'test.pptx');
      const docxPath = path.join(directory, 'test.docx');
      await Promise.all([
        writeFile(pptxPath, await syntheticPptx()),
        writeFile(docxPath, await syntheticDocx()),
      ]);
      const [pptx, docx] = await Promise.all([
        judgeArtifact(pptxPath, pptxCase),
        judgeArtifact(docxPath, docxCase),
      ]);
      expect(pptx.passed, JSON.stringify(pptx.checks)).to.equal(true);
      expect(pptx.metrics.slideCount).to.equal(8);
      expect(docx.passed, JSON.stringify(docx.checks)).to.equal(true);
      expect(docx.metrics.extractableWordCount).to.be.greaterThan(800);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('weights deterministic and LLM scores and reports paired deltas', () => {
    const llmScore = scoreLlmJudge({
      scores: {
        briefAdherence: 5,
        contentQuality: 4,
        structure: 4,
        formatFitness: 4,
        squisqUsage: 3,
        overall: 4,
      },
      strengths: ['Good'],
      weaknesses: ['Improve visuals'],
      unsupportedClaims: [],
      missingRequestedElements: [],
      recommendation: 'Iterate',
    });
    expect(llmScore).to.equal(80);
    expect(combinedScore(100, 80, llmScore)).to.equal(87);

    expect(
      scoreLlmJudge({
        scores: {
          briefAdherence: 5,
          contentQuality: 5,
          structure: 5,
          formatFitness: 5,
          squisqUsage: 5,
          overall: 5,
        },
        strengths: ['Polished'],
        weaknesses: ['Grounding'],
        unsupportedClaims: ['Claim one', 'Claim two'],
        missingRequestedElements: ['Missing request'],
        recommendation: 'Repair claims',
      }),
    ).to.equal(89);

    const baseline = fakeRun('baseline', 70);
    const candidate = fakeRun('candidate', 82);
    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.delta).to.equal(12);
    expect(comparison.improvements).to.equal(1);
    expect(comparison.regressions).to.equal(0);
    expect(comparison.warnings).to.include(
      'both runs use the mutable Codex default model; pin --model for launch decisions',
    );
    expect(comparison.candidateMetrics.generationInputTokens).to.equal(82_000);

    const regression = compareEvalRuns(fakeRun('baseline', 80), fakeRun('candidate', 79));
    expect(regression.regressions).to.equal(1);
  });
});

async function syntheticPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('ppt/presentation.xml', '<p:presentation/>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships/>');
  zip.file('ppt/theme/theme1.xml', '<a:theme/>');
  for (let index = 1; index <= 8; index += 1) {
    zip.file(
      `ppt/slides/slide${index}.xml`,
      `<p:sld><a:t>Slide ${index}</a:t><a:t>Useful decision content</a:t></p:sld>`,
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function syntheticDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/styles.xml', '<w:styles/>');
  const words = Array.from({ length: 900 }, (_value, index) => `word${index}`).join(' ');
  const paragraphs = Array.from(
    { length: 7 },
    (_value, index) =>
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${index === 0 ? words : `Section ${index}`}</w:t></w:r></w:p>`,
  ).join('');
  zip.file('word/document.xml', `<w:document><w:body>${paragraphs}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function fakeRun(runId: string, score: number): EvalRunResult {
  return {
    provenance: {
      schemaVersion: 1,
      runId,
      label: runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      suite: 'quick',
      profile: 'baseline',
      judgeMode: 'both',
      threshold: 70,
      model: null,
      codexCommand: 'codex',
      codexVersion: 'test',
      nodeVersion: process.version,
      platform: process.platform,
      gitCommit: null,
      gitDirty: null,
      cliEntry: 'bin.js',
      cliSha256: 'a',
      promptProfileSha256: 'b',
      judgeContractSha256: 'c',
    },
    score,
    passed: true,
    cases: [
      {
        caseId: 'case',
        title: 'Case',
        targetFormat: 'pptx',
        passed: true,
        score,
        artifactScore: score,
        markdownScore: score,
        llmScore: score,
        markdownSource: 'trace',
        traceMarkdownMatchesFinal: true,
        artifactPath: 'artifact.pptx',
        caseDirectory: 'case',
        generationDurationMs: 1,
        judgeDurationMs: 1,
        generationUsage: {
          inputTokens: score * 1_000,
          cachedInputTokens: score * 500,
          outputTokens: score * 10,
          reasoningOutputTokens: score,
        },
        judgeUsage: null,
        mcpTraceMetrics: {
          toolCallCount: 2,
          toolArgumentCharacters: score,
          toolResultCharacters: score * 10,
          authoringContextResultCharacters: score * 5,
          authoringContextTextCharacters: score * 3,
          authoringContextStructuredCharacters: score * 2,
        },
        artifactJudge: { score, passed: true, checks: [], metrics: {} },
        markdownJudge: { score, passed: true, checks: [], metrics: {} },
        llmJudge: null,
        failure: null,
      },
    ],
  };
}
