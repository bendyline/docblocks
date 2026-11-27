import { expect } from 'chai';
import {
  isBrowsableWorkspaceEntry,
  isCompanionDirectoryName,
  isDestinationFolderName,
  isDiscoverableWorkspaceEntry,
  isIgnoredWorkspaceEntryName,
  isMarkdownFileName,
} from '../src/filesystem/workspace-entry-rules.js';

describe('workspace entry rules', () => {
  it('ignores dot-entries and tool-managed folders but not lookalikes', () => {
    for (const name of [
      '.git',
      '.vscode',
      '.DS_Store',
      'node_modules',
      'Node_Modules',
      '__pycache__',
    ]) {
      expect(isIgnoredWorkspaceEntryName(name), name).to.equal(true);
    }
    for (const name of ['node_modules_notes', 'modules', 'notes', 'a.b']) {
      expect(isIgnoredWorkspaceEntryName(name), name).to.equal(false);
    }
  });

  it('recognises every Markdown extension DocBlocks opens, in any case', () => {
    for (const name of ['notes.md', 'Notes.MD', 'notes.markdown', 'notes.mdown', 'a/b/c.md']) {
      expect(isMarkdownFileName(name), name).to.equal(true);
    }
    for (const name of ['notes.mdx', 'notes.txt', 'md', 'notes_md']) {
      expect(isMarkdownFileName(name), name).to.equal(false);
    }
  });

  it('matches companion folders case-sensitively, as DocBlocks writes them', () => {
    expect(isCompanionDirectoryName('notes_files')).to.equal(true);
    expect(isCompanionDirectoryName('notes_FILES')).to.equal(false);
  });

  it('browses files named like companions but hides companion folders', () => {
    expect(isBrowsableWorkspaceEntry('topic_files', 'directory')).to.equal(false);
    expect(isBrowsableWorkspaceEntry('topic_files', 'file')).to.equal(true);
    expect(isBrowsableWorkspaceEntry('node_modules', 'directory')).to.equal(false);
    expect(isBrowsableWorkspaceEntry('_squisq', 'directory')).to.equal(true);
  });

  it('keeps the Squisq runtime folder out of document discovery', () => {
    expect(isDiscoverableWorkspaceEntry('_squisq', 'directory')).to.equal(false);
    expect(isDiscoverableWorkspaceEntry('_squisq', 'file')).to.equal(true);
    expect(isDiscoverableWorkspaceEntry('guides', 'directory')).to.equal(true);
    expect(isDiscoverableWorkspaceEntry('.versions', 'directory')).to.equal(false);
  });

  it('offers only folders a person would put a document in', () => {
    for (const name of [
      '.git',
      'node_modules',
      'notes_files',
      'notes_files - Copy',
      'notes_files - Copy (2)',
      'notes_files copy',
      'notes_files copy 2',
      'notes_files 2',
      'notes_files (1)',
      "notes_files (Sam's conflicted copy 2026-11-25)",
      '_templates',
      '_Templates',
      '_squisq',
    ]) {
      expect(isDestinationFolderName(name), name).to.equal(false);
    }
    for (const name of [
      '_posts',
      '_drafts',
      'Notes',
      'Field Notes',
      'prompts_recurring',
      'case_files_2026',
      'my_files_archive',
      'Tasks',
      '2026',
    ]) {
      expect(isDestinationFolderName(name), name).to.equal(true);
    }
  });
});
