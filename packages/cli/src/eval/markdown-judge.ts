import type { EvalCase, EvalCheck, StaticJudgeResult } from './types.js';

const PLACEHOLDER_PATTERN = /\b(?:todo|tbd|lorem ipsum|insert (?:text|chart|image)|placeholder)\b/i;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/gm;
const TEMPLATE_PATTERN = /\{\[([A-Za-z0-9_-]+)/g;

export function judgeMarkdown(markdown: string, testCase: EvalCase): StaticJudgeResult {
  const words = countWords(markdown);
  const sections = markdownSections(markdown);
  const headings = [...markdown.matchAll(HEADING_PATTERN)];
  const templates = [...markdown.matchAll(TEMPLATE_PATTERN)].map((match) => match[1]);
  const visualTemplates = templates.filter((template) => template !== 'content');
  const denseSections = sections.filter(
    (section) => countWords(section.body) > testCase.expectation.maxWordsPerSection,
  );
  const checks: EvalCheck[] = [
    rangeCheck(
      'word-count',
      words,
      testCase.expectation.minWords,
      testCase.expectation.maxWords,
      true,
      'Markdown word count',
    ),
    rangeCheck(
      'section-count',
      headings.length,
      testCase.expectation.minItems,
      testCase.expectation.maxItems,
      true,
      testCase.targetFormat === 'pptx' ? 'Authored slide sections' : 'Document sections',
    ),
    {
      id: 'section-density',
      passed: denseSections.length === 0,
      required: true,
      message:
        denseSections.length === 0
          ? 'Every section stays within the format-specific density budget'
          : `${denseSections.length} sections exceed ${testCase.expectation.maxWordsPerSection} words`,
      observed: denseSections.length,
      expected: 0,
    },
    {
      id: 'visual-template-use',
      passed: visualTemplates.length >= testCase.expectation.minVisualTemplates,
      required: testCase.expectation.minVisualTemplates > 0,
      message: `${visualTemplates.length} non-content Squisq template annotations found`,
      observed: visualTemplates.length,
      expected: testCase.expectation.minVisualTemplates,
    },
    {
      id: 'no-placeholders',
      passed: !PLACEHOLDER_PATTERN.test(markdown),
      required: true,
      message: PLACEHOLDER_PATTERN.test(markdown)
        ? 'Draft contains placeholder language'
        : 'Draft contains no placeholder language',
      observed: PLACEHOLDER_PATTERN.test(markdown),
      expected: false,
    },
    ...testCase.expectation.requiredPhrases.map((phrase) => ({
      id: `required-phrase:${phrase.toLowerCase()}`,
      passed: markdown.toLowerCase().includes(phrase.toLowerCase()),
      required: true,
      message: `Required brief fact ${JSON.stringify(phrase)} is ${markdown.toLowerCase().includes(phrase.toLowerCase()) ? 'present' : 'missing'}`,
      observed: markdown.toLowerCase().includes(phrase.toLowerCase()),
      expected: true,
    })),
  ];

  return summarizeChecks(checks, {
    wordCount: words,
    headingCount: headings.length,
    templateAnnotationCount: templates.length,
    visualTemplateCount: visualTemplates.length,
    denseSectionCount: denseSections.length,
  });
}

export function countWords(value: string): number {
  return value.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
}

function markdownSections(markdown: string): readonly { heading: string; body: string }[] {
  const matches = [...markdown.matchAll(HEADING_PATTERN)];
  return matches.map((match, index) => ({
    heading: match[2],
    body: markdown.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index),
  }));
}

function rangeCheck(
  id: string,
  observed: number,
  minimum: number,
  maximum: number,
  required: boolean,
  label: string,
): EvalCheck {
  const passed = observed >= minimum && observed <= maximum;
  return {
    id,
    passed,
    required,
    message: `${label}: ${observed}; expected ${minimum}-${maximum}`,
    observed,
    expected: `${minimum}-${maximum}`,
  };
}

export function summarizeChecks(
  checks: readonly EvalCheck[],
  metrics: Readonly<Record<string, number | string | boolean | null>>,
): StaticJudgeResult {
  const score =
    checks.length === 0
      ? 0
      : Math.round((checks.filter((check) => check.passed).length / checks.length) * 1000) / 10;
  return {
    score,
    passed: checks.every((check) => !check.required || check.passed),
    checks,
    metrics,
  };
}
