/**
 * Writing tasks: the AI draft dialog, headless.
 *
 * - **Compose from scratch**: new content for an empty document.
 * - **Append** and **insert**: new content for an existing document. The
 *   product asks for "Markdown to insert at the current cursor" but never
 *   shows the model where the cursor is, so these cases name the place in
 *   the instructions, as a person would; the judge reads the result spliced
 *   in where it would go.
 * - **Rewrite**: a selection rewritten to an instruction; only the selection
 *   is sent.
 *
 * Requests come from the product's `buildDraftRequest`, replies are settled
 * by its `runDraft` (one Continue when a draft stops at the limit, as a
 * person would press), and the text checked is what Insert or Replace would
 * put into the document. Deterministic checks cover what can be counted:
 * length, structure, required facts kept, no preamble, no repeated document
 * text, and the desktop's own fact check for details no source shows.
 */

import { buildDraftRequest, runDraft } from '@bendyline/docblocks-react/ai';
import type { BenchCaseInfo, BenchCheck, BenchJudgeSpec } from '../contract.js';
import { readFixture, readFixtureJson } from '../fixtures.js';
import { unsourcedDetails } from '../grounding.js';
import { check, shareCheck, type BenchTask, type TaskCaseResult } from './types.js';

type WritingMode = 'compose' | 'append' | 'insert' | 'rewrite';

interface Expectations {
  readonly minWords?: number;
  readonly maxWords?: number;
  readonly structure?: readonly ('heading' | 'list' | 'table')[];
  readonly noList?: boolean;
  readonly mustInclude?: readonly string[];
  readonly mustExclude?: readonly string[];
  /** Rewrite: output words over selection words. */
  readonly minRatio?: number;
  readonly maxRatio?: number;
  /** Rewrite: every number in the selection survives. */
  readonly keepNumbers?: boolean;
  /** Rewrite: share of the selection's words still present. */
  readonly minOverlap?: number;
}

interface WritingCaseFile {
  readonly id: string;
  readonly instructions: string;
  readonly document?: string;
  readonly after?: string;
  readonly selection?: string;
  readonly expect: Expectations;
}

interface WritingCase extends BenchCaseInfo {
  readonly mode: WritingMode;
  readonly spec: WritingCaseFile;
}

export const WRITING_RUBRIC: BenchJudgeSpec = {
  rubricId: 'writing@1',
  mode: 'rubric',
  instructions:
    "A writing assistant inside a document editor was given a person's instructions and, for new " +
    'content in an existing document, the document; for a rewrite, only the selected passage. Its output ' +
    'is shown below. Where it adds to a document, the document is shown with the output in place between ' +
    '<<<INSERTED>>> and <<<END INSERTED>>> markers, where the person wanted it. Every specific fact the ' +
    'output needs is in the instructions or the document; anything else specific (a name, number, date, ' +
    'price, quotation) was invented.',
  axes: [
    {
      id: 'instructions',
      label: 'Follows instructions',
      description:
        'Does exactly what was asked: the content, the length, the format and, for new content, the place.',
    },
    {
      id: 'faithfulness',
      label: 'Faithful',
      description:
        'Every specific comes from the instructions or the document and nothing contradicts them; a rewrite keeps the meaning, facts and tone the instructions did not ask to change.',
    },
    {
      id: 'fit',
      label: 'Fits',
      description:
        "New content in a document matches the document's voice, format and level of detail, reads naturally where it is placed, and does not repeat what the document already says. Content from scratch is organized the way a reader of that kind of document expects.",
    },
    {
      id: 'quality',
      label: 'Quality',
      description:
        'Clear, correct, well-organized prose a careful writer would keep with light edits; no filler, no preamble or commentary to the person.',
    },
  ],
};

const PREAMBLE =
  /^(?:here(?:'s| is| are)\b|sure\b|certainly\b|of course\b|below is\b|i(?:'ve| have) (?:written|drafted|added|rewritten)|okay\b|ok,)/iu;
const SIGN_OFF = /(?:let me know|hope this helps|feel free to)/iu;

function words(text: string): number {
  return text
    .replace(/[#>*_`|[\]()-]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function hasHeading(text: string): boolean {
  return /^#{1,6}\s+\S/mu.test(text);
}

function hasList(text: string): boolean {
  return /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/mu.test(text);
}

function hasTable(text: string): boolean {
  return /^\s*\|.*\|\s*$/mu.test(text) && /^\s*\|?\s*:?-{3,}/mu.test(text);
}

function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,:]\d+)*/gu)].map((match) => match[0]);
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
}

/** Lines of the document a draft repeated word for word: content it was told not to repeat. */
function repeatedLines(output: string, document: string): string[] {
  return document
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 40 && !/^#/u.test(line) && output.includes(line));
}

function expectationChecks(output: string, expect: Expectations, selection?: string): BenchCheck[] {
  const checks: BenchCheck[] = [];
  const count = words(output);
  if (expect.minWords !== undefined || expect.maxWords !== undefined) {
    checks.push(
      check(
        'length',
        `Length within ${String(expect.minWords ?? 0)}–${String(expect.maxWords ?? '∞')} words`,
        count >= (expect.minWords ?? 0) && count <= (expect.maxWords ?? Number.POSITIVE_INFINITY),
        1,
        `${String(count)} words`,
      ),
    );
  }
  for (const kind of expect.structure ?? []) {
    const present =
      kind === 'heading'
        ? hasHeading(output)
        : kind === 'list'
          ? hasList(output)
          : hasTable(output);
    checks.push(check(`has-${kind}`, `Uses a ${kind}`, present));
  }
  if (expect.noList)
    checks.push(check('no-list', 'Prose, no bullet or numbered list', !hasList(output)));
  if (expect.mustInclude?.length) {
    const lower = output.toLowerCase();
    checks.push(
      shareCheck(
        'keeps-facts',
        'Includes the facts it was given',
        expect.mustInclude.filter((item) => lower.includes(item.toLowerCase())).length,
        expect.mustInclude.length,
        2,
      ),
    );
  }
  if (expect.mustExclude?.length) {
    checks.push(
      shareCheck(
        'fixed',
        'Fixed the errors it was asked to fix',
        expect.mustExclude.filter((item) => !output.includes(item)).length,
        expect.mustExclude.length,
        2,
      ),
    );
  }
  if (selection !== undefined) {
    const ratio = count / Math.max(1, words(selection));
    if (expect.minRatio !== undefined || expect.maxRatio !== undefined) {
      checks.push(
        check(
          'ratio',
          `Length ${String(expect.minRatio ?? 0)}–${String(expect.maxRatio ?? '∞')}× the selection`,
          ratio >= (expect.minRatio ?? 0) && ratio <= (expect.maxRatio ?? Number.POSITIVE_INFINITY),
          1,
          `${ratio.toFixed(2)}×`,
        ),
      );
    }
    if (expect.keepNumbers) {
      const numbers = numbersIn(selection);
      checks.push(
        shareCheck(
          'keeps-numbers',
          'Keeps every number in the selection',
          numbers.filter((number) => output.includes(number)).length,
          numbers.length,
          2,
        ),
      );
    }
    if (expect.minOverlap !== undefined) {
      const source = wordSet(selection);
      const kept = wordSet(output);
      const overlap =
        [...source].filter((word) => kept.has(word)).length / Math.max(1, source.size);
      checks.push(
        check(
          'unchanged-otherwise',
          'Changes nothing it was not asked to',
          overlap >= expect.minOverlap,
          1,
          `${Math.round(overlap * 100)}% of words kept`,
        ),
      );
    }
  }
  return checks;
}

function placed(document: string, output: string, after: string | undefined): string {
  const marked = `<<<INSERTED>>>\n${output}\n<<<END INSERTED>>>`;
  if (after === undefined) return `${document.trimEnd()}\n\n${marked}\n`;
  const at = document.indexOf(after) + after.length;
  return `${document.slice(0, at)}\n\n${marked}\n${document.slice(at)}`;
}

function loadCases(mode: WritingMode): WritingCase[] {
  const file = readFixtureJson<Record<WritingMode, WritingCaseFile[]>>('writing', 'cases.json');
  return file[mode].map((spec) => ({
    id: spec.id,
    label: spec.id.replace(/-/gu, ' '),
    mode,
    spec,
  }));
}

function writingTask(
  mode: WritingMode,
  label: string,
  description: string,
  trials: number,
): BenchTask<WritingCase> {
  let cached: WritingCase[] | null = null;
  return {
    info: {
      id: `write-${mode}`,
      family: 'writing',
      label,
      description,
      trials,
      scoring: { checks: 0.3, judge: 0.7 },
      judge: WRITING_RUBRIC,
    },
    cases: () => (cached ??= loadCases(mode)),
    async run(testCase, context): Promise<TaskCaseResult> {
      const { spec } = testCase;
      const document = spec.document ? readFixture('writing', 'docs', spec.document) : '';
      const selection = mode === 'rewrite' ? (spec.selection ?? '') : '';
      const request = buildDraftRequest({
        mode: mode === 'rewrite' ? 'rewrite' : 'compose',
        instructions: spec.instructions,
        documentSource: mode === 'rewrite' ? selection : document,
        selectedText: selection,
      });
      const result = await runDraft(
        context.ai,
        request,
        mode === 'rewrite' ? selection : document,
        mode === 'rewrite' ? 'rewrite' : 'compose',
        {
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
      const output = result.text.trim();
      const usable = result.error === null && output.length > 0;
      const given = `${spec.instructions}\n\n${mode === 'rewrite' ? selection : document}`;
      const facts = usable ? unsourcedDetails(output, given) : null;
      const lines = output.split('\n').filter((line) => line.trim());
      const repeated =
        mode === 'append' || mode === 'insert' ? repeatedLines(output, document) : [];
      const notes = [
        `${String(words(output))} words in ${String(result.requests)} requests${result.continuations ? ` (${String(result.continuations)} continued)` : ''}`,
        ...(facts && facts.strong.length > 0
          ? [`Details no source shows: ${facts.strong.slice(0, 8).join(', ')}`]
          : []),
        ...(repeated.length > 0
          ? [`Repeated ${String(repeated.length)} lines of the document`]
          : []),
      ];
      if (!usable) {
        const message = result.error ?? 'The draft was empty.';
        return {
          usable: false,
          modelError: message,
          checks: [check('drafted', 'A draft Insert or Replace could use', false, 2, message)],
          artifact: output ? { kind: 'markdown', content: output } : null,
          judgeInput: null,
          notes,
        };
      }
      const judgeContext =
        mode === 'rewrite'
          ? `Instructions: ${spec.instructions}\n\nThe selected passage:\n<selection>\n${selection}\n</selection>`
          : mode === 'compose'
            ? `Instructions: ${spec.instructions}\n\nThe document was empty: this is new content.`
            : `Instructions: ${spec.instructions}\n\nThe document with the output in place:\n<document>\n` +
              `${placed(document, output, mode === 'insert' ? spec.after : undefined)}</document>`;
      return {
        usable: true,
        checks: [
          check('drafted', 'A draft Insert or Replace could use', true, 2),
          check(
            'finished',
            'Finished without stopping at the limit',
            result.finished,
            1,
            result.continuations ? 'needed Continue' : undefined,
          ),
          check(
            'no-chatter',
            'No preamble or sign-off addressed to the person',
            !PREAMBLE.test(lines[0] ?? '') && !SIGN_OFF.test(lines.at(-1) ?? ''),
          ),
          ...(mode === 'append' || mode === 'insert'
            ? [check('no-repeat', 'Does not repeat the document', repeated.length === 0)]
            : []),
          check(
            'sourced',
            'No number, date or quotation that no source shows',
            (facts?.strong.length ?? 0) === 0,
            2,
            facts?.strong.slice(0, 6).join(', ') || undefined,
          ),
          ...expectationChecks(output, spec.expect, mode === 'rewrite' ? selection : undefined),
        ],
        artifact: { kind: 'markdown', content: output },
        judgeInput: { rubricId: WRITING_RUBRIC.rubricId, context: judgeContext },
        notes,
      };
    },
  };
}

export const composeTask = writingTask(
  'compose',
  'Compose from scratch',
  'The draft dialog in an empty document: new content from instructions alone.',
  3,
);
export const appendTask = writingTask(
  'append',
  'Append to a document',
  'The draft dialog in an existing document: a new section or entries at the end.',
  3,
);
export const insertTask = writingTask(
  'insert',
  'Insert into a document',
  'The draft dialog in an existing document: new content for a named place in the middle.',
  3,
);
export const rewriteTask = writingTask(
  'rewrite',
  'Rewrite a selection',
  'The draft dialog on a selection: shorten, formalize, fix grammar, turn bullets into prose, simplify, soften.',
  1,
);
