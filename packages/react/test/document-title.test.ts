import { expect } from 'chai';
import { titleForSelectedFile, useDocumentTitle } from '../src/DocBlocksShell/document-title.js';
import { renderHook } from './helpers/renderHook.js';

describe('document title', () => {
  afterEach(() => {
    document.title = 'DocBlocks';
  });

  it('uses the selected file basename without its extension and the DocBlocks app name', () => {
    expect(titleForSelectedFile('/notes.md')).to.equal('notes - DocBlocks');
    expect(titleForSelectedFile('/projects/reports/quarterly.markdown')).to.equal(
      'quarterly - DocBlocks',
    );
  });

  it('falls back to the app name when no file is open', () => {
    expect(titleForSelectedFile(null)).to.equal('DocBlocks');
    expect(titleForSelectedFile('/')).to.equal('DocBlocks');
  });

  it('keeps the host document title in sync with the selected file', async () => {
    const hook = await renderHook(
      ({ selectedFile }: { selectedFile: string | null }) => useDocumentTitle(selectedFile),
      { selectedFile: null },
    );

    expect(document.title).to.equal('DocBlocks');

    await hook.rerender({ selectedFile: '/drafts/launch-plan.md' });
    expect(document.title).to.equal('launch-plan - DocBlocks');

    await hook.rerender({ selectedFile: null });
    expect(document.title).to.equal('DocBlocks');

    await hook.unmount();
  });
});
