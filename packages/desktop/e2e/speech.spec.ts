/**
 * Speech through the whole desktop stack, on stand-in engines: a fake
 * whisper-server for dictation and a narration utility that speaks tones. The
 * IPC, utility process, Squisq dictation capability and renderer controls are
 * all real; only the models are not.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';
import { installFakeSpeechModels, writeFakeMicrophoneWav } from './fake-speech.js';

const DOCUMENT = ['# Field notes', '', 'The first paragraph is already here.', ''].join('\n');

async function speechStatus(window: Page): Promise<unknown> {
  return window.evaluate(async () => {
    const speech = (globalThis as { docBlocksHost?: { speech?: { status(): Promise<unknown> } } })
      .docBlocksHost?.speech;
    if (!speech) throw new Error('The desktop host exposes no speech namespace');
    return speech.status();
  });
}

async function openDocument(window: Page, workspaceDir: string) {
  const file = path.join(workspaceDir, 'field-notes.md');
  fs.writeFileSync(file, DOCUMENT, 'utf8');
  await window.locator('.db-tree-row[data-path$="field-notes.md"]').click();
  const editor = window.locator('.squisq-editor-content [contenteditable="true"]').first();
  await expect(editor).toContainText('already here', { timeout: 30_000 });
  return { file, editor };
}

test('Settings lists speech models and downloads start only from a button', async ({
  launchApp,
  userDataDir,
}) => {
  const env = installFakeSpeechModels(userDataDir, { installed: false });
  const { window } = await launchApp([], env);
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(await speechStatus(window)).toMatchObject({
    stt: { state: 'download-required' },
    tts: { state: 'download-required' },
  });

  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const section = window
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('group', { name: 'Speech' });
  await expect(section).toContainText('Whisper Base (English)');
  await expect(section).toContainText('Kokoro (English voices)');
  await expect(section.getByRole('button', { name: 'Download' })).toHaveCount(2);
});

test('dictation inserts transcribed phrases at the caret, one undo each', async ({
  launchApp,
  userDataDir,
  workspaceDir,
}) => {
  test.setTimeout(120_000);
  const env = installFakeSpeechModels(userDataDir);
  const microphone = writeFakeMicrophoneWav(path.join(userDataDir, 'microphone.wav'));
  const { window } = await launchApp(
    ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${microphone}`],
    { ...env, FAKE_WHISPER_TEXT: 'Dictated by voice.' },
  );
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(await speechStatus(window)).toMatchObject({ stt: { state: 'ready' } });
  const { file, editor } = await openDocument(window, workspaceDir);

  await editor.locator('p', { hasText: 'already here' }).click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.waitForTimeout(600);

  await window.getByRole('button', { name: 'Start dictation' }).click();
  await expect
    .poll(() => fs.readFileSync(file, 'utf8'), { timeout: 30_000 })
    .toContain('Dictated by voice.');
  await window.getByRole('button', { name: 'Stop dictation' }).click();
  await expect(window.getByRole('button', { name: 'Start dictation' })).toBeVisible({
    timeout: 15_000,
  });

  // Each phrase is its own undo step. The fake recogniser returns the same
  // phrase for every take, so count copies in the editor, and let autosave
  // settle before comparing with the file. Focus returns to the editor when
  // dictation stops, so the shortcut reaches it directly.
  const PHRASE = /Dictated by voice\./gu;
  const inEditor = async () => ((await editor.innerText()).match(PHRASE) ?? []).length;
  const onDisk = () => (fs.readFileSync(file, 'utf8').match(PHRASE) ?? []).length;
  const before = await inEditor();
  expect(before).toBeGreaterThan(0);
  await expect.poll(onDisk).toBe(before);
  await window.waitForTimeout(600);
  await window.keyboard.press('ControlOrMeta+Z');
  await expect.poll(inEditor).toBe(before - 1);
  await expect.poll(onDisk).toBe(before - 1);
});

test('reads the document aloud through the narration utility', async ({
  launchApp,
  userDataDir,
  workspaceDir,
}) => {
  const env = installFakeSpeechModels(userDataDir);
  const { window } = await launchApp([], env);
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(await speechStatus(window)).toMatchObject({ tts: { state: 'ready' } });
  await openDocument(window, workspaceDir);

  await window.getByRole('button', { name: 'Speech' }).click();
  await window.getByRole('menuitem', { name: 'Read aloud' }).click();
  const transport = window.getByRole('group', { name: 'Reading aloud' });
  await expect(transport).toBeVisible();
  // Two segments (the heading and the paragraph) arrive from the utility.
  await expect(transport.getByRole('status')).toHaveText(/\/ 2|Generating…|Preparing voice…/u);
  await transport.getByRole('button', { name: 'Stop reading' }).click();
  await expect(transport).toHaveCount(0);
});

test('generates narration into the document folder and exports it as audio', async ({
  launchApp,
  userDataDir,
  workspaceDir,
}) => {
  test.setTimeout(120_000);
  const env = installFakeSpeechModels(userDataDir);

  // A remembered export target stands in for the native Save dialog, which a
  // test cannot answer. It is keyed by the workspace id, so read that first.
  const probe = await launchApp([], env);
  await probe.window.waitForSelector('.db-shell', { timeout: 30_000 });
  const workspaceId = await probe.window.evaluate(async () => {
    const host = (
      globalThis as unknown as {
        docBlocksHost: { workspaces: { getDefault(): Promise<{ id: string }> } };
      }
    ).docBlocksHost;
    return (await host.workspaces.getDefault()).id;
  });
  await probe.close();
  const exportDir = path.join(userDataDir, 'exports');
  fs.mkdirSync(exportDir);
  const documentId = JSON.stringify([workspaceId, 'field-notes.md']);
  const documentKey = createHash('sha256').update(documentId).digest('hex');
  const targets = Object.fromEntries(
    ['m4a', 'webm', 'wav'].map((extension) => [
      extension,
      { path: path.join(exportDir, `field-notes.${extension}`), confirmedByPicker: true },
    ]),
  );
  const settingsFile = path.join(userDataDir, 'settings.json');
  const settings = fs.existsSync(settingsFile)
    ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>)
    : { workspaces: [] };
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ ...settings, exportTargets: { [documentKey]: { byExtension: targets } } }),
  );

  const { window } = await launchApp([], env);
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  const { file } = await openDocument(window, workspaceDir);

  await window.getByRole('button', { name: 'Speech' }).click();
  await window.getByRole('menuitem', { name: 'Generate narration…' }).click();
  const generate = window.getByRole('dialog', { name: 'Generate narration' });
  await generate.getByRole('button', { name: 'Generate' }).click();
  await expect(generate.getByRole('status')).toContainText('of narration', { timeout: 30_000 });
  await generate.getByRole('button', { name: 'Done' }).click();

  // The preamble line, the audio, and a v3 sidecar stamped as generated speech.
  await expect
    .poll(() => fs.readFileSync(file, 'utf8'))
    .toMatch(/\{\[audio src=[^\s\]]+\.webm anchor=document\]\}/u);
  const source = fs.readFileSync(file, 'utf8');
  const audioSrc = /\{\[audio src=([^\s\]]+) anchor=document\]\}/u.exec(source)?.[1] ?? '';
  const audioPath = path.join(workspaceDir, audioSrc);
  expect(fs.statSync(audioPath).size).toBeGreaterThan(1_000);
  // The sidecar lands where Squisq's recorder puts one, relative to the
  // document's media container; find it rather than assume the layout.
  const sidecarFile = fs
    .readdirSync(workspaceDir, { recursive: true, encoding: 'utf8' })
    .find((entry) => entry.endsWith(`${path.basename(audioPath)}.timing.json`));
  expect(sidecarFile, 'timing sidecar').toBeTruthy();
  const sidecar = JSON.parse(fs.readFileSync(path.join(workspaceDir, sidecarFile!), 'utf8')) as {
    version: number;
    generator: { method: string; name: string };
    blocks: unknown[];
    bookmarks: unknown[];
  };
  expect(sidecar.version).toBe(3);
  expect(sidecar.generator).toMatchObject({ method: 'tts', name: 'docblocks-kokoro' });
  expect(sidecar.blocks.length).toBeGreaterThan(0);
  expect(sidecar.bookmarks.length).toBeGreaterThan(0);

  // Export the narration as audio through the remembered target.
  await window.getByRole('button', { name: 'Export and share' }).click();
  await window.getByRole('menuitem', { name: 'Export audio...' }).click();
  const exportDialog = window.getByRole('dialog', { name: 'Export audio' });
  await expect(exportDialog).toContainText('narration track');
  const format = await exportDialog.getByRole('combobox', { name: 'Format' }).inputValue();
  const extension = format === 'opus-webm' ? 'webm' : format;
  // Fail fast rather than let an unresolved destination open a native Save
  // dialog, which nothing in a test can answer.
  const granted = await window.evaluate(
    async ({ id, filename }) => {
      const host = (
        globalThis as unknown as {
          docBlocksHost: {
            exports: {
              resolveTarget(id: string, filename: string): Promise<{ grantId: string | null }>;
            };
          };
        }
      ).docBlocksHost;
      return (await host.exports.resolveTarget(id, filename)).grantId;
    },
    { id: documentId, filename: `field-notes.${extension}` },
  );
  expect(granted, 'remembered export destination').toBeTruthy();
  await exportDialog.getByRole('button', { name: 'Export' }).click();
  await expect(exportDialog.getByRole('status')).toContainText('Saved', { timeout: 60_000 });
  const exported = fs.readFileSync(path.join(exportDir, `field-notes.${extension}`));
  expect(exported.length).toBeGreaterThan(1_000);
  if (extension === 'm4a') expect(exported.subarray(4, 8).toString('latin1')).toBe('ftyp');
  if (extension === 'webm') expect(exported.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  if (extension === 'wav') expect(exported.subarray(0, 4).toString('latin1')).toBe('RIFF');
});
