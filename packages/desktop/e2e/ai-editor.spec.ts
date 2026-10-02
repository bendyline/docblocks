/**
 * The AI editor features through the whole desktop stack, against a fake of
 * the person's installed Gezel: pairing with a typed code, then Add content,
 * Rewrite selection and Review document, each landing in the saved file and
 * each removed again by a single undo; and Stop, which must close the stream
 * at the provider.
 *
 * Set DOCBLOCKS_E2E_AI_UPSTREAM (an OpenAI-compatible base URL) and
 * DOCBLOCKS_E2E_AI_UPSTREAM_MODEL to answer with a real model instead of the
 * scripted replies. The assertions only compare what the UI showed with what
 * reached the document, so they hold for both.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures.js';
import {
  FAKE_COMPOSE_TEXT,
  FAKE_GEZEL_CODE,
  FAKE_GEZEL_MODEL,
  FAKE_GEZEL_TOKEN,
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
  await editor.locator('h1').first().click();
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
  options: Omit<FakeGezelOptions, 'home'>,
  run: (context: { window: Page; editor: Locator; file: string; fake: FakeGezel }) => Promise<void>,
): Promise<void> {
  let fake: FakeGezel | null = null;
  try {
    fake = await startFakeGezel({ home: gezelHome, ...options });
    const file = path.join(workspaceDir, 'ai-review.md');
    fs.writeFileSync(file, DOCUMENT, 'utf8');

    const { window } = await launchApp();
    await window.waitForSelector('.db-shell', { timeout: 30_000 });
    await pairWithGezel(window, fake);

    await window.locator('.db-tree-row[data-path$="ai-review.md"]').click();
    const editor = window.locator('.squisq-editor-content [contenteditable="true"]').first();
    await expect(editor).toContainText('DocBlocks stood out', { timeout: 30_000 });
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
