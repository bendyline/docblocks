import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  confirmExportReplacement,
  readExportTargetIdentity,
  type ExportReplacementDetails,
} from '../main/export-overwrite.js';

describe('desktop export overwrite confirmation', () => {
  let directory = '';
  let target = '';

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-export-overwrite-'));
    target = path.join(directory, 'resume4.docx');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('does not prompt when the target is new', async () => {
    let prompts = 0;
    const confirmed = await confirmExportReplacement(target, null, async () => {
      prompts += 1;
      return false;
    });

    expect(confirmed).to.equal(true);
    expect(prompts).to.equal(0);
  });

  it('lets the user cancel replacement of an existing target', async () => {
    await fs.writeFile(target, 'existing export');
    let prompt: ExportReplacementDetails | null = null;
    const confirmed = await confirmExportReplacement(target, null, async (details) => {
      prompt = details;
      return false;
    });

    expect(confirmed).to.equal(false);
    expect(prompt).to.deep.equal({ filename: 'resume4.docx', displayPath: target });
  });

  it('does not double-prompt for the unchanged file approved by the native picker', async () => {
    await fs.writeFile(target, 'existing export');
    const pickerApprovedIdentity = await readExportTargetIdentity(target);
    let prompts = 0;
    const confirmed = await confirmExportReplacement(target, pickerApprovedIdentity, async () => {
      prompts += 1;
      return false;
    });

    expect(confirmed).to.equal(true);
    expect(prompts).to.equal(0);
  });

  it('prompts again when the file changed after native picker approval', async () => {
    await fs.writeFile(target, 'existing export');
    const pickerApprovedIdentity = await readExportTargetIdentity(target);
    await fs.writeFile(target, 'a changed and longer existing export');
    let prompts = 0;
    const confirmed = await confirmExportReplacement(target, pickerApprovedIdentity, async () => {
      prompts += 1;
      return true;
    });

    expect(confirmed).to.equal(true);
    expect(prompts).to.equal(1);
  });
});
