import { expect } from 'chai';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markExportSaved, mintExportGrant, revokeExportOwner } from '../main/export-grants.js';
import { openSavedExport } from '../main/open-saved-export.js';

describe('opening saved native exports', () => {
  let directory: string;
  let opened: string[];
  const owner = 876;
  const documentKey = 'document';
  const actions = {
    openDefault: async (file: string) => {
      opened.push(`default:${path.basename(file)}`);
      return '';
    },
    openInDocBlocks: (file: string) => {
      opened.push(`docblocks:${path.basename(file)}`);
    },
    beginAccess: () => {},
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-open-export-'));
    opened = [];
  });
  afterEach(async () => {
    revokeExportOwner(owner);
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function saved(filename: string) {
    const file = path.join(directory, filename);
    const grant = await mintExportGrant(owner, documentKey, file);
    await fs.writeFile(file, 'exported bytes');
    await markExportSaved(owner, documentKey, grant.grantId);
    return { ...grant, file };
  }

  it('opens documents and videos in the default app and Markdown in DocBlocks', async () => {
    for (const filename of [
      'report.pdf',
      'report.docx',
      'report.pptx',
      'report.epub',
      'report.html',
      'report.zip',
      'movie.mp4',
      'movie.gif',
      'report.MD',
    ]) {
      const grant = await saved(filename);
      await openSavedExport(owner, documentKey, grant.grantId, actions);
      expect(opened.at(-1)).to.equal(
        `${filename.endsWith('.MD') ? 'docblocks' : 'default'}:${filename}`,
      );
    }
  });

  it('does not open a picker grant before its first successful save', async () => {
    const file = path.join(directory, 'existing.pdf');
    await fs.writeFile(file, 'preexisting');
    const grant = await mintExportGrant(owner, documentKey, file);
    await assert.rejects(
      openSavedExport(owner, documentKey, grant.grantId, actions),
      /not been saved/,
    );
    expect(opened).to.deep.equal([]);
  });

  it('rejects another owner, another document, and revoked grants', async () => {
    const grant = await saved('report.pdf');
    await assert.rejects(
      openSavedExport(owner + 1, documentKey, grant.grantId, actions),
      /another window/,
    );
    await assert.rejects(
      openSavedExport(owner, 'other', grant.grantId, actions),
      /another document/,
    );
    revokeExportOwner(owner);
    await assert.rejects(openSavedExport(owner, documentKey, grant.grantId, actions));
    expect(opened).to.deep.equal([]);
  });

  it('rejects files modified or deleted after saving', async () => {
    const grant = await saved('report.pdf');
    await fs.writeFile(grant.file, 'changed file');
    await assert.rejects(openSavedExport(owner, documentKey, grant.grantId, actions), /changed/);
    await fs.rm(grant.file);
    await assert.rejects(openSavedExport(owner, documentKey, grant.grantId, actions), /changed/);
    expect(opened).to.deep.equal([]);
  });

  it('refuses executable file types even after saving', async () => {
    const grant = await saved('program.exe');
    await assert.rejects(
      openSavedExport(owner, documentKey, grant.grantId, actions),
      /type cannot be opened/,
    );
    expect(opened).to.deep.equal([]);
  });

  it('surfaces the default application’s failure without changing the saved file', async () => {
    const grant = await saved('report.pdf');
    await assert.rejects(
      openSavedExport(owner, documentKey, grant.grantId, {
        ...actions,
        openDefault: async () => 'No application is associated with this file.',
      }),
      /No application/,
    );
    expect(await fs.readFile(grant.file, 'utf8')).to.equal('exported bytes');
  });
});
