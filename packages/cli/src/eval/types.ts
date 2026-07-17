export type EvalTargetFormat = 'pptx' | 'docx';

export type EvalSuite = 'quick' | 'full';

export type EvalJudgeMode = 'static' | 'both';

export type EvalPromptProfile = 'baseline' | 'content-first';

export interface EvalExpectation {
  readonly minItems: number;
  readonly maxItems: number;
  readonly minWords: number;
  readonly maxWords: number;
  readonly maxWordsPerSection: number;
  readonly minVisualTemplates: number;
  readonly requiredPhrases: readonly string[];
}

export interface EvalCase {
  readonly id: string;
  readonly title: string;
  readonly suites: readonly EvalSuite[];
  readonly targetFormat: EvalTargetFormat;
  readonly artifactFilename: string;
  readonly brief: string;
  readonly rubric: readonly string[];
  readonly expectation: EvalExpectation;
}

export interface EvalCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly required: boolean;
  readonly message: string;
  readonly observed: string | number | boolean | null;
  readonly expected: string | number | boolean | null;
}

export interface StaticJudgeResult {
  readonly score: number;
  readonly passed: boolean;
  readonly checks: readonly EvalCheck[];
  readonly metrics: Readonly<Record<string, number | string | boolean | null>>;
}

export interface LlmJudgeScores {
  readonly briefAdherence: number;
  readonly contentQuality: number;
  readonly structure: number;
  readonly formatFitness: number;
  readonly squisqUsage: number;
  readonly overall: number;
}

export interface LlmJudgeResult {
  readonly scores: LlmJudgeScores;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly unsupportedClaims: readonly string[];
  readonly missingRequestedElements: readonly string[];
  readonly recommendation: string;
}

export interface GenerationFinalResult {
  readonly artifactPath: string;
  readonly targetFormat: EvalTargetFormat;
  readonly fidelity: string;
  readonly markdown: string;
  readonly summary: string;
  readonly validationRepairs: readonly string[];
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface ProcessCapture {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface McpTraceMetrics {
  readonly toolCallCount: number;
  readonly toolArgumentCharacters: number;
  readonly toolResultCharacters: number;
  readonly authoringContextResultCharacters: number;
  readonly authoringContextTextCharacters: number;
  readonly authoringContextStructuredCharacters: number;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly title: string;
  readonly targetFormat: EvalTargetFormat;
  readonly passed: boolean;
  readonly score: number;
  readonly artifactScore: number;
  readonly markdownScore: number;
  readonly llmScore: number | null;
  readonly markdownSource: 'trace' | 'final-response';
  readonly traceMarkdownMatchesFinal: boolean | null;
  readonly artifactPath: string;
  readonly caseDirectory: string;
  readonly generationDurationMs: number;
  readonly judgeDurationMs: number | null;
  readonly generationUsage: TokenUsage | null;
  readonly judgeUsage: TokenUsage | null;
  readonly mcpTraceMetrics: McpTraceMetrics | null;
  readonly artifactJudge: StaticJudgeResult;
  readonly markdownJudge: StaticJudgeResult;
  readonly llmJudge: LlmJudgeResult | null;
  readonly failure: string | null;
}

export interface EvalRunProvenance {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly label: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly suite: string;
  readonly profile: EvalPromptProfile;
  readonly judgeMode: EvalJudgeMode;
  readonly threshold: number;
  readonly model: string | null;
  readonly codexCommand: string;
  readonly codexVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly gitCommit: string | null;
  readonly gitDirty: boolean | null;
  readonly cliEntry: string;
  readonly cliSha256: string;
  readonly promptProfileSha256: string;
  readonly judgeContractSha256: string;
}

export interface EvalRunResult {
  readonly provenance: EvalRunProvenance;
  readonly score: number;
  readonly passed: boolean;
  readonly cases: readonly EvalCaseResult[];
}

export interface EvalComparisonCase {
  readonly caseId: string;
  readonly baselineScore: number;
  readonly candidateScore: number;
  readonly delta: number;
  readonly baselinePassed: boolean;
  readonly candidatePassed: boolean;
}

export interface EvalRunMetrics {
  readonly generationDurationMs: number;
  readonly judgeDurationMs: number;
  readonly generationInputTokens: number;
  readonly generationCachedInputTokens: number;
  readonly generationUncachedInputTokens: number;
  readonly generationOutputTokens: number;
  readonly generationReasoningTokens: number;
  readonly judgeInputTokens: number;
  readonly judgeOutputTokens: number;
  readonly toolCallCount: number;
  readonly toolArgumentCharacters: number;
  readonly toolResultCharacters: number;
  readonly authoringContextResultCharacters: number;
  readonly authoringContextTextCharacters: number;
  readonly authoringContextStructuredCharacters: number;
}

export interface EvalComparison {
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly baselineScore: number;
  readonly candidateScore: number;
  readonly delta: number;
  readonly regressions: number;
  readonly improvements: number;
  readonly warnings: readonly string[];
  readonly baselineMetrics: EvalRunMetrics;
  readonly candidateMetrics: EvalRunMetrics;
  readonly cases: readonly EvalComparisonCase[];
}
