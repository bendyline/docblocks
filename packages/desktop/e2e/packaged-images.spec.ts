/**
 * Opt-in: real image generation inside the packaged app.
 *
 * Seeds DocBlocks' private Gezel home with a real image model (hard links,
 * so a 5 GB model costs nothing), turns on built-in AI, and has the packaged
 * build render through the `gezel-sd-server` it bundles: Settings lists the
 * model, Generate image renders and inserts a PNG beside the document, and,
 * with a chat model too, Illustrate briefs and renders a design graphic. This
 * is the only check that runs the bundled image engine, the hosted
 * `/v1/images` routes and the IPC streams together under production fuses.
 *
 *   DOCBLOCKS_E2E_REAL_IMAGES=1
 *   DOCBLOCKS_E2E_IMAGE_MODEL_DIR=~/.gezel/engines/sd-cpp/models/flux-2-klein-4b-q4
 *   DOCBLOCKS_E2E_CHAT_MODEL_DIR=~/.gezel/engines/llama-cpp/models/gemma4-e4b-q8  (design graphics)
 *
 * The first render loads the weights inside the request, so it takes minutes
 * on a slow disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { AiImageAccess, AiImageModel, AiModelInfo } from '@bendyline/docblocks/host';
import { expect, test } from './packaged-fixtures.js';

const real = process.env.DOCBLOCKS_E2E_REAL_IMAGES === '1';
const imageModelDir = process.env.DOCBLOCKS_E2E_IMAGE_MODEL_DIR?.trim();
const chatModelDir = process.env.DOCBLOCKS_E2E_CHAT_MODEL_DIR?.trim();
/** A cold render loads the weights first; a laptop GPU then needs a minute. */
const RENDER_TIMEOUT_MS = 600_000;

/** Link a model directory into the private home, as if Settings had installed it. */
function seed(gezelHome: string, engine: 'sd-cpp' | 'llama-cpp', source: string): void {
  const target = path.join(gezelHome, 'apps', 'docblocks', 'engines', engine, 'models');
  const dir = path.join(target, path.basename(source));
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(dir, name);
    // Small files are copied, so nothing the engine rewrites reaches the source.
    if (fs.statSync(from).size < 1_000_000) fs.copyFileSync(from, to);
    else {
      try {
        fs.linkSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
      }
    }
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function imageReference(markdown: string, stem: string): string | null {
  const match = new RegExp(
    `!\\[[^\\]]*\\]\\(<?(${stem}_files/generated-[^)>]+\\.png)>?\\)`,
    'u',
  ).exec(markdown);
  return match?.[1] ?? null;
}

async function imageAccess(window: Page): Promise<AiImageAccess | null> {
  return window.evaluate(async () => {
    const host = Reflect.get(globalThis, 'docBlocksHost') as {
      ai?: { images?: { access(): Promise<AiImageAccess> } };
    };
    return (await host.ai?.images?.access()) ?? null;
  });
}

async function imageModels(window: Page): Promise<readonly AiImageModel[]> {
  return window.evaluate(async () => {
    const host = Reflect.get(globalThis, 'docBlocksHost') as {
      ai: {
        images: {
          models(): Promise<{ ok: true; value: readonly AiImageModel[] } | { ok: false }>;
        };
      };
    };
    const result = await host.ai.images.models();
    return result.ok ? result.value : [];
  });
}

/** Opt in from Settings and wait for the private Gezel to be ready. */
async function turnOnAi(window: Page): Promise<Locator> {
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = window.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'AI', exact: true }).click();
  const section = settings.getByRole('group', { name: 'AI assistance' });
  const optIn = section.getByRole('checkbox', { name: 'Use AI features' });
  await expect(optIn).toBeVisible({ timeout: 60_000 });
  await optIn.check();
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const host = Reflect.get(globalThis, 'docBlocksHost') as {
            ai: { status(): Promise<unknown> };
          };
          return host.ai.status();
        }),
      { timeout: 120_000 },
    )
    .toMatchObject({ kind: 'ready', provider: { name: 'Gezel', mode: 'hosted' } });
  return settings;
}

async function openDocument(window: Page, name: string, readyText: string): Promise<Locator> {
  await window.locator(`.db-tree-row[data-path$="${name}"]`).click();
  const editor = window.locator('.squisq-editor-content [contenteditable="true"]').first();
  await expect(editor).toContainText(readyText, { timeout: 30_000 });
  return editor;
}

async function openAiMenuItem(window: Page, name: string): Promise<void> {
  await window.getByRole('button', { name: 'AI actions' }).click();
  const item = window.getByRole('menuitem', { name });
  await expect(item).toBeEnabled();
  await item.click();
}

test.describe('real image generation', () => {
  test.skip(
    !real || !imageModelDir,
    'Set DOCBLOCKS_E2E_REAL_IMAGES=1 and DOCBLOCKS_E2E_IMAGE_MODEL_DIR.',
  );
  // Local macOS builds are ad-hoc signed, which hosted AI correctly refuses.
  test.skip(process.platform === 'darwin', 'Hosted AI needs a notarized macOS build.');

  test('Generate image renders on the bundled engine and inserts the PNG beside the document', async ({
    launchPackagedApp,
    workspaceDir,
    gezelHome,
  }) => {
    test.setTimeout(RENDER_TIMEOUT_MS + 300_000);
    seed(gezelHome, 'sd-cpp', imageModelDir!);
    const modelId = `sd-cpp:${path.basename(imageModelDir!)}`;
    const file = path.join(workspaceDir, 'lighthouse.md');
    fs.writeFileSync(file, '# Coast\n\nThe lighthouse has guided ships since 1902.\n', 'utf8');

    const packaged = await launchPackagedApp();
    const { window } = packaged;
    await window.waitForSelector('.db-shell', { timeout: 30_000 });
    const settings = await turnOnAi(window);

    // The bundled engine and the seeded model are found without a download.
    await expect.poll(() => imageAccess(window), { timeout: 60_000 }).toEqual({ kind: 'ready' });
    const models = await imageModels(window);
    const model = models.find((entry) => entry.id === modelId);
    expect(model, `${modelId} in ${JSON.stringify(models.map((m) => m.id))}`).toMatchObject({
      state: 'installed',
      shared: false,
    });
    const section = settings.getByRole('region', { name: 'Image generation' });
    await expect(section).toContainText(model!.label);
    await section
      .getByRole('combobox', { name: 'Model for Generate image' })
      .selectOption({ label: model!.label });
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const host = Reflect.get(globalThis, 'docBlocksHost') as {
            ai: { images: { getPreferences(): Promise<{ model: string | null }> } };
          };
          return (await host.ai.images.getPreferences()).model;
        }),
      )
      .toBe(modelId);
    await window.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    const editor = await openDocument(window, 'lighthouse.md', 'guided ships');
    await editor.locator('p', { hasText: 'guided ships' }).click();
    await window.keyboard.press('End');
    await window.keyboard.press('Enter');
    await openAiMenuItem(window, 'Generate image…');
    const panel = window.getByRole('complementary', { name: 'Generate image' });
    await panel
      .getByRole('textbox', { name: 'Description' })
      .fill('A red and white lighthouse on a rocky coast at dusk, soft watercolor');
    const started = Date.now();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    const preview = panel.locator('img.db-ai-image-preview');
    await expect(preview).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
    test.info().annotations.push({
      type: 'render',
      description: `${model!.label}: ${String(Math.round((Date.now() - started) / 1000))} s, cold`,
    });
    await test.info().attach('Generated image', {
      body: await panel.screenshot({ path: test.info().outputPath('generate-image.png') }),
      contentType: 'image/png',
    });
    await panel.getByRole('button', { name: 'Insert', exact: true }).click();

    // The PNG lands in the document's media folder and the Markdown points at it.
    await expect
      .poll(() => imageReference(fs.readFileSync(file, 'utf8'), 'lighthouse'), { timeout: 30_000 })
      .not.toBeNull();
    const reference = imageReference(fs.readFileSync(file, 'utf8'), 'lighthouse')!;
    const size = pngSize(path.join(workspaceDir, reference));
    // A square request: the provider picks the pixels inside the model's range.
    expect(size.width).toBe(size.height);
    expect(size.width).toBeGreaterThanOrEqual(512);
    await expect(editor.locator('img')).toHaveCount(1);
  });

  test('Illustrate briefs and renders a design graphic, then inserts it', async ({
    launchPackagedApp,
    workspaceDir,
    gezelHome,
  }) => {
    test.skip(!chatModelDir, 'Set DOCBLOCKS_E2E_CHAT_MODEL_DIR for the brief.');
    test.setTimeout(RENDER_TIMEOUT_MS + 600_000);
    seed(gezelHome, 'sd-cpp', imageModelDir!);
    seed(gezelHome, 'llama-cpp', chatModelDir!);
    const imageId = `sd-cpp:${path.basename(imageModelDir!)}`;
    const file = path.join(workspaceDir, 'survey.md');
    fs.writeFileSync(
      file,
      [
        '# Customer survey',
        '',
        '## Highlights',
        '',
        'We surveyed 1,250 customers this spring. 87% said they would recommend us, and 64% use ' +
          'the app every week. Average setup time fell from 30 minutes last year to 12 minutes.',
        '',
      ].join('\n'),
      'utf8',
    );

    const packaged = await launchPackagedApp();
    const { window } = packaged;
    await window.waitForSelector('.db-shell', { timeout: 30_000 });
    const settings = await turnOnAi(window);
    await expect.poll(() => imageAccess(window), { timeout: 60_000 }).toEqual({ kind: 'ready' });
    // The seeded chat model writes the plan and the brief.
    const chatModel = await window.evaluate(
      async (wanted) => {
        const host = Reflect.get(globalThis, 'docBlocksHost') as {
          ai: {
            models(): Promise<{ ok: true; value: readonly AiModelInfo[] } | { ok: false }>;
            setPreferences(patch: { model: string }): Promise<unknown>;
          };
        };
        const listed = await host.ai.models();
        const found = listed.ok ? listed.value.find((model) => model.id.endsWith(wanted)) : null;
        if (found) await host.ai.setPreferences({ model: found.id });
        return found?.id ?? null;
      },
      `:${path.basename(chatModelDir!)}`,
    );
    expect(chatModel).not.toBeNull();
    const section = settings.getByRole('region', { name: 'Image generation' });
    const imageLabel = (await imageModels(window)).find((model) => model.id === imageId)!.label;
    await section
      .getByRole('combobox', { name: 'Model for design graphics' })
      .selectOption({ label: imageLabel });
    await window.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    await openDocument(window, 'survey.md', 'would recommend us');
    await openAiMenuItem(window, 'Illustrate document…');
    const panel = window.getByRole('complementary', { name: 'AI illustrations' });
    await expect(panel.getByRole('button', { name: 'Find ideas again' })).toBeVisible({
      timeout: 300_000,
    });
    const ideas = panel.locator('.db-ai-idea-card');
    test.skip((await ideas.count()) === 0, 'The model suggested nothing for this document.');
    // Keep one idea and make it a design graphic, whatever the planner chose.
    while ((await ideas.count()) > 1) {
      await ideas.last().getByRole('button', { name: 'Remove' }).click();
    }
    await ideas.first().getByRole('combobox', { name: 'Kind' }).selectOption('design');
    await panel.getByRole('button', { name: 'Draw 1 picture' }).click();
    const card = panel.locator('.db-ai-illustrate-card').filter({
      has: window.getByRole('button', { name: 'Insert', exact: true }),
    });
    await expect(card).toHaveCount(1, { timeout: RENDER_TIMEOUT_MS });
    await expect(card.locator('.db-ai-design-preview img')).toBeVisible();
    await test.info().attach('Design graphic', {
      body: await panel.screenshot({ path: test.info().outputPath('design-graphic.png') }),
      contentType: 'image/png',
    });
    await card.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect
      .poll(() => imageReference(fs.readFileSync(file, 'utf8'), 'survey'), { timeout: 30_000 })
      .not.toBeNull();
    const reference = imageReference(fs.readFileSync(file, 'utf8'), 'survey')!;
    const size = pngSize(path.join(workspaceDir, reference));
    expect(size.width).toBeGreaterThanOrEqual(512);
    expect(fs.readFileSync(file, 'utf8')).toContain('would recommend us');
  });
});
