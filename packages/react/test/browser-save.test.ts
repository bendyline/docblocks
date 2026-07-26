import { expect } from 'chai';
import {
  browserSaveMode,
  createBrowserSaveAsAdapter,
  saveActionLabel,
} from '../src/Export/browser-save.js';

describe('browser export save behavior', () => {
  const originalMatchMedia = globalThis.matchMedia;
  const originalPicker = window.showSaveFilePicker;

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: originalPicker,
    });
  });

  it('describes regular browser exports as saves to Downloads', () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: false, media: query }),
    });

    expect(browserSaveMode()).to.equal('downloads');
    expect(saveActionLabel('mp4', 'downloads')).to.equal('Save MP4 to Downloads');
    expect(createBrowserSaveAsAdapter()).to.equal(undefined);
  });

  it('uses the save picker for installed web apps and writes the completed Blob', async () => {
    const writes: Blob[] = [];
    const suggestions: Array<string | undefined> = [];
    let closed = false;
    const handle = {
      kind: 'file',
      name: 'brief.pdf',
      async createWritable() {
        return {
          async write(value: Blob) {
            writes.push(value);
          },
          async close() {
            closed = true;
          },
          async abort() {},
        };
      },
    } as unknown as FileSystemFileHandle;

    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(display-mode: standalone)',
        media: query,
      }),
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options?: SaveFilePickerOptions) => {
        suggestions.push(options?.suggestedName);
        return handle;
      },
    });

    expect(browserSaveMode()).to.equal('save-as');
    expect(saveActionLabel('pdf', 'save-as')).to.equal('Save PDF as...');

    const adapter = createBrowserSaveAsAdapter();
    expect(adapter?.pickBeforeSave).to.equal(true);
    expect(adapter?.showDestination).to.equal(false);

    const target = await adapter?.pickTarget('notes/brief.pdf');
    const blob = new Blob(['saved'], { type: 'application/pdf' });
    const saved = await adapter?.saveBlob(blob, 'notes/brief.pdf', target);

    expect(saved?.displayPath).to.equal('brief.pdf');
    expect(suggestions).to.deep.equal(['brief.pdf']);
    expect(writes).to.deep.equal([blob]);
    expect(closed).to.equal(true);
  });

  it('treats closing the installed-app picker as cancellation', async () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    });

    expect(await createBrowserSaveAsAdapter()?.pickTarget('brief.pdf')).to.equal(null);
  });
});
