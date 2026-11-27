/** Blank editor → AI draft → narration → reviewed presentation → reopen → MP4.
 * Routine runs use deterministic providers. Set DOCBLOCKS_E2E_KOKORO_MODEL and
 * DOCBLOCKS_E2E_KOKORO_VOICE to already-downloaded files for real speech.
 */
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import type { DocBlocksHostAPI } from '@bendyline/docblocks/host';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, expectSavedBeforeReload } from './fixtures.js';
import { readMp4Summary } from './mp4-summary.js';
import { startFakeGezel, FAKE_GEZEL_CODE } from './fake-gezel.js';
import { installFakeSpeechModels } from './fake-speech.js';
import { parseMarkdown, splitFrontmatterBlock } from '@bendyline/squisq/markdown';
import {
  markdownToDoc,
  resolveAudioMapping,
  buildPreviewDoc,
  expandDocBlocks,
} from '@bendyline/squisq/doc';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import {
  createPresentationPlan,
  readPresentationHints,
  PRESENTATION_HINTS_KEY,
  SUMMARY_SUPPORTING_SLIDES_KEY,
} from '@bendyline/squisq/transform';
import { buildNarrationScript } from '@bendyline/squisq/narration';
import { openDocumentAction, selectWriteMode } from '../../../e2e/helpers/toolbar.js';

/** What the narration speaks, which a recorded take must match. */
const spoken = (markdown: string) =>
  buildNarrationScript(markdownToDoc(parseMarkdown(markdown))).sourceText;

const SCRIPT = `# Give your ideas a voice

Start with a few bullet points. DocBlocks helps you turn them into a structured Markdown document. Your ideas become a story you can edit and keep.

## Make every point clear

Slides come from the words you already wrote. First write your story. Then turn the key points into slides. Finally review the words and layouts before you share.

## Keep the story and the voice together

Generate narration on your computer. DocBlocks saves the audio beside your document. Your presentation follows the spoken words, even when the slides use shorter headlines.

## From document to video

Review your presentation. Export a narrated video. One document carries the source text, the voice, and the visual story.
`;

function summarizeView(window: Page) {
  return window.getByRole('region', { name: 'Summaries', exact: true });
}

/** Opens View › Edit › Summaries and chooses Custom, whose designer (Squisq's) it returns. */
async function openDesigner(window: Page, screenshotPath?: string) {
  await selectWriteMode(window, 'Summaries');
  await summarizeView(window)
    .getByRole('button', { name: /^Summary style / })
    .click();
  // Squisq portals the style list to the body, outside the Summaries region.
  await window
    .getByRole('listbox', { name: 'Summary style', exact: true })
    .getByRole('option', { name: 'Custom', exact: true })
    .click();
  if (screenshotPath) await summarizeView(window).screenshot({ path: screenshotPath });
  return summarizeView(window).getByRole('region', {
    name: 'Summarization designer',
    exact: true,
  });
}

/** Returns Write to the whole-document editor. */
async function openWrite(window: Page) {
  await selectWriteMode(window, 'Write');
}

test('designs Custom summaries in View › Summaries and exports a timed MP4', async ({
  launchApp,
  userDataDir,
  workspaceDir,
  gezelHome,
}, testInfo) => {
  test.setTimeout(600_000);
  const model = process.env.DOCBLOCKS_E2E_KOKORO_MODEL;
  const voice = process.env.DOCBLOCKS_E2E_KOKORO_VOICE;
  const real = !!model && !!voice;
  const env = installFakeSpeechModels(userDataDir, {
    ...(real ? { kokoro: { model, voice } } : {}),
  });
  if (real) env.DOCBLOCKS_SPEECH_KOKORO_ENTRY = ''; // select the production utility and lexicon
  const file = path.join(workspaceDir, 'launch.md');
  fs.writeFileSync(file, '');
  const fake = await startFakeGezel({
    home: gezelHome,
    replies: [{ text: SCRIPT, finishReason: 'stop' }],
  });
  try {
    const probe = await launchApp([], env);
    await probe.window.waitForSelector('.db-shell', { timeout: 30_000 });
    const workspaceId = await probe.window.evaluate(
      async () =>
        (
          await (
            globalThis as typeof globalThis & { docBlocksHost: DocBlocksHostAPI }
          ).docBlocksHost.workspaces!.getDefault()
        ).id,
    );
    await probe.close();
    const documentId = JSON.stringify([workspaceId, 'launch.md']);
    const output = testInfo.outputPath(real ? 'launch-kokoro.mp4' : 'launch-fixture.mp4');
    const settingsFile = path.join(userDataDir, 'settings.json');
    const settings = fs.existsSync(settingsFile)
      ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>)
      : { workspaces: [] };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        ...settings,
        exportTargets: {
          [createHash('sha256').update(documentId).digest('hex')]: {
            byExtension: { mp4: { path: output, confirmedByPicker: true } },
          },
        },
      }),
    );
    const { window } = await launchApp([], env);
    const network = await window.context().newCDPSession(window);
    await network.send('Network.enable');
    network.on('Network.requestWillBeSent', (event) => {
      if (event.request.url.startsWith('app://') && event.request.url.endsWith('.webm'))
        fs.appendFileSync(
          testInfo.outputPath('media-requests.jsonl'),
          JSON.stringify(event) + '\n',
        );
    });
    await window.waitForSelector('.db-shell', { timeout: 30_000 });
    await window.locator('.db-app-menu-btn').click();
    await window.getByRole('menuitem', { name: 'Settings' }).click();
    const settingsDialog = window.getByRole('dialog', { name: 'Settings' });
    await settingsDialog.getByRole('tab', { name: 'AI', exact: true }).click();
    const section = settingsDialog.getByRole('group', { name: 'AI assistance' });
    await section.getByRole('checkbox', { name: 'Use AI features' }).check();
    await section.getByRole('button', { name: 'Connect Gezel app…' }).click();
    await expect(section.locator('.db-settings-ai-code')).toHaveText(FAKE_GEZEL_CODE);
    fake.approve();
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (
              await (
                globalThis as typeof globalThis & { docBlocksHost: DocBlocksHostAPI }
              ).docBlocksHost.ai!.status()
            ).kind,
        ),
      )
      .toBe('ready');
    await window.keyboard.press('Escape');
    await window.locator('.db-tree-row[data-path$="launch.md"]').click();
    const editor = window.locator('.squisq-editor-content [contenteditable="true"]').first();
    await editor.focus();
    await openDocumentAction(window, 'AI');
    await window.getByRole('menuitem', { name: 'Add content…' }).click();
    const compose = window.getByRole('dialog', { name: 'Add content with AI' });
    await compose
      .getByRole('textbox', { name: 'What should be added?' })
      .fill(
        'Write a launch story in four short sections: draft from bullet points; make slides and diagrams; narrate locally; export video.',
      );
    await compose.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(compose.getByRole('button', { name: 'Insert', exact: true })).toBeEnabled();
    await compose.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(editor).toContainText('One document carries');
    await openDocumentAction(window, 'Speech');
    await window.getByRole('menuitem', { name: 'Generate narration…' }).click();
    const generate = window.getByRole('dialog', { name: 'Generate narration' });
    await generate.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await generate.getByRole('alert').count()) +
          (await generate.getByRole('button', { name: 'Done', exact: true }).count()),
        { timeout: 180_000 },
      )
      .toBe(1);
    await expect(generate.getByRole('status')).toContainText('of narration', { timeout: 180_000 });
    await generate.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('anchor=document');
    const narrated = fs.readFileSync(file, 'utf8');
    const media = /\{\[audio src=([^\s\]]+) anchor=document\]\}/u.exec(narrated)![1]!;
    const sidecar = fs
      .readdirSync(workspaceDir, { recursive: true, encoding: 'utf8' })
      .find((entry) => entry.endsWith(`${path.basename(media)}.timing.json`));
    expect(sidecar).toBeTruthy();
    const timing = JSON.parse(fs.readFileSync(path.join(workspaceDir, sidecar!), 'utf8')) as {
      duration: number;
      sourceText: string;
      bookmarks: Array<{ charOffset: number; time: number }>;
    };
    expect(timing.bookmarks.length).toBeGreaterThan(50);
    const maker = await openDesigner(window, testInfo.outputPath('summarize-design-control.png'));
    await expect(summarizeView(window)).toContainText(
      'Your document text and narration are not changed.',
    );
    await expect(maker.getByRole('region', { name: 'Original document text' })).toContainText(
      'Start with a few bullet points.',
    );
    // The only text fields are the opening slide's wording, which starts open;
    // the document text itself is read-only here.
    await expect(maker.getByRole('textbox')).toHaveCount(2);
    await expect(maker.getByRole('textbox', { name: 'Slide headline', exact: true })).toBeVisible();
    await expect(maker).toContainText('Follows narration');
    await expect(maker.getByRole('alert')).toHaveCount(0);
    await expect(
      maker.getByRole('checkbox', { name: /^Add supporting (visual )?slides/ }),
    ).toBeChecked();
    await expect(
      maker.getByRole('navigation', { name: 'Presentation slides' }).getByRole('button'),
    ).toHaveCount(5);
    await maker.screenshot({ path: testInfo.outputPath('automatic-presentation.png') });
    await maker.getByRole('button', { name: 'Suggest with AI' }).click();
    // The scripted model keeps each slide's own points, so the introduction and
    // its steps diagram are grounded in their halves of the passage.
    await expect(maker).toContainText('AI summaries are ready to review.');
    // Accepted suggestions land in the slide list as they arrive and stay marked
    // once the run ends and the footer returns to the Suggest button.
    await expect(
      maker
        .getByRole('navigation', { name: 'Presentation slides' })
        .locator('.squisq-summary-designer-slide-ai'),
    ).toHaveCount(5);
    await expect(maker.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(maker.getByRole('button', { name: 'Suggest with AI' })).toBeEnabled();
    // The preview followed each slide as it was suggested, so return to the
    // opening slide before overriding its wording.
    await maker
      .getByRole('navigation', { name: 'Presentation slides' })
      .getByRole('button')
      .first()
      .click();
    // Slide wording opens by default.
    const headline = maker.getByRole('textbox', { name: 'Slide headline', exact: true });
    await headline.fill('An idea becomes a story');
    // Wording is saved as the field is left; there is no button to commit.
    await headline.press('Tab');
    await maker.screenshot({ path: testInfo.outputPath('reviewed-presentation.png') });
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('An idea becomes a story');
    const saved = fs.readFileSync(file, 'utf8');
    // The wording is a summary block under its section, never the old JSON key.
    expect(saved).toMatch(/^#{2,6} An idea becomes a story \{\[summary\]\}$/m);
    expect(saved).not.toContain(PRESENTATION_HINTS_KEY);
    // Slide-only edits must leave what is narrated identical, so the recorded
    // take still fits.
    expect(spoken(saved)).toBe(spoken(narrated));
    // Each saved change is a step the Write editor, mounted behind the
    // designer, can undo and redo.
    await window.waitForTimeout(600);
    await openWrite(window);
    await editor.focus();
    await window.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => fs.readFileSync(file, 'utf8')).not.toContain('An idea becomes a story');
    // One undo takes back the wording; the AI's summaries stay.
    expect(fs.readFileSync(file, 'utf8')).toContain('origin=ai');
    expect(fs.readFileSync(file, 'utf8')).toContain('anchor=document');
    await window.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(saved);
    await expectSavedBeforeReload(window);
    await window.reload();
    await window.locator('.db-tree-row[data-path$="launch.md"]').click();
    await openDesigner(window);
    await expect(maker.getByRole('region', { name: 'Original document text' })).toContainText(
      'Give your ideas a voice',
    );
    await expect(maker.getByRole('textbox', { name: 'Slide headline', exact: true })).toHaveValue(
      'An idea becomes a story',
    );
    // Close the wording before moving on; it stays closed from slide to slide.
    await maker.getByText('Customize slide wording (slides only)', { exact: true }).click();
    await maker
      .getByRole('navigation', { name: 'Presentation slides' })
      .getByRole('button')
      .nth(2)
      .click();
    await maker.screenshot({ path: testInfo.outputPath('steps-presentation.png') });
    const parsed = markdownToDoc(parseMarkdown(saved));
    const hints = readPresentationHints(parsed).hints;
    expect(hints.inbetweens).toBe(true);
    expect(
      hints.blocks.flatMap((block) =>
        (block.slides ?? []).filter((slide) => slide.origin === 'ai'),
      ),
    ).toHaveLength(5);
    expect(parsed.frontmatter?.['squisq-presentation']).toBeUndefined();
    expect(parsed.frontmatter?.['squisq-transform']).toBe('dynamic-slides');
    const plan = createPresentationPlan(parsed, hints);
    expect(plan.origin).toBe('ai');
    expect(plan.sourceText).toBe(timing.sourceText);
    const container = new MemoryContentContainer();
    for (const suffix of ['', '.timing.json'])
      await container.writeFile(
        media + suffix,
        new Uint8Array(fs.readFileSync(path.join(workspaceDir, suffix ? sidecar! : media))),
        suffix ? 'application/json' : 'audio/webm',
      );
    const projected = buildPreviewDoc(await resolveAudioMapping(parsed, container));
    expect(projected.duration).toBeCloseTo(timing.duration, 6);
    const expanded = expandDocBlocks(projected.blocks, { audioSegments: projected.audio.segments });
    for (const [index, block] of expanded.entries()) {
      const cue =
        index === 0
          ? 0
          : timing.bookmarks.find((word) => word.charOffset >= plan.beats[index]!.sourceStart)!
              .time;
      expect(block.startTime).toBeCloseTo(cue, 6);
    }
    fs.writeFileSync(
      testInfo.outputPath('timeline.json'),
      JSON.stringify(
        {
          speech: real ? 'kokoro' : 'fixture',
          ai: 'scripted',
          duration: timing.duration,
          blocks: expanded.map((block) => ({
            id: block.id,
            start: block.startTime,
            duration: block.duration,
          })),
        },
        null,
        2,
      ),
    );
    // Capture the exporter’s actual MP4 Blob, then save through a remembered
    // host grant. Only the native Save dialog is bypassed by the harness.
    await window.evaluate(() => {
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = create(object);
        if (object instanceof Blob && object.type === 'video/mp4')
          (globalThis as typeof globalThis & { exportedMp4?: Blob }).exportedMp4 = object;
        return url;
      };
    });
    // Chromium encodes AAC only through a platform encoder, which Linux builds
    // lack, and DocBlocks ships no ffmpeg.wasm fallback. There the exporter
    // must refuse narration by name, then still deliver the timed video once
    // audio is excluded. This mirrors Squisq's own capability probe.
    const aacEncoder = await window.evaluate(async () => {
      if (typeof AudioEncoder === 'undefined') return false;
      const support = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 128_000,
      }).catch(() => ({ supported: false }));
      return support.supported === true;
    });
    const openVideoExport = async () => {
      await openDocumentAction(window, 'Export');
      await window.getByRole('menuitem', { name: 'Export video...' }).click();
      const dialog = window.getByRole('dialog', { name: 'Export Video', exact: true });
      await dialog.locator('summary', { hasText: 'Advanced options' }).click();
      await dialog.getByRole('combobox', { name: 'Frame Rate' }).selectOption('15');
      await dialog.getByRole('combobox', { name: 'Quality' }).selectOption('draft');
      return dialog;
    };
    let video = await openVideoExport();
    if (!aacEncoder) {
      testInfo.annotations.push({
        type: 'audio',
        description: 'No WebCodecs AAC encoder on this host; verified a video-only export.',
      });
      await video.getByRole('button', { name: 'Export Video', exact: true }).click();
      await expect(video).toContainText('cannot encode AAC audio', { timeout: 240_000 });
      await video.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(video).toBeHidden();
      video = await openVideoExport();
      await video.getByRole('checkbox', { name: 'Include audio' }).uncheck();
    }
    await video.getByRole('button', { name: 'Export Video', exact: true }).click();
    await expect(video).toContainText('Export complete!', { timeout: 240_000 });
    await expect(video).toContainText(aacEncoder ? 'Audio included' : 'Audio excluded');
    await video.screenshot({ path: testInfo.outputPath('export-complete.png') });
    await window.evaluate(async (id) => {
      const blob = (globalThis as typeof globalThis & { exportedMp4?: Blob }).exportedMp4;
      if (!blob) throw new Error('MP4 export did not produce a blob');
      const api = (globalThis as typeof globalThis & { docBlocksHost: DocBlocksHostAPI })
        .docBlocksHost.exports!;
      const target = await api.resolveTarget!(id, 'launch.mp4');
      if (!target.grantId) throw new Error('Missing test export grant');
      await api.save(id, 'launch.mp4', target.grantId, await blob.arrayBuffer());
    }, documentId);
    expect(fs.statSync(output).size).toBeGreaterThan(10_000);
    const mp4 = readMp4Summary(fs.readFileSync(output));
    expect([...mp4.tracks].sort()).toEqual(aacEncoder ? ['soun', 'vide'] : ['vide']);
    expect(Math.abs(mp4.duration - timing.duration)).toBeLessThan(0.15);
    fs.writeFileSync(testInfo.outputPath('mp4.json'), JSON.stringify(mp4, null, 2));
    fs.cpSync(workspaceDir, testInfo.outputPath('project'), { recursive: true });
    await testInfo.attach('Narrated launch video', { path: output, contentType: 'video/mp4' });
  } finally {
    await fake.close();
  }
});

test('keeps the full source section selected when layouts split and merge slides', async ({
  launchApp,
  workspaceDir,
}) => {
  const features =
    'Rich Markdown Editing -- Write in a visual editor or switch to raw markdown source anytime. ' +
    'First draft the section in the visual editor. Then refine it as raw markdown.';
  const source = `# Introduction\n\nA short opening.\n\n## Features\n\n${features}\n\n## Finish\n\nYour text remains editable.\n`;
  const file = path.join(workspaceDir, 'layouts.md');
  fs.writeFileSync(file, source);
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell');
  await window.locator('.db-tree-row[data-path$="layouts.md"]').click();
  const designer = await openDesigner(window);
  const slides = designer.getByRole('navigation', { name: 'Presentation slides' });
  const layout = designer.getByRole('combobox', { name: 'Layout preference for this section' });
  const original = designer.getByRole('region', { name: 'Original document text' }).locator('p');
  await slides.getByRole('button').nth(1).click();
  await layout.selectOption('statement');
  await expect(slides.getByRole('button')).toHaveCount(3);
  await expect(original).toHaveText(`Features\n${features}`);

  // Steps split the introduction from the diagram of the ordered sentences.
  await layout.selectOption('steps');
  await expect(slides.getByRole('button')).toHaveCount(4);
  await expect(original).toHaveText(`Features\n${features}`);
  await slides.getByRole('button').nth(2).click();
  await expect(original).toHaveText(`Features\n${features}`);

  // Removing the selected supporting slide must keep Features selected, even
  // though slide 3 now belongs to the following Finish section.
  await layout.selectOption('statement');
  await expect(slides.getByRole('button')).toHaveCount(3);
  await expect(original).toHaveText(`Features\n${features}`);
  await expect(layout).toHaveValue('statement');
  // The slide's group names its section; the slide itself shows its passage.
  await expect(slides.locator('.squisq-summary-designer-section--current')).toContainText(
    'Features',
  );
  // Each choice is saved as it is made, on the section's heading alone.
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('{[slideLayout=statement]}');
  // (Choosing Custom sets `squisq-transform` in the frontmatter.)
  expect(splitFrontmatterBlock(fs.readFileSync(file, 'utf8')).body).toBe(
    source.replace('## Features\n', '## Features {[slideLayout=statement]}\n'),
  );
});

test('refreshes dynamic summaries after editing prose without saving generated text', async ({
  launchApp,
  workspaceDir,
}) => {
  const file = path.join(workspaceDir, 'weather.md');
  fs.writeFileSync(
    file,
    '---\nsquisq-transform: dynamic-slides\n---\n\n# Weather\n\nThe sky is pink.\n',
  );
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell');
  await window.locator('.db-tree-row[data-path$="weather.md"]').click();
  const editor = window.locator('.squisq-editor-content [contenteditable="true"]').first();
  await editor.getByText('The sky is pink.', { exact: true }).click({ clickCount: 3 });
  await window.keyboard.insertText('The sky is blue.');
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('The sky is blue.');
  const designer = await openDesigner(window);
  await expect(designer.getByRole('img', { name: /^Slide 1:/ })).toContainText('The sky is blue.');
  await expect(designer.getByRole('alert')).toHaveCount(0);
  // Opening the designer saves nothing; a design change saves only intent.
  const opened = fs.readFileSync(file, 'utf8');
  expect(opened).not.toContain(SUMMARY_SUPPORTING_SLIDES_KEY);
  await designer.getByRole('checkbox', { name: /^Add supporting (visual )?slides/ }).uncheck();
  await expect
    .poll(() => fs.readFileSync(file, 'utf8'))
    .toContain(`${SUMMARY_SUPPORTING_SLIDES_KEY}: false`);
  const saved = fs.readFileSync(file, 'utf8');
  expect(readPresentationHints(markdownToDoc(parseMarkdown(saved))).hints.blocks).toEqual([]);
  expect(saved).not.toContain('{[summary');
  expect(saved).not.toContain(PRESENTATION_HINTS_KEY);
  expect(saved).not.toContain('pink');
});
