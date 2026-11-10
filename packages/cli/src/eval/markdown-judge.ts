import { flattenBlocks, markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { CONCEPT_TEMPLATES } from '@bendyline/squisq/transform';
import type { EvalCase, EvalCheck, StaticJudgeResult } from './types.js';

const PLACEHOLDER_PATTERN = /\b(?:todo|tbd|lorem ipsum|insert (?:text|chart|image)|placeholder)\b/i;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/gm;
const TEMPLATE_PATTERN = /\{\[([A-Za-z0-9_-]+)/g;

/** Templates that show a section's words as written rather than drawing them. */
const PLAIN_TEMPLATES: ReadonlySet<string> = new Set([
  'sectionHeader',
  'content',
  'title',
  'list',
  'bigText',
]);

/**
 * The templates the linked Squisq gives each section, annotated or not.
 * convert_document draws a list, a table or a figure as a picture without an
 * annotation, so counting `{[…]}` alone misses most of what a deck shows.
 */
export function drawnTemplates(markdown: string): { drawn: string[]; lists: string[] } {
  try {
    const doc = markdownToDoc(parseMarkdown(markdown), { generateCoverBlock: false });
    const drawn = flattenBlocks(doc.blocks)
      .map((block) => block.template ?? '')
      .filter((template) => template && !PLAIN_TEMPLATES.has(template));
    return {
      drawn,
      lists: drawn.filter((template) =>
        (CONCEPT_TEMPLATES as readonly string[]).includes(template),
      ),
    };
  } catch {
    return { drawn: [], lists: [] };
  }
}

export function judgeMarkdown(markdown: string, testCase: EvalCase): StaticJudgeResult {
  const words = countWords(markdown);
  const sections = markdownSections(markdown, testCase.targetFormat === 'pptx' ? 1 : 6);
  const headings = [...markdown.matchAll(HEADING_PATTERN)];
  const templates = [...markdown.matchAll(TEMPLATE_PATTERN)].map((match) => match[1]);
  const visualTemplates = templates.filter((template) => template !== 'content');
  const pictures = drawnTemplates(markdown);
  const minDrawn = testCase.expectation.minDrawnSections ?? 0;
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
      sections.length,
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
      // Informative, never a gate: a deck can be right with few pictures.
      id: 'drawn-sections',
      passed: pictures.drawn.length >= minDrawn,
      required: false,
      message: `${pictures.drawn.length} sections are drawn as a picture (${pictures.lists.length} of them lists drawn as cards, a process, key numbers…)`,
      observed: pictures.drawn.length,
      expected: minDrawn,
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
    sectionCount: sections.length,
    templateAnnotationCount: templates.length,
    visualTemplateCount: visualTemplates.length,
    drawnSectionCount: pictures.drawn.length,
    drawnListCount: pictures.lists.length,
    denseSectionCount: denseSections.length,
  });
}

export function countWords(value: string): number {
  return value.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
}

function markdownSections(
  markdown: string,
  maxDepth = 6,
): readonly { heading: string; body: string }[] {
  const matches = [...markdown.matchAll(HEADING_PATTERN)].filter(
    (match) => match[1].length <= maxDepth,
  );
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
