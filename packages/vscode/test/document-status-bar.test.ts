import { expect } from 'chai';
import {
  formatConflictResolutionDetail,
  getDocumentStatusBarPresentation,
} from '../src/documentStatusBar.js';

describe('VS Code document status bar', () => {
  it('makes unsaved changes explicit and actionable', () => {
    expect(getDocumentStatusBarPresentation('dirty', 'worklessons.md', null)).to.deep.equal({
      text: '$(edit) DocBlocks: Unsaved changes',
      tooltip: 'worklessons.md has unsaved changes. Select to save.',
      accessibilityLabel: 'DocBlocks: worklessons.md has unsaved changes. Select to save',
      action: 'save',
      severity: 'normal',
    });
  });

  it('distinguishes saving, failure, and conflict states', () => {
    expect(getDocumentStatusBarPresentation('saving', 'notes.md', null)?.text).to.equal(
      '$(sync~spin) DocBlocks: Saving…',
    );

    const failure = getDocumentStatusBarPresentation('error', 'notes.md', 'Disk is full');
    expect(failure).to.include({ action: 'save', severity: 'error' });
    expect(failure?.tooltip).to.contain('Disk is full');

    const conflict = getDocumentStatusBarPresentation('conflict', 'notes.md', null);
    expect(conflict).to.include({
      action: 'resolve-conflict',
      severity: 'warning',
    });
    expect(conflict?.tooltip).to.contain(
      "notes.md's VS Code buffer changed outside this DocBlocks editor",
    );
  });

  it('keeps conflict diagnostics in the native resolution prompt', () => {
    const detail = formatConflictResolutionDetail({
      localBaseDocumentVersion: 7,
      externalDocumentVersion: 9,
      localBytes: 120,
      externalBytes: null,
      localEditedAt: null,
      externalObservedAt: null,
      externalIsDirty: true,
    });

    expect(detail).to.contain('120 bytes UTF-8');
    expect(detail).to.contain('based on VS Code version 7');
    expect(detail).to.contain('Current version: deleted');
    expect(detail).to.contain('VS Code version 9, unsaved in VS Code');
  });
});
