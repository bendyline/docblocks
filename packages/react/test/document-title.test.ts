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

  it('keeps an indexable host title for the configured home document', () => {
    const homeTitle = 'DocBlocks — Local-First Markdown Editor';
    expect(titleForSelectedFile(null, homeTitle, '/aboutDocBlocks.md')).to.equal(homeTitle);
    expect(titleForSelectedFile('/aboutDocBlocks.md', homeTitle, '/aboutDocBlocks.md')).to.equal(
      homeTitle,
    );
    expect(titleForSelectedFile('/notes.md', homeTitle, '/aboutDocBlocks.md')).to.equal(
      'notes - DocBlocks',
    );
  });

  it('omits the duplicate app name in installed display modes', () => {
    const homeTitle = 'DocBlocks — Local-First Markdown Editor';
    expect(titleForSelectedFile('/notes.md', homeTitle, '/aboutDocBlocks.md', false)).to.equal(
      'notes',
    );
    expect(
      titleForSelectedFile('/aboutDocBlocks.md', homeTitle, '/aboutDocBlocks.md', false),
    ).to.equal('Local-First Markdown Editor');
    expect(titleForSelectedFile(null, undefined, undefined, false)).to.equal('');
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

  it('reacts when the page enters or leaves an installed display mode', async () => {
    const originalMatchMedia = globalThis.matchMedia;
    const listeners = new Set<() => void>();
    let standalone = false;
    globalThis.matchMedia = ((query: string) =>
      ({
        get matches() {
          return query === '(display-mode: standalone)' && standalone;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }) satisfies MediaQueryList) as typeof globalThis.matchMedia;

    try {
      const hook = await renderHook(
        ({ selectedFile }: { selectedFile: string | null }) => useDocumentTitle(selectedFile),
        { selectedFile: '/drafts/launch-plan.md' },
      );
      expect(document.title).to.equal('launch-plan - DocBlocks');

      standalone = true;
      for (const listener of listeners) listener();
      expect(document.title).to.equal('launch-plan');

      standalone = false;
      for (const listener of listeners) listener();
      expect(document.title).to.equal('launch-plan - DocBlocks');

      await hook.unmount();
      expect(listeners.size).to.equal(0);
    } finally {
      globalThis.matchMedia = originalMatchMedia;
    }
  });
});
