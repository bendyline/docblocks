/**
 * The AI editor features through the whole desktop stack, against a fake of
 * the person's installed Gezel: pairing with a typed code, then Add content,
 * Rewrite selection and Review document, each landing in the saved file and
 * each removed again by a single undo; Stop, which must close the stream at
 * the provider; AI diagrams — Illustrate document and Diagram this… —
 * inserted as one undo step; and study aids, saved beside the document.
 *
 * Set DOCBLOCKS_E2E_AI_UPSTREAM (an OpenAI-compatible base URL) and
 * DOCBLOCKS_E2E_AI_UPSTREAM_MODEL to answer with a real model instead of the
 * scripted replies. The assertions only compare what the UI showed with what
 * reached the document, so they hold for both.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';

import { test, expect, expectSavedBeforeReload } from './fixtures.js';
import {
  FAKE_COMPOSE_TEXT,
  FAKE_GEZEL_CODE,
  FAKE_GEZEL_MODEL,
  FAKE_GEZEL_TOKEN,
  FAKE_SUMMARY_OVERVIEW,
  startFakeGezel,
  type FakeGezel,
  type FakeGezelOptions,
} from './fake-gezel.js';

const DOCUMENT = [
  '# Team wiki migration',
  '',
  'Last quarter we evaluated three tools for the new team wiki.',
  '',
  'The results was mixed, and alot of pages had not been touched since 2021.',
  '',
  'DocBlocks stood out because it stores plain Markdown files.',
  '',
].join('\n');

/** Prose with a process and dated events, for the diagram features. */
const DIAGRAM_DOCUMENT = [
  '# Release process',
  '',
  '## How a release ships',
  '',
  // "Next" and "After" are sequence cues, so the Illustrate shortlist offers
  // this passage to the planner alongside the dated History one.
  'The team drafts the release notes. Next, a reviewer checks every change. After that, the ' +
    'build is signed and published. Customers are notified by email.',
  '',
  '## History',
  '',
  'The project started in 2019, released its first stable version in 2021, and moved to monthly ' +
    'releases in 2023.',
  '',
].join('\n');

/** Markers that only an inserted diagram puts in the file. */
const DIAGRAM_MARKERS = ['```mermaid', '```timeline', '{[drawing]}', '{[layout]}'];

function diagramCount(file: string): number {
  const text = readDocument(file);
  return DIAGRAM_MARKERS.reduce((total, marker) => total + text.split(marker).length - 1, 0);
}

const upstreamBase = process.env.DOCBLOCKS_E2E_AI_UPSTREAM?.trim();
const upstream = upstreamBase
  ? { baseUrl: upstreamBase, model: process.env.DOCBLOCKS_E2E_AI_UPSTREAM_MODEL?.trim() ?? '' }
  : undefined;
/** A real model needs time for a cold load and a whole-document review. */
const ANSWER_TIMEOUT_MS = upstream ? 180_000 : 15_000;

async function aiStatus(window: Page): Promise<unknown> {
  return window.evaluate(async () => {
    const ai = (globalThis as { docBlocksHost?: { ai?: { status(): Promise<unknown> } } })
      .docBlocksHost?.ai;
    if (!ai) throw new Error('The desktop host exposes no AI namespace');
    return ai.status();
  });
}

function readDocument(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Undo from the editor itself, after ProseMirror's 500 ms grouping window. */
async function undo(window: Page, editor: Locator): Promise<void> {
  await window.waitForTimeout(600);
  // A heading's center can hit its Block properties badge and open a popover.
  await editor.focus();
  await window.keyboard.press('ControlOrMeta+Z');
}

async function openAiMenuItem(window: Page, name: string): Promise<void> {
  await window.getByRole('button', { name: 'AI actions' }).click();
  const item = window.getByRole('menuitem', { name });
  await expect(item).toBeEnabled();
  await item.click();
}

/** Generate in the draft dialog and return exactly what it showed. */
async function generateDraft(dialog: Locator, acceptLabel: string): Promise<string> {
  await dialog.getByRole('button', { name: 'Generate' }).click();
  const accept = dialog.getByRole('button', { name: acceptLabel });
  await expect(accept).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });
  const draft = (await dialog.locator('.db-ai-draft-output').inputValue()).trim();
  expect(draft.length).toBeGreaterThan(0);
  await accept.click();
  await expect(dialog).toBeHidden();
  return draft;
}

/** Opt in, then pair with the fake the way a person would, by the typed code. */
async function pairWithGezel(window: Page, fake: FakeGezel): Promise<void> {
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = window.getByRole('dialog', { name: 'Settings' });
  const section = settings.getByRole('group', { name: 'AI assistance' });
  // The section renders once main answers its status and preference queries,
  // which a cold first launch on a busy machine can take a while to do.
  const optIn = section.getByRole('checkbox', { name: 'Use AI features' });
  await expect(optIn).toBeVisible({ timeout: 60_000 });
  await optIn.check();
  const connect = section.getByRole('button', { name: 'Connect Gezel app…' });
  await expect(connect).toBeVisible({ timeout: 60_000 });
  // Nothing registers with the installed Gezel until the person asks.
  expect(fake.registrations).toBe(0);
  await connect.click();
  await expect(section.locator('.db-settings-ai-code')).toHaveText(FAKE_GEZEL_CODE);
  fake.approve();
  await expect
    .poll(() => aiStatus(window), { timeout: 30_000 })
    .toMatchObject({
      kind: 'ready',
      provider: { mode: 'installed' },
      model: { id: FAKE_GEZEL_MODEL },
    });
  await window.keyboard.press('Escape');
  await expect(settings).toBeHidden();
}

/** Launch against a fake Gezel with the test document open in the editor. */
async function withConnectedEditor(
  launchApp: () => Promise<{ window: Page }>,
  workspaceDir: string,
  gezelHome: string,
  options: Omit<FakeGezelOptions, 'home'> & { document?: string; readyText?: string },
  run: (context: { window: Page; editor: Locator; file: string; fake: FakeGezel }) => Promise<void>,
): Promise<void> {
  let fake: FakeGezel | null = null;
  const { document = DOCUMENT, readyText = 'DocBlocks stood out', ...fakeOptions } = options;
  try {
    fake = await startFakeGezel({ home: gezelHome, ...fakeOptions });
    const file = path.join(workspaceDir, 'ai-review.md');
    fs.writeFileSync(file, document, 'utf8');

    const { window } = await launchApp();
    await window.waitForSelector('.db-shell', { timeout: 30_000 });
    await pairWithGezel(window, fake);

    await window.locator('.db-tree-row[data-path$="ai-review.md"]').click();
    const editor = window.locator('.squisq-editor-content [contenteditable="true"]').first();
    await expect(editor).toContainText(readyText, { timeout: 30_000 });
    await run({ window, editor, file, fake });
  } finally {
    await fake?.close();
  }
}

/** Put the caret in a new empty paragraph after the last line. */
async function caretAtNewParagraph(window: Page, editor: Locator): Promise<void> {
  await editor.locator('p', { hasText: 'DocBlocks stood out' }).click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.waitForTimeout(600);
}

test('AI drafts, rewrites and reviews through a connected Gezel, one undo each', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(upstream ? 900_000 : 180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    upstream ? { upstream } : {},
    async ({ window, editor, file, fake }) => {
      await caretAtNewParagraph(window, editor);
      await openAiMenuItem(window, 'Add content…');
      const composeDialog = window.getByRole('dialog', { name: 'Add content with AI' });
      await composeDialog
        .getByRole('textbox', { name: 'What should be added?' })
        .fill('Add a short closing paragraph that summarizes the recommendation.');
      const composed = await generateDraft(composeDialog, 'Insert');
      await expect.poll(() => readDocument(file)).toContain(composed);
      await undo(window, editor);
      await expect.poll(() => readDocument(file)).not.toContain(composed);

      // Rewrite one paragraph in place.
      const original = 'The results was mixed, and alot of pages had not been touched since 2021.';
      await editor.locator('p', { hasText: 'The results was mixed' }).click({ clickCount: 3 });
      await openAiMenuItem(window, 'Rewrite selection…');
      const rewriteDialog = window.getByRole('dialog', { name: 'Rewrite with AI' });
      await expect(rewriteDialog.locator('.db-ai-selection-preview')).toContainText(original);
      const rewritePrompt = rewriteDialog.getByRole('textbox', {
        name: 'How should this be rewritten?',
      });
      await expect(rewritePrompt).toHaveValue('');
      await expect(rewritePrompt).toHaveAttribute(
        'placeholder',
        'Improve clarity and flow while preserving the meaning and voice.',
      );
      await expect(rewriteDialog.getByRole('textbox', { name: 'AI draft' })).toHaveCount(0);
      const rewritten = await generateDraft(rewriteDialog, 'Replace selection');
      await expect.poll(() => readDocument(file)).toContain(rewritten);
      expect(readDocument(file)).not.toContain(original);
      expect(readDocument(file)).toContain('DocBlocks stood out');
      await undo(window, editor);
      await expect.poll(() => readDocument(file)).toContain(original);
      expect(readDocument(file)).not.toContain(rewritten);

      // Review the document and apply the first applicable finding.
      await openAiMenuItem(window, 'Review document…');
      const panel = window.getByRole('complementary', { name: 'AI document review' });
      await expect(panel.locator('.db-ai-review-count')).toBeVisible({
        timeout: ANSWER_TIMEOUT_MS,
      });
      const applicable = panel
        .locator('.db-ai-review-finding')
        .filter({ has: window.getByRole('button', { name: 'Apply', disabled: false }) })
        .first();
      await expect(applicable).toBeVisible();
      const current =
        (await applicable.locator('.db-ai-review-excerpt blockquote').first().textContent()) ?? '';
      const suggested =
        (await applicable.locator('.db-ai-review-excerpt--replacement blockquote').textContent()) ??
        '';
      await applicable.getByRole('button', { name: 'Apply' }).click();
      await expect.poll(() => readDocument(file)).toContain(suggested);
      await undo(window, editor);
      if (suggested.trim()) await expect.poll(() => readDocument(file)).not.toContain(suggested);
      expect(readDocument(file)).toContain(current);

      // Every request went to the chosen model, streamed, with the granted token.
      expect(fake.chats.length).toBe(3);
      // Compose and rewrite use the model's advertised capacity through the
      // renderer → host → SDK path, rather than a fixed short-response cap.
      expect(fake.chats.slice(0, 2).map((chat) => chat.maxTokens)).toEqual([32_768, 32_768]);
      for (const chat of fake.chats) {
        expect(chat).toMatchObject({
          authorization: `Bearer ${FAKE_GEZEL_TOKEN}`,
          model: FAKE_GEZEL_MODEL,
          stream: true,
        });
      }
    },
  );
});

test('AI drafts protect edits on regeneration and insert the reviewed response', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {},
    async ({ window, editor, file, fake }) => {
      await caretAtNewParagraph(window, editor);
      await openAiMenuItem(window, 'Add content…');
      const dialog = window.getByRole('dialog', { name: 'Add content with AI' });
      const prompt = dialog.getByRole('textbox', { name: 'What should be added?' });
      const output = dialog.getByRole('textbox', { name: 'AI draft' });
      const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
      await expect(prompt).toHaveValue('');
      await expect(output).toHaveCount(0);
      await expect(
        dialog.locator('.db-ai-draft-body').getByRole('button', { name: 'Generate' }),
      ).toBeVisible();
      await test.info().attach('Before generation', {
        body: await dialog.screenshot({ path: test.info().outputPath('before-generation.png') }),
        contentType: 'image/png',
      });
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      await expect(insert).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });
      await expect(output).toBeEditable();
      expect(fake.chats[0].messages.at(-1)?.content).toContain(
        'Instructions:\nAdd a concise introduction for this document.',
      );

      const edited = 'The team reviewed this draft and **approved the migration**.';
      await output.fill(edited);
      await dialog.getByRole('button', { name: 'Regenerate' }).click();
      const confirmation = window.getByRole('dialog', { name: 'Regenerate AI draft' });
      await expect(confirmation).toContainText(
        'This will remove all edits you have made. Continue?',
      );
      await test.info().attach('Regeneration confirmation', {
        body: await window.screenshot({
          path: test.info().outputPath('regeneration-confirmation.png'),
        }),
        contentType: 'image/png',
      });
      await confirmation.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirmation).toBeHidden();
      await expect(output).toHaveValue(edited);
      expect(fake.chats).toHaveLength(1);

      await dialog.getByRole('button', { name: 'Regenerate' }).click();
      await confirmation.getByRole('button', { name: 'Continue' }).click();
      await expect(insert).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });
      await expect(output).toHaveValue(FAKE_COMPOSE_TEXT);
      expect(fake.chats).toHaveLength(2);
      // The new generated response starts clean and can be regenerated directly.
      await dialog.getByRole('button', { name: 'Regenerate' }).click();
      await expect(confirmation).toBeHidden();
      await expect(insert).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });
      expect(fake.chats).toHaveLength(3);

      await output.fill(edited);
      await insert.click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => readDocument(file)).toContain(edited);
      expect(readDocument(file)).not.toContain(FAKE_COMPOSE_TEXT);
      await undo(window, editor);
      await expect.poll(() => readDocument(file)).not.toContain(edited);
    },
  );
});

test('AI drafts show the knowledge they drew on, flag unsourced details, and cite sources as footnotes', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.skip(Boolean(upstream), 'The reply and its citations are scripted.');
  test.setTimeout(180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {
      knowledge: {
        catalog: { id: 'wikis', name: 'Team Wikis' },
        passages: [
          {
            title: 'Wiki history',
            text: 'The team wiki moved to DocBlocks in 2024 after a review by the documentation group.',
          },
        ],
      },
      replies: [
        {
          text: 'The wiki moved to DocBlocks in 2024 [1]. The old wiki held 312 pages.',
          finishReason: 'stop',
        },
      ],
    },
    async ({ window, editor, file, fake }) => {
      await caretAtNewParagraph(window, editor);
      await openAiMenuItem(window, 'Add content…');
      const dialog = window.getByRole('dialog', { name: 'Add content with AI' });
      await dialog
        .getByRole('textbox', { name: 'What should be added?' })
        .fill('Add a sentence about when the wiki moved.');
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
      await expect(insert).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });

      // The catalog was searched for the request and its subject, not the
      // whole prompt, and the model was asked to cite passages by number.
      expect(fake.retrievals[0]).toMatchObject({
        query: 'Add a sentence about when the wiki moved.\nTeam wiki migration',
      });
      expect(fake.chats[0].messages[0].content).toContain('"cite":"[1]"');

      const knowledge = dialog.locator('.db-ai-knowledge--used');
      await expect(knowledge.locator('summary')).toHaveText('Knowledge: Team Wikis · 1 article');
      const facts = dialog.locator('.db-ai-facts');
      await expect(facts.locator('summary')).toHaveText('1 statement to check');
      await facts.locator('summary').click();
      await expect(facts.locator('mark')).toHaveText('312');
      await test.info().attach('Knowledge and facts', {
        body: await dialog.screenshot({ path: test.info().outputPath('knowledge-and-facts.png') }),
        contentType: 'image/png',
      });

      // An unsourced number is asked about before it reaches the document.
      await insert.click();
      const confirmation = window.getByRole('dialog', { name: 'Use details no source shows?' });
      await expect(confirmation).toContainText('1 statement in this draft includes');
      await confirmation.getByRole('button', { name: 'Insert anyway' }).click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => readDocument(file))
        .toContain('The wiki moved to DocBlocks in 2024[^source-1].');
      expect(readDocument(file)).toContain(
        '[^source-1]: Wiki history, from the Team Wikis knowledge catalog.',
      );
    },
  );
});

test('AI continues a truncated rewrite without losing edits and applies it as one undo step', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {
      replies: [
        { text: 'The rewritten para', finishReason: 'length' },
        { text: 'graph is complete.', finishReason: 'stop' },
      ],
    },
    async ({ window, editor, file, fake }) => {
      const original = 'The results was mixed, and alot of pages had not been touched since 2021.';
      await editor.locator('p', { hasText: 'The results was mixed' }).click({ clickCount: 3 });
      await openAiMenuItem(window, 'Rewrite selection…');
      const dialog = window.getByRole('dialog', { name: 'Rewrite with AI', exact: true });
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      const output = dialog.getByRole('textbox', { name: 'AI draft' });
      const resume = dialog.getByRole('button', { name: 'Continue draft', exact: true });
      await expect(resume).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
      await expect(output).toHaveValue('The rewritten para');
      await expect(dialog).toContainText('Draft incomplete');
      expect(readDocument(file)).toContain(original);

      await dialog.getByRole('button', { name: 'Replace selection' }).click();
      const confirmation = window.getByRole('dialog', { name: 'Use incomplete AI draft?' });
      await expect(confirmation).toContainText('may remove content that has not been rewritten');
      await confirmation.getByRole('button', { name: 'Cancel' }).click();
      expect(readDocument(file)).toContain(original);
      await output.fill('The edited para');
      await test.info().attach('Incomplete draft recovery', {
        body: await dialog.screenshot({ path: test.info().outputPath('incomplete-draft.png') }),
        contentType: 'image/png',
      });
      await resume.click();
      await expect(output).toBeEditable({ timeout: ANSWER_TIMEOUT_MS });
      await expect(output).toHaveValue('The edited paragraph is complete.');
      await expect(resume).toBeHidden();
      expect(fake.chats).toHaveLength(2);
      expect(fake.chats[1].messages.at(-2)).toEqual({
        role: 'assistant',
        content: 'The edited para',
      });
      expect(fake.chats[1].messages.slice(0, -2)).toEqual(fake.chats[0].messages);
      expect(readDocument(file)).toContain(original);

      await dialog.getByRole('button', { name: 'Replace selection' }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => readDocument(file)).toContain('The edited paragraph is complete.');
      expect(readDocument(file)).not.toContain(original);
      await undo(window, editor);
      await expect.poll(() => readDocument(file)).toContain(original);
      expect(readDocument(file)).not.toContain('The edited paragraph is complete.');
    },
  );
});

test('AI rewriting preserves heading tags as metadata through replacement, reload and undo', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(180_000);
  const original =
    '## So what should you use? {[factCard]}\n\nAn **original** answer.\n\n| Model | Score |\n| --- | --- |\n| Writer | 42 |\n';
  const rewritten = original.replace('An **original** answer.', 'A **rewritten** answer.');
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {
      document: original,
      readyText: 'So what should you use?',
      replies: [{ text: rewritten, finishReason: 'stop' }],
    },
    async ({ window, editor, file, fake }) => {
      await editor.focus();
      await window.keyboard.press('ControlOrMeta+A');
      await openAiMenuItem(window, 'Rewrite selection…');
      const dialog = window.getByRole('dialog', { name: 'Rewrite with AI', exact: true });
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      const apply = dialog.getByRole('button', { name: 'Replace selection' });
      await expect(apply).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });
      const request = fake.chats[0].messages.at(-1)?.content ?? '';
      const selection = request.split('<selection>\n')[1]?.split('\n</selection>')[0] ?? '';
      expect(selection).toContain('## So what should you use? {[factCard]}');
      expect(selection).toContain('An **original** answer.');
      expect(selection).toContain('| Model | Score |');
      await apply.click();
      await expect(dialog).toBeHidden();
      const heading = editor.locator('h2[data-template="factCard"]');
      await expect(heading).toHaveText('So what should you use?');
      await expect(editor).not.toContainText('{[factCard]}');
      await expect(editor.locator('strong')).toHaveText('rewritten');
      await expect(editor.locator('table')).toContainText('Writer');
      await expect.poll(() => readDocument(file)).toContain('A **rewritten** answer.');
      expect(readDocument(file)).toContain('## So what should you use? {[factCard]}');
      await test.info().attach('Tagged rewrite', {
        body: await editor.screenshot({ path: test.info().outputPath('tagged-rewrite.png') }),
        contentType: 'image/png',
      });
      await undo(window, editor);
      await expect.poll(() => readDocument(file)).toContain('An **original** answer.');
      await expect(heading).toHaveText('So what should you use?');
      expect(readDocument(file)).toContain('{[factCard]}');
      await editor.focus();
      await window.keyboard.press('ControlOrMeta+Shift+Z');
      await expect.poll(() => readDocument(file)).toContain('A **rewritten** answer.');
      await expectSavedBeforeReload(window);
      await window.reload();
      await window.locator('.db-tree-row[data-path$="ai-review.md"]').click();
      await expect(
        window.locator('.squisq-editor-content h2[data-template="factCard"]'),
      ).toHaveText('So what should you use?');
      await expect(window.locator('.squisq-editor-content').first()).not.toContainText(
        '{[factCard]}',
      );
      await expect(window.locator('.squisq-editor-content strong')).toHaveText('rewritten');
    },
  );
});

test('Stop ends a streaming draft at the provider and inserts nothing', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    { chunkDelayMs: 1_500 },
    async ({ window, editor, file, fake }) => {
      await caretAtNewParagraph(window, editor);
      await openAiMenuItem(window, 'Add content…');
      const dialog = window.getByRole('dialog', { name: 'Add content with AI' });
      await dialog
        .getByRole('textbox', { name: 'What should be added?' })
        .fill('Add a closing line.');
      await dialog.getByRole('button', { name: 'Generate' }).click();
      const output = dialog.locator('.db-ai-draft-output');
      await expect(output).not.toHaveValue('');
      await dialog.getByRole('button', { name: 'Stop' }).click();

      await expect(dialog.getByText('Generation stopped.')).toBeVisible();
      const partial = await output.inputValue();
      expect(FAKE_COMPOSE_TEXT.startsWith(partial.trim())).toBe(true);
      expect(partial.trim()).not.toBe(FAKE_COMPOSE_TEXT);
      // The cancel reached the provider: the stream closed before its end.
      await expect.poll(() => fake.abandonedStreams).toBe(1);

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await window.waitForTimeout(1_000);
      expect(readDocument(file)).not.toContain(partial.trim());
    },
  );
});

test('AI rewrite shows prefill and token activity, and Stop works before text arrives', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}, testInfo) => {
  test.setTimeout(180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {
      chunkDelayMs: 1_500,
      chatProgress: [
        { phase: 'prefill', percent: 50, outputTokens: null, tokensPerSecond: null },
        { phase: 'reasoning', percent: null, outputTokens: 32, tokensPerSecond: 16 },
      ],
    },
    async ({ window, editor, file, fake }) => {
      await editor.locator('p', { hasText: 'The results was mixed' }).click({ clickCount: 3 });
      await openAiMenuItem(window, 'Rewrite selection…');
      const dialog = window.getByRole('dialog', { name: 'Rewrite with AI' });
      const selection = dialog.locator('.db-ai-selection-preview blockquote');
      for (const side of ['top', 'right', 'bottom', 'left']) {
        await expect(selection).toHaveCSS(`border-${side}-style`, 'solid');
        await expect(selection).toHaveCSS(`border-${side}-width`, '1px');
      }
      await dialog.getByRole('button', { name: 'Generate' }).click();
      await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '50');
      await expect(dialog.getByRole('status')).toContainText('Processing input (prefill)… 50%');
      await expect(dialog.getByRole('textbox', { name: 'AI draft' })).toHaveValue('');
      await dialog.screenshot({ path: testInfo.outputPath('rewrite-prefill.png') });
      await dialog.getByRole('button', { name: 'Stop' }).click();
      await expect(dialog.getByText('Generation stopped.')).toBeVisible();
      await expect.poll(() => fake.abandonedStreams).toBe(1);
      expect(readDocument(file)).toBe(DOCUMENT);
      expect(fake.chats[0].streamOptions).toEqual({ include_usage: true, include_progress: true });

      await dialog.getByRole('button', { name: 'Regenerate' }).click();
      await expect(dialog.getByRole('status')).toContainText('Thinking');
      await expect(dialog.locator('.db-ai-generation-status')).toContainText(
        '32 tokens generated · 16.0 tokens/s',
      );
      await expect(dialog.getByRole('progressbar')).toHaveCount(0);
      await expect(dialog.getByRole('textbox', { name: 'AI draft' })).toHaveValue('');
      await expect(dialog.getByRole('status')).toContainText('Writing');
      await expect(dialog.getByRole('button', { name: 'Replace selection' })).toBeEnabled();
      await expect(dialog.locator('.db-ai-generation-status')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect(readDocument(file)).toBe(DOCUMENT);
    },
  );
});

test('Illustrate finds ideas, draws them when asked, and inserts them as one undo step', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(upstream ? 900_000 : 180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {
      ...(upstream ? { upstream } : {}),
      document: DIAGRAM_DOCUMENT,
      readyText: 'moved to monthly',
    },
    async ({ window, editor, file, fake }) => {
      await openAiMenuItem(window, 'Illustrate document…');
      const panel = window.getByRole('complementary', { name: 'AI illustrations' });
      // Step one: ideas to review and edit. Nothing is drawn until asked.
      await expect(panel.getByRole('button', { name: 'Find ideas again' })).toBeVisible({
        timeout: ANSWER_TIMEOUT_MS * 3,
      });
      const ideas = await panel.locator('.db-ai-idea-card').count();
      if (!upstream) expect(ideas).toBe(2);
      test.skip(ideas === 0, 'The model suggested no diagrams for this document.');
      if (!upstream) expect(fake.chats.length).toBe(1);
      await expect(panel.locator('.db-ai-diagram-preview')).toHaveCount(0);
      await expect(panel.locator('.db-ai-idea-card textarea').first()).not.toHaveValue('');
      await test.info().attach('Illustrate ideas', {
        body: await panel.screenshot({ path: test.info().outputPath('illustrate-ideas.png') }),
        contentType: 'image/png',
      });

      // Step two: draw every idea, then insert.
      await panel
        .getByRole('button', { name: `Draw ${String(ideas)} picture${ideas === 1 ? '' : 's'}` })
        .click();
      await expect(
        panel.locator('.db-ai-illustrate-card').filter({
          has: window.getByRole('button', { name: 'Edit idea' }),
        }),
      ).toHaveCount(ideas, { timeout: ANSWER_TIMEOUT_MS * 3 });
      const ready = panel.locator('.db-ai-illustrate-card').filter({
        has: window.getByRole('button', { name: 'Insert', exact: true }),
      });
      const count = await ready.count();
      // A real model may decline to suggest anything; the fake always suggests two.
      if (!upstream) expect(count).toBe(2);
      test.skip(count === 0, 'The model drew none of its ideas.');
      await expect(ready.first().locator('.db-ai-diagram-preview[role="img"]')).toBeVisible();
      await test.info().attach('Illustrate pictures', {
        body: await panel.screenshot({ path: test.info().outputPath('illustrate-pictures.png') }),
        contentType: 'image/png',
      });

      if (count > 1) {
        await panel.getByRole('button', { name: `Insert all (${String(count)})` }).click();
      } else {
        await ready.first().getByRole('button', { name: 'Insert', exact: true }).click();
      }
      await expect.poll(() => diagramCount(file)).toBe(count);
      expect(readDocument(file)).toContain('Customers are notified by email.');

      await undo(window, editor);
      await expect.poll(() => diagramCount(file)).toBe(0);
      expect(readDocument(file)).toContain('moved to monthly releases in 2023.');

      // One plan call, then one call per idea, all marked as illustration work.
      if (!upstream) expect(fake.chats.length).toBe(3);
    },
  );
});

test('Diagram this… draws the selected text and inserts it after it, one undo step', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(upstream ? 600_000 : 180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    {
      ...(upstream ? { upstream } : {}),
      document: DIAGRAM_DOCUMENT,
      readyText: 'moved to monthly',
    },
    async ({ window, editor, file }) => {
      const paragraph = editor.locator('p', { hasText: 'The team drafts the release notes.' });
      await paragraph.click({ clickCount: 3 });
      await paragraph.click({ button: 'right' });
      await window
        .getByRole('menu', { name: 'Editor actions' })
        .getByRole('menuitem', { name: 'Diagram this…' })
        .click();

      const dialog = window.getByRole('dialog', { name: 'Insert diagram with AI' });
      await expect(dialog.locator('.db-ai-selection-preview')).toContainText(
        'The team drafts the release notes.',
      );
      await dialog.getByRole('button', { name: 'Generate' }).click();
      const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
      await expect(insert).toBeEnabled({ timeout: ANSWER_TIMEOUT_MS });
      await expect(dialog.locator('.db-ai-diagram-preview[role="img"]')).toBeVisible();
      await insert.click();
      await expect(dialog).toBeHidden();

      await expect.poll(() => diagramCount(file)).toBe(1);
      const text = readDocument(file);
      // After the selected paragraph, before the next section.
      const at = Math.min(
        ...DIAGRAM_MARKERS.map((marker) => text.indexOf(marker)).filter((index) => index >= 0),
      );
      expect(at).toBeGreaterThan(text.indexOf('Customers are notified by email.'));
      expect(at).toBeLessThan(text.indexOf('## History'));

      await undo(window, editor);
      await expect.poll(() => diagramCount(file)).toBe(0);
    },
  );
});

test('Study aids are saved beside the document, shown in a viewer, and offered again', async ({
  launchApp,
  workspaceDir,
  gezelHome,
}) => {
  test.setTimeout(upstream ? 600_000 : 180_000);
  await withConnectedEditor(
    launchApp,
    workspaceDir,
    gezelHome,
    upstream ? { upstream } : {},
    async ({ window, file, fake }) => {
      const sidecar = path.join(path.dirname(file), 'ai-review_files', 'ai');
      const footerButton = (dialog: Locator, name: string) =>
        dialog.locator('.db-dialog-footer').getByRole('button', { name, exact: true });

      // A summary: generated, saved in the sidecar, shown as a page.
      await openAiMenuItem(window, 'Summarize document…');
      const summary = window.getByRole('dialog', { name: 'Summarize with AI' });
      await footerButton(summary, 'Generate summary').click();
      await expect(summary.locator('.db-ai-study-summary')).toBeVisible({
        timeout: ANSWER_TIMEOUT_MS,
      });
      if (!upstream) {
        await expect(summary.locator('.db-ai-study-summary')).toContainText(FAKE_SUMMARY_OVERVIEW);
      }
      await expect.poll(() => fs.existsSync(path.join(sidecar, 'summary.md'))).toBe(true);
      const savedSummary = fs.readFileSync(path.join(sidecar, 'summary.md'), 'utf8');
      expect(savedSummary).toContain('docblocks-generated: summary');
      expect(savedSummary).toContain('docblocks-source: ai-review.md');
      await test.info().attach('Summary viewer', {
        body: await summary.screenshot({ path: test.info().outputPath('summary-viewer.png') }),
        contentType: 'image/png',
      });
      await footerButton(summary, 'Close').click();
      await expect(summary).toBeHidden();

      // A quiz: a study deck whose answers can be chosen.
      await openAiMenuItem(window, 'Create quiz…');
      const quiz = window.getByRole('dialog', { name: 'Create a quiz with AI' });
      await footerButton(quiz, 'Generate quiz').click();
      const deck = quiz.getByRole('region', { name: 'Flashcards' });
      await expect(deck).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
      await deck.getByRole('group', { name: 'Answer choices' }).getByRole('button').first().click();
      await expect(deck.getByRole('region', { name: 'Explanation' })).toBeVisible();
      await expect.poll(() => fs.existsSync(path.join(sidecar, 'quiz.md'))).toBe(true);
      await test.info().attach('Quiz viewer', {
        body: await quiz.screenshot({ path: test.info().outputPath('quiz-viewer.png') }),
        contentType: 'image/png',
      });
      await footerButton(quiz, 'Close').click();
      await expect(quiz).toBeHidden();

      // Opening it again offers the saved quiz without asking the model.
      const calls = fake.chats.length;
      await openAiMenuItem(window, 'Create quiz…');
      await expect(quiz.getByText('Saved quiz', { exact: true })).toBeVisible();
      await test.info().attach('Saved quiz offered', {
        body: await quiz.screenshot({ path: test.info().outputPath('saved-quiz.png') }),
        contentType: 'image/png',
      });
      await quiz.getByRole('button', { name: 'View quiz' }).click();
      await expect(quiz.getByRole('region', { name: 'Flashcards' })).toBeVisible();
      expect(fake.chats.length).toBe(calls);
      await footerButton(quiz, 'Close').click();
      await expect(quiz).toBeHidden();

      // Flashcards: basic cards whose answers are revealed.
      await openAiMenuItem(window, 'Create flashcards…');
      const cards = window.getByRole('dialog', { name: 'Create flashcards with AI' });
      await footerButton(cards, 'Generate flashcards').click();
      const cardDeck = cards.getByRole('region', { name: 'Flashcards' });
      await expect(cardDeck).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
      await cardDeck.getByRole('button', { name: 'Reveal', exact: true }).click();
      await expect(cardDeck.getByRole('region', { name: 'Answer' })).toBeVisible();
      await expect.poll(() => fs.existsSync(path.join(sidecar, 'flashcards.md'))).toBe(true);
      await test.info().attach('Flashcards viewer', {
        body: await cards.screenshot({ path: test.info().outputPath('flashcards-viewer.png') }),
        contentType: 'image/png',
      });
      await footerButton(cards, 'Close').click();

      // Study aids never touch the document itself.
      expect(readDocument(file)).toContain('DocBlocks stood out');
      if (!upstream) expect(readDocument(file)).not.toContain(FAKE_SUMMARY_OVERVIEW);
    },
  );
});
