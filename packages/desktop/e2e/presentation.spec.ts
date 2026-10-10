/** Blank editor → AI draft → narration → reviewed presentation → reopen → MP4.
 * Routine runs use deterministic providers. Set DOCBLOCKS_E2E_KOKORO_MODEL and
 * DOCBLOCKS_E2E_KOKORO_VOICE to already-downloaded files for real speech.
 */
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import type { DocBlocksHostAPI } from '@bendyline/docblocks/host';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures.js';
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
  parsePresentationHints,
  PRESENTATION_HINTS_KEY,
} from '@bendyline/squisq/transform';

const SCRIPT = `# Give your ideas a voice

Start with a few bullet points. DocBlocks helps you turn them into a structured Markdown document. Your ideas become a story you can edit and keep.

## Make every point clear

First write your story. Then turn the key points into slides. Finally review the words and layouts before you share.

## Keep the story and the voice together

Generate narration on your computer. DocBlocks saves the audio beside your document. Your presentation follows the spoken words, even when the slides use shorter headlines.

## From document to video

Review your presentation. Export a narrated video. One document carries the source text, the voice, and the visual story.
`;

async function openDesigner(window: Page, screenshotPath?: string) {
  const button = window.getByRole('button', { name: 'Summarization designer', exact: true });
  if (!(await button.isVisible()))
    await window.getByRole('button', { name: 'More preview settings' }).click();
  await expect(
    button.locator('..').getByRole('combobox', { name: 'Summarize', exact: true }),
  ).toBeVisible();
  if (screenshotPath) await button.locator('..').screenshot({ path: screenshotPath });
  await button.click();
}

test('designs dynamic slides from the Summarize toolbar and exports a timed MP4', async ({
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
    await window.getByRole('button', { name: 'AI actions' }).click();
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
    await window.getByRole('button', { name: 'Speech' }).click();
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
    await window.getByRole('button', { name: 'Choose Use mode' }).click();
    await window.getByRole('menuitemradio', { name: 'Slideshow', exact: true }).click();
    await openDesigner(window, testInfo.outputPath('summarize-design-control.png'));
    const maker = window.getByRole('dialog', { name: 'Summarization designer', exact: true });
    await expect(maker).toContainText(
      'Design how your text is summarized for presentation in slides and video. Note that your document text and narration will remain unchanged.',
    );
    await expect(maker.getByRole('region', { name: 'Original document text' })).toContainText(
      'Start with a few bullet points.',
    );
    await expect(maker.getByRole('textbox')).toHaveCount(0);
    await expect(maker).toContainText('Follows narration');
    await expect(maker.getByRole('alert')).toHaveCount(0);
    await expect(
      maker.getByRole('checkbox', { name: 'Add supporting visual slides where useful' }),
    ).toBeChecked();
    await expect(
      maker.getByRole('navigation', { name: 'Presentation slides' }).getByRole('button'),
    ).toHaveCount(5);
    await maker.screenshot({ path: testInfo.outputPath('automatic-presentation.png') });
    await maker.getByRole('button', { name: 'Suggest with AI' }).click();
    // The scripted model repeats full-passage excerpts on the two split slides.
    // They fail grounding and must remain deterministic, without cached AI text.
    await expect(maker).toContainText('Kept automatic summaries for 2 slides');
    await maker.getByText('Customize slide wording (slides only)', { exact: true }).click();
    await maker
      .getByRole('textbox', { name: 'Slide headline', exact: true })
      .fill('An idea becomes a story');
    await maker.screenshot({ path: testInfo.outputPath('reviewed-presentation.png') });
    await maker.getByRole('button', { name: 'Use dynamic slides' }).click();
    await expect(maker).toBeHidden();
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(PRESENTATION_HINTS_KEY);
    const saved = fs.readFileSync(file, 'utf8');
    // Slide-only edits must leave the authored body (including narration) byte-identical.
    expect(splitFrontmatterBlock(saved).body).toBe(splitFrontmatterBlock(narrated).body);
    await window.waitForTimeout(600);
    await window.getByRole('tab', { name: 'Write', exact: true }).click();
    await editor.focus();
    await window.keyboard.press('ControlOrMeta+Z');
    await expect.poll(() => fs.readFileSync(file, 'utf8')).not.toContain(PRESENTATION_HINTS_KEY);
    expect(fs.readFileSync(file, 'utf8')).toContain('anchor=document');
    await window.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(saved);
    await window.reload();
    await window.locator('.db-tree-row[data-path$="launch.md"]').click();
    await window.getByRole('button', { name: 'Choose Use mode' }).click();
    await window.getByRole('menuitemradio', { name: 'Video', exact: true }).click();
    await openDesigner(window);
    await expect(maker.getByRole('region', { name: 'Original document text' })).toContainText(
      'Give your ideas a voice',
    );
    await maker.getByText('Customize slide wording (slides only)', { exact: true }).click();
    await expect(maker.getByRole('textbox', { name: 'Slide headline', exact: true })).toHaveValue(
      'An idea becomes a story',
    );
    await maker.getByText('Customize slide wording (slides only)', { exact: true }).click();
    await maker
      .getByRole('navigation', { name: 'Presentation slides' })
      .getByRole('button')
      .nth(1)
      .click();
    await maker.screenshot({ path: testInfo.outputPath('steps-presentation.png') });
    await window.keyboard.press('Escape');
    const parsed = markdownToDoc(parseMarkdown(saved));
    const hints = parsePresentationHints(parsed.frontmatter?.[PRESENTATION_HINTS_KEY])!;
    expect(hints.inbetweens).toBe(true);
    expect(hints.blocks.flatMap((block) => block.ai ?? [])).toHaveLength(3);
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
    await window.getByRole('button', { name: 'Export and share' }).click();
    await window.getByRole('menuitem', { name: 'Export video...' }).click();
    const video = window.getByRole('dialog', { name: 'Export Video', exact: true });
    await video.getByRole('combobox', { name: 'Frame Rate' }).selectOption('15');
    await video.getByRole('combobox', { name: 'Quality' }).selectOption('draft');
    await video.getByRole('button', { name: 'Export Video', exact: true }).click();
    await expect(video).toContainText('Export complete!', { timeout: 240_000 });
    await expect(video).toContainText('Audio included');
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
    const probeOutput = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
        { encoding: 'utf8' },
      ),
    ) as { streams: Array<{ codec_type: string; duration: string }>; format: { duration: string } };
    expect(probeOutput.streams.map((stream) => stream.codec_type).sort()).toEqual([
      'audio',
      'video',
    ]);
    expect(Math.abs(Number(probeOutput.format.duration) - timing.duration)).toBeLessThan(0.15);
    fs.writeFileSync(testInfo.outputPath('ffprobe.json'), JSON.stringify(probeOutput, null, 2));
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
    'Use section annotations to change the visualization for blocks of content.';
  const source = `# Introduction\n\nA short opening.\n\n## Features\n\n${features}\n\n## Finish\n\nYour text remains editable.\n`;
  const file = path.join(workspaceDir, 'layouts.md');
  fs.writeFileSync(file, source);
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell');
  await window.locator('.db-tree-row[data-path$="layouts.md"]').click();
  await window.getByRole('button', { name: 'Choose Use mode' }).click();
  await window.getByRole('menuitemradio', { name: 'Slideshow', exact: true }).click();
  await openDesigner(window);
  const designer = window.getByRole('dialog', { name: 'Summarization designer' });
  const slides = designer.getByRole('navigation', { name: 'Presentation slides' });
  const layout = designer.getByRole('combobox', { name: 'Layout preference for this section' });
  const original = designer.getByRole('region', { name: 'Original document text' }).locator('p');
  await slides.getByRole('button').nth(1).click();
  await layout.selectOption('statement');
  await expect(slides.getByRole('button')).toHaveCount(3);
  await expect(original).toHaveText(`Features\n${features}`);

  await layout.selectOption('comparison');
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
  await expect(slides.locator('[aria-current="step"]')).toContainText('Features');
  expect(fs.readFileSync(file, 'utf8')).toBe(source);
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
  await window.getByRole('button', { name: 'Choose Use mode' }).click();
  await window.getByRole('menuitemradio', { name: 'Slideshow', exact: true }).click();
  await openDesigner(window);
  const designer = window.getByRole('dialog', { name: 'Summarization designer' });
  await expect(designer.getByRole('img', { name: /^Slide 1:/ })).toContainText('The sky is blue.');
  await expect(designer.getByRole('alert')).toHaveCount(0);
  await designer.getByRole('button', { name: 'Use dynamic slides' }).click();
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(PRESENTATION_HINTS_KEY);
  const saved = fs.readFileSync(file, 'utf8');
  const hints = parsePresentationHints(parseMarkdown(saved).frontmatter?.[PRESENTATION_HINTS_KEY])!;
  expect(hints.blocks).toEqual([]);
  expect(JSON.stringify(hints)).not.toContain('sky');
  expect(saved).not.toContain('pink');
});
