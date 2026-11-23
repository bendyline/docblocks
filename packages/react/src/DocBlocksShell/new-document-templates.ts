/**
 * new-document-templates — the starter documents the New document gallery
 * offers, and the name a new document starts with.
 *
 * Every document opens with its name as a `# Heading`, the way a blank
 * document always has: it is the cover slide, and the Word, PDF and web
 * title. The person names the document in the toolbar's title field straight
 * after, and the heading follows that name (see `NewDocumentCaret`).
 *
 * Each template is short, reads as an example of its kind, and is written so
 * Slideshow shows it well: one idea per heading, and a block annotation
 * where the automatic choice would not pick the best slide.
 */

import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { newFileName, type NewFileFormat } from '../FileExplorer/new-file-formats.js';
import { resolveOutsideInLayout } from './outside-in-contract.js';
import { providerEntryExists } from './provider-io.js';

export type NewDocumentTemplateId =
  | 'blank'
  | 'plan'
  | 'report'
  | 'meeting-notes'
  | 'lesson'
  | 'resume'
  | 'presentation'
  | 'budget';

export interface NewDocumentTemplate {
  id: NewDocumentTemplateId;
  /** The card's label. */
  label: string;
  /** One line under the label. */
  description: string;
  /** The document's first name, and its first heading. */
  name: string;
  /** Markdown under the heading. Empty for a blank document. */
  body: string;
  /**
   * Offered for an Excel workbook too. A workbook keeps only tables, so most
   * templates are not.
   */
  spreadsheet: boolean;
}

const lines = (...text: string[]): string => `${text.join('\n')}\n`;

export const NEW_DOCUMENT_TEMPLATES: readonly NewDocumentTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'An empty page with a title.',
    name: 'Untitled',
    body: '',
    spreadsheet: true,
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Goals, steps, owners and dates.',
    name: 'Project plan',
    spreadsheet: false,
    body: lines(
      'What this plan delivers, for whom, and by when, in one or two sentences.',
      '',
      '## Goals {[list]}',
      '',
      '- The outcome that matters most',
      '- A second outcome',
      '- How you will know it worked',
      '',
      '## Steps {[process]}',
      '',
      '1. Agree the scope with everyone involved',
      '2. Build a first version',
      '3. Try it with a small group',
      '4. Launch and measure',
      '',
      '## Who does what',
      '',
      '| Task | Owner | Due |',
      '| --- | --- | --- |',
      '| Agree the scope | Alex | 1 March |',
      '| First version | Sam | 15 March |',
      '| Launch | Priya | 1 April |',
      '',
      '## Risks',
      '',
      '- What could slip, and what you would do about it',
      '- What depends on people outside the team',
      '',
      '## Next steps',
      '',
      '- [ ] Share this plan',
      '- [ ] Book the first meeting',
      '- [ ] Set a date to check progress',
    ),
  },
  {
    id: 'report',
    label: 'Report',
    description: 'Findings, figures and a chart.',
    name: 'Report',
    spreadsheet: false,
    body: lines(
      'The findings in two or three sentences: what happened, why it matters, and what you recommend.',
      '',
      '## Key figures {[columnChart]}',
      '',
      '| Quarter | Revenue | Costs |',
      '| --- | ---: | ---: |',
      '| Q1 | 120 | 90 |',
      '| Q2 | 135 | 95 |',
      '| Q3 | 160 | 101 |',
      '| Q4 | 172 | 108 |',
      '',
      '## What we found',
      '',
      'Start with the most important finding. Edit the table above and the chart follows it.',
      '',
      '## Recommendations {[process]}',
      '',
      '1. The change to make first',
      '2. The change to make next',
      '3. How you will know it worked',
      '',
      '## Sources',
      '',
      'Where the figures came from, and anything else a careful reader will want.',
    ),
  },
  {
    id: 'meeting-notes',
    label: 'Meeting notes',
    description: 'Agenda, decisions and actions.',
    name: 'Meeting notes',
    spreadsheet: false,
    body: lines(
      'Date, place and who came.',
      '',
      '## Agenda {[list]}',
      '',
      '1. Updates',
      '2. The decision needed today',
      '3. Next steps',
      '',
      '## Discussion',
      '',
      'The main points, one short paragraph for each topic.',
      '',
      '## Decisions',
      '',
      '- What was decided, and why',
      '',
      '## Actions',
      '',
      '- [ ] What needs doing, who does it, and by when',
      '- [ ] What needs doing, who does it, and by when',
    ),
  },
  {
    id: 'lesson',
    label: 'Lesson',
    description: 'Aims, explanation and questions.',
    name: 'Lesson',
    spreadsheet: false,
    body: lines(
      'By the end of this lesson you will be able to explain the main idea in your own words.',
      '',
      '## What you will learn {[list]}',
      '',
      '- The main idea, in one sentence',
      '- Why it matters',
      '- How to use it',
      '',
      '## The main idea',
      '',
      'Explain the idea simply, with one example. A picture or a diagram from the **+** menu helps here.',
      '',
      '## Try it',
      '',
      'A short task that puts the idea to work.',
      '',
      '## Check your understanding',
      '',
      '1. A question about the main idea',
      '2. A question that asks for an example',
      '3. A question that asks why it matters',
      '',
      '## Summary',
      '',
      'The main idea again, in one or two sentences.',
    ),
  },
  {
    id: 'resume',
    label: 'Resume',
    description: 'Experience, education and skills.',
    name: 'Resume',
    spreadsheet: false,
    body: lines(
      'Email · Phone · City · Website',
      '',
      '## Summary',
      '',
      'Two or three sentences on what you do well and the role you want next.',
      '',
      '## Experience',
      '',
      '### Job title, Company',
      '',
      '*Start date to end date*',
      '',
      '- An achievement, with a number where you have one',
      '- Another achievement',
      '',
      '### Job title, Company',
      '',
      '*Start date to end date*',
      '',
      '- An achievement',
      '- Another achievement',
      '',
      '## Education',
      '',
      '### Qualification, School',
      '',
      '*Year*',
      '',
      '## Skills',
      '',
      '- A skill',
      '- A skill',
      '- A skill',
    ),
  },
  {
    id: 'presentation',
    label: 'Presentation',
    description: 'One idea per slide, ready to present.',
    name: 'Presentation',
    spreadsheet: false,
    body: lines(
      'The one thing your audience should remember.',
      '',
      '## The problem',
      '',
      'Describe the problem your audience cares about, in a sentence or two.',
      '',
      '## Our idea {[list]}',
      '',
      '- What you propose',
      '- Why it works',
      '- What it takes',
      '',
      '## How it works {[process]}',
      '',
      '1. The first step',
      '2. The second step',
      '3. The result',
      '',
      '## The difference it makes {[barChart]}',
      '',
      '| Option | Hours a week |',
      '| --- | ---: |',
      '| Today | 12 |',
      '| With our idea | 5 |',
      '',
      '## What we need from you',
      '',
      'Close with the one thing you want the audience to do.',
    ),
  },
  {
    id: 'budget',
    label: 'Budget',
    description: 'Income and costs, with a chart.',
    name: 'Budget',
    spreadsheet: true,
    body: lines(
      '## Income',
      '',
      '| Item | Amount |',
      '| --- | ---: |',
      '| Salary | 3000 |',
      '| Other income | 250 |',
      '',
      '## Costs {[pieChart]}',
      '',
      '| Item | Amount |',
      '| --- | ---: |',
      '| Rent | 1200 |',
      '| Food | 450 |',
      '| Transport | 150 |',
      '| Bills | 300 |',
      '| Savings | 600 |',
    ),
  },
];

/** The templates worth offering for `format`. */
export function templatesForFormat(format: NewFileFormat): readonly NewDocumentTemplate[] {
  return format === 'xlsx'
    ? NEW_DOCUMENT_TEMPLATES.filter((template) => template.spreadsheet)
    : NEW_DOCUMENT_TEMPLATES;
}

/** The new document's Markdown: its heading, then the template's body. */
export function newDocumentMarkdown(template: NewDocumentTemplate, heading: string): string {
  return template.body ? `# ${heading}\n\n${template.body}` : `# ${heading}\n`;
}

/** What the type row calls each format, with the full name as a tooltip. */
export const NEW_FILE_FORMAT_CHOICES: ReadonlyArray<{
  key: NewFileFormat;
  label: string;
  title: string;
}> = [
  { key: 'markdown', label: 'Markdown', title: 'Markdown (.md)' },
  { key: 'docx', label: 'Document (docx)', title: 'Word document (.docx)' },
  { key: 'xlsx', label: 'Spreadsheet (xlsx)', title: 'Excel workbook (.xlsx)' },
  { key: 'pdf', label: 'PDF', title: 'PDF (.pdf)' },
  { key: 'web-interactive', label: 'Web page', title: 'Web page — Interactive (.html)' },
  { key: 'web-static', label: 'Static web page', title: 'Web page — Static (.html)' },
];

/** Bounded so a pathological folder cannot spin here forever. */
const MAX_NAME_ATTEMPTS = 100;

/**
 * The first free path for a new document called `name` in `folder` (`''`
 * for the workspace root): `Untitled.md`, then `Untitled (2).md`, and so
 * on. A rendered format also needs its hidden companion folder to be free.
 */
export async function firstFreeDocumentPath(
  provider: FileSystemProvider,
  folder: string,
  name: string,
  format: NewFileFormat,
): Promise<{ path: string; stem: string }> {
  const prefix = folder ? `/${folder.replace(/^\/+|\/+$/g, '')}/` : '/';
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const stem = attempt === 1 ? name : `${name} (${attempt})`;
    const fileName = newFileName(stem, format);
    if (!fileName) break;
    const path = `${prefix}${fileName}`;
    if (await providerEntryExists(provider, path)) continue;
    const companion = format === 'markdown' ? null : resolveOutsideInLayout(path);
    if (companion && (await providerEntryExists(provider, companion.companionDirectory))) continue;
    return { path, stem };
  }
  throw new Error(`Too many documents are already named like “${name}”.`);
}
