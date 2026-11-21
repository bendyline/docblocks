import { expect } from 'chai';
import * as React from 'react';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DocBlocksHostAiAPI,
  DocBlocksHostMenuAPI,
  DocBlocksHostSpeechAPI,
} from '@bendyline/docblocks/host';

import { AppMenu } from '../src/AppMenu/AppMenu.js';
import {
  AppSettingsDialog,
  type AppSettingsDialogProps,
} from '../src/Settings/AppSettingsDialog.js';
import { SettingsDialog, type SettingsSection } from '../src/Settings/Settings.js';
import { DEFAULT_PROOFING_PREFERENCES } from '../src/preferences/proofing.js';
import { DEFAULT_WRITE_CANVAS_PREFERENCES } from '../src/preferences/write-canvas.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Answers every media query with `matches`, so the dialog's layout is chosen by the test. */
function stubMatchMedia(matches: boolean): () => void {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }) satisfies MediaQueryList) as typeof globalThis.matchMedia;
  return () => {
    globalThis.matchMedia = original;
  };
}

/** A section with state of its own, to show that leaving it does not remount it. */
function Counter() {
  const [count, setCount] = useState(0);
  return createElement(
    'button',
    { type: 'button', className: 'counter', onClick: () => setCount(count + 1) },
    `Clicked ${count}`,
  );
}

const SECTIONS: SettingsSection<'one' | 'two' | 'three'>[] = [
  { id: 'one', label: 'One', content: createElement(Counter) },
  { id: 'two', label: 'Two', content: createElement('button', { type: 'button' }, 'Two action') },
  { id: 'three', label: 'Three', content: createElement('p', null, 'Third') },
];

const tabs = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const visiblePanels = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('.db-settings-panel')).filter(
    (panel) => !panel.hidden,
  );

describe('SettingsDialog sections', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreMatchMedia: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    restoreMatchMedia = stubMatchMedia(false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    restoreMatchMedia();
  });

  it('shows one section at a time behind a vertical tablist', async () => {
    await act(async () => {
      root.render(createElement(SettingsDialog, { onClose: () => undefined, sections: SECTIONS }));
    });

    const tablist = document.body.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute('aria-orientation')).to.equal('vertical');
    expect(tabs().map((tab) => tab.textContent)).to.deep.equal(['One', 'Two', 'Three']);
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).to.deep.equal([
      'true',
      'false',
      'false',
    ]);
    expect(tabs().map((tab) => tab.tabIndex)).to.deep.equal([0, -1, -1]);

    const [panel] = visiblePanels();
    expect(visiblePanels()).to.have.length(1);
    expect(panel.getAttribute('role')).to.equal('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).to.equal(tabs()[0].id);
    expect(tabs()[0].getAttribute('aria-controls')).to.equal(panel.id);
    expect(document.body.querySelector('select')).to.equal(null);
  });

  it('keeps a section mounted while another is shown', async () => {
    await act(async () => {
      root.render(createElement(SettingsDialog, { onClose: () => undefined, sections: SECTIONS }));
    });

    await act(async () => document.body.querySelector<HTMLButtonElement>('.counter')?.click());
    await act(async () => tabs()[1].click());
    expect(visiblePanels()[0].textContent).to.equal('Two action');
    await act(async () => tabs()[0].click());
    expect(document.body.querySelector('.counter')?.textContent).to.equal('Clicked 1');
  });

  it('moves between tabs with the arrow, Home and End keys', async () => {
    const changes: string[] = [];
    await act(async () => {
      root.render(
        createElement(SettingsDialog, {
          onClose: () => undefined,
          sections: SECTIONS,
          onSectionChange: (id: string) => changes.push(id),
        }),
      );
    });

    const press = (key: string) =>
      act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    tabs()[0].focus();
    await press('ArrowDown');
    expect(document.activeElement).to.equal(tabs()[1]);
    expect(tabs()[1].getAttribute('aria-selected')).to.equal('true');
    await press('End');
    expect(document.activeElement).to.equal(tabs()[2]);
    await press('ArrowDown');
    expect(document.activeElement).to.equal(tabs()[0]);
    await press('ArrowUp');
    expect(document.activeElement).to.equal(tabs()[2]);
    await press('Home');
    expect(document.activeElement).to.equal(tabs()[0]);
    expect(changes).to.deep.equal(['two', 'three', 'one', 'three', 'one']);
  });

  it('opens on the requested section and falls back to the first for an unknown one', async () => {
    await act(async () => {
      root.render(
        createElement(SettingsDialog, {
          onClose: () => undefined,
          sections: SECTIONS,
          section: 'three',
        }),
      );
    });
    expect(visiblePanels()[0].textContent).to.equal('Third');

    await act(async () => {
      root.render(
        createElement(SettingsDialog<string>, {
          onClose: () => undefined,
          sections: SECTIONS,
          section: 'missing',
        }),
      );
    });
    expect(visiblePanels()[0].querySelector('.counter')).to.not.equal(null);
  });

  it('picks sections from a dropdown on phones and portrait tablets', async () => {
    restoreMatchMedia();
    restoreMatchMedia = stubMatchMedia(true);
    await act(async () => {
      root.render(createElement(SettingsDialog, { onClose: () => undefined, sections: SECTIONS }));
    });

    expect(document.body.querySelector('[role="tablist"]')).to.equal(null);
    const picker = document.body.querySelector<HTMLSelectElement>(
      '.db-settings-section-picker select',
    );
    expect(picker?.getAttribute('aria-label')).to.equal('Settings section');
    expect(Array.from(picker?.options ?? [], (option) => option.textContent)).to.deep.equal([
      'One',
      'Two',
      'Three',
    ]);
    await act(async () => {
      picker!.value = 'three';
      picker!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const [panel] = visiblePanels();
    expect(panel.textContent).to.equal('Third');
    expect(panel.getAttribute('role')).to.equal('region');
    expect(panel.getAttribute('aria-label')).to.equal('Three');
  });

  it('wraps Tab within the open section, never into a hidden one', async () => {
    await act(async () => {
      root.render(
        createElement(SettingsDialog, {
          onClose: () => undefined,
          sections: SECTIONS,
          section: 'two',
        }),
      );
    });

    const close = document.body.querySelector<HTMLElement>('.db-dialog-close');
    const action = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Two action',
    );
    action?.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).to.equal(close);
  });

  it('keeps a single scrolling body without sections', async () => {
    await act(async () => {
      root.render(
        createElement(
          SettingsDialog,
          { onClose: () => undefined },
          createElement('p', null, 'Body'),
        ),
      );
    });
    expect(document.body.querySelector('.db-settings-dialog--sectioned')).to.equal(null);
    expect(document.body.querySelector('[role="tablist"]')).to.equal(null);
    expect(document.body.querySelector('.db-dialog-body')?.textContent).to.equal('Body');
  });
});

function fakeAi(): DocBlocksHostAiAPI {
  return {
    providerInstalled: async () => false,
    status: async () => ({ kind: 'unavailable', reason: 'opt-out' }),
    onStatus: () => () => undefined,
    getPreferences: async () => ({ enabled: false, model: null, reviewMode: 'explicit' }),
    setPreferences: async () => ({ enabled: false, model: null, reviewMode: 'explicit' }),
    connect: () => new Promise(() => undefined),
    disconnect: async () => ({ ok: true, value: null }),
    models: async () => ({ ok: true, value: [] }),
    chat() {
      throw new Error('not used by Settings');
    },
  };
}

function fakeSpeech(options: { synthesize?: boolean } = {}): DocBlocksHostSpeechAPI {
  return {
    status: async () => ({
      stt: { state: 'download-required', reason: 'Download a dictation model.' },
      tts: { state: 'download-required', reason: 'Download voices.' },
    }),
    onStatus: () => () => undefined,
    catalog: async () => ({ ok: true, value: { models: [], voices: [] } }),
    getPreferences: async () => ({ sttModel: null, voice: null, speed: 1 }),
    setPreferences: async () => ({ sttModel: null, voice: null, speed: 1 }),
    prepare: async () => ({ ok: true, value: null }),
    installModel: () => ({ done: new Promise(() => undefined), cancel: () => undefined }),
    removeModel: async () => ({ ok: true, value: null }),
    transcribe: async () => ({
      ok: true,
      value: { text: '', language: null, segments: [], durationMs: 0 },
    }),
    ...(options.synthesize === false
      ? {}
      : {
          synthesize: () => ({
            done: new Promise(() => undefined),
            cancel: () => undefined,
          }),
        }),
  };
}

const fakeTray: DocBlocksHostMenuAPI = {
  setPinnedDocuments: () => undefined,
  getTrayEnabled: async () => false,
  setTrayEnabled: async (next) => next,
};

describe('App Settings sections', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreMatchMedia: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    restoreMatchMedia = stubMatchMedia(false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    restoreMatchMedia();
  });

  const renderDialog = (props: Partial<AppSettingsDialogProps>) =>
    act(async () => {
      root.render(
        createElement(AppSettingsDialog, {
          onClose: () => undefined,
          section: 'appearance',
          onSectionChange: () => undefined,
          themePreference: 'auto',
          accentColor: 'rust',
          interfaceFont: 'system',
          writeCanvasSettings: DEFAULT_WRITE_CANVAS_PREFERENCES,
          proofingPreferences: DEFAULT_PROOFING_PREFERENCES,
          versioningPreference: 'browser-only',
          ...props,
        }),
      );
    });

  const legends = (panel: HTMLElement) =>
    Array.from(panel.querySelectorAll('legend'), (legend) => legend.textContent);

  it('offers every section on a desktop host', async () => {
    await renderDialog({
      ai: fakeAi(),
      speech: fakeSpeech(),
      tray: fakeTray,
      onVersioningPreferenceChange: () => undefined,
    });
    expect(tabs().map((tab) => tab.textContent)).to.deep.equal([
      'Appearance',
      'AI',
      'Dictation',
      'Narration',
      'Device integration',
    ]);
    expect(legends(visiblePanels()[0])).to.deep.equal([
      'Theme',
      'Accent color',
      'Interface font',
      'Write canvas',
      'Spelling and grammar',
    ]);
  });

  it('offers Appearance and Device integration in a browser', async () => {
    await renderDialog({
      getStorageEstimate: async () => ({ usage: 1024, quota: 1024 ** 3 }),
      onVersioningPreferenceChange: () => undefined,
      section: 'device',
    });
    expect(tabs().map((tab) => tab.textContent)).to.deep.equal([
      'Appearance',
      'Device integration',
    ]);
    expect(legends(visiblePanels()[0])).to.deep.equal(['Storage', 'Version history']);
  });

  it('lets a workspace keep no index, and clears a kept one', async () => {
    const keeps: boolean[] = [];
    let cleared = 0;
    const searchIndex = {
      keep: true,
      onKeepChange: (keep: boolean) => keeps.push(keep),
      onClear: () => (cleared += 1),
      persistence: 'persistent' as const,
    };
    await renderDialog({ section: 'search', searchIndex });
    expect(tabs().map((tab) => tab.textContent)).to.deep.equal(['Appearance', 'Search']);
    let panel = visiblePanels()[0] as HTMLElement;
    expect(legends(panel)).to.deep.equal(['Search index']);
    const keep = panel.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(keep?.checked).to.equal(true);
    await act(async () => keep?.click());
    expect(keeps).to.deep.equal([false]);
    const clear = [...panel.querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear search index',
    );
    await act(async () => clear?.click());
    expect(cleared).to.equal(1);

    await renderDialog({ section: 'search', searchIndex: { ...searchIndex, keep: false } });
    panel = visiblePanels()[0] as HTMLElement;
    expect(panel.querySelector('[data-testid="search-index-status"]')?.textContent).to.contain(
      'nothing is kept on this device',
    );
    expect(
      [...panel.querySelectorAll('button')].some(
        (button) => button.textContent === 'Clear search index',
      ),
    ).to.equal(false);

    // A second window on the workspace indexes in memory; say why.
    await renderDialog({
      section: 'search',
      searchIndex: { ...searchIndex, persistence: 'memory' },
    });
    expect(
      visiblePanels()[0]?.querySelector('[data-testid="search-index-status"]')?.textContent,
    ).to.contain('another window');
  });

  it('offers Search with the switch and coverage on a host with an embedding model', async () => {
    const changes: boolean[] = [];
    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: true,
        onChange: (enabled) => changes.push(enabled),
        progress: { total: 2_000, embedded: 500, working: true },
      },
    });
    expect(tabs().map((tab) => tab.textContent)).to.deep.equal(['Appearance', 'Search']);
    const panel = visiblePanels()[0] as HTMLElement;
    expect(legends(panel)).to.deep.equal(['Semantic search']);
    expect(panel.querySelector('[data-testid="semantic-search-coverage"]')?.textContent).to.equal(
      `${(500).toLocaleString()} of ${(2_000).toLocaleString()} passages ready…`,
    );
    const toggle = panel.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => toggle?.click());
    expect(changes).to.deep.equal([false]);

    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: false,
        onChange: () => undefined,
        progress: { total: 2_000, embedded: 500, working: false },
      },
    });
    expect(
      visiblePanels()[0]?.querySelector('[data-testid="semantic-search-coverage"]')?.textContent,
    ).to.contain('paused');

    // A phone indexes on demand: until the first search there is nothing to count.
    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: true,
        onChange: () => undefined,
        progress: { total: 0, embedded: 0, working: false },
        waiting: true,
      },
    });
    expect(
      visiblePanels()[0]?.querySelector('[data-testid="semantic-search-coverage"]')?.textContent,
    ).to.equal('The open workspace is prepared once you first search it.');
  });

  it('offers the per-workspace AI switch, saying where passages go', async () => {
    const changes: boolean[] = [];
    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: true,
        onChange: () => undefined,
        progress: null,
        aiGrounding: { enabled: false, onChange: (on) => changes.push(on), remote: true },
      },
    });
    const panel = visiblePanels()[0] as HTMLElement;
    const toggle = [...panel.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Use this workspace in AI answers'))
      ?.querySelector('input');
    expect(toggle?.checked).to.equal(false);
    expect(panel.textContent).to.contain('runs remotely, so those passages are sent to it');
    await act(async () => toggle?.click());
    expect(changes).to.deep.equal([true]);

    // Without meaning there is nothing to ground in, so the switch waits.
    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: false,
        onChange: () => undefined,
        progress: null,
        aiGrounding: { enabled: true, onChange: () => undefined, remote: false },
      },
    });
    const disabled = [...(visiblePanels()[0] as HTMLElement).querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Use this workspace in AI answers'))
      ?.querySelector('input');
    expect(disabled?.disabled).to.equal(true);
  });

  it('offers the model download where the host does not bundle it', async () => {
    let downloads = 0;
    const model = {
      profileId: 'bge-small-en-v1.5@1',
      dimensions: 384,
      reason: null,
    };
    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: true,
        onChange: () => undefined,
        progress: null,
        model: {
          ...model,
          state: 'download-required',
          download: { receivedBytes: 0, totalBytes: 133_805_252 },
        },
        onDownload: () => {
          downloads += 1;
        },
      },
    });
    const panel = visiblePanels()[0] as HTMLElement;
    expect(panel.textContent).to.contain('(134 MB)');
    expect(panel.querySelector('[data-testid="semantic-search-coverage"]')).to.equal(null);
    const button = Array.from(panel.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Download search model',
    );
    await act(async () => button?.click());
    expect(downloads).to.equal(1);

    await renderDialog({
      section: 'search',
      semanticSearch: {
        enabled: true,
        onChange: () => undefined,
        progress: null,
        model: {
          ...model,
          state: 'downloading',
          download: { receivedBytes: 40_000_000, totalBytes: 133_805_252 },
        },
      },
    });
    expect(
      visiblePanels()[0]?.querySelector('[data-testid="semantic-search-download"]')?.textContent,
    ).to.equal('Downloading the search model: 40 MB of 134 MB…');
  });

  it('leaves Narration out when the host cannot synthesize speech', async () => {
    await renderDialog({ speech: fakeSpeech({ synthesize: false }) });
    expect(tabs().map((tab) => tab.textContent)).to.deep.equal(['Appearance', 'Dictation']);
  });

  it('opens a section the host lacks on Appearance', async () => {
    await renderDialog({ section: 'ai', onVersioningPreferenceChange: () => undefined });
    expect(legends(visiblePanels()[0])[0]).to.equal('Theme');
  });

  it('opens on the section a request names, then reopens where it was left', async () => {
    const menu = (settingsRequest: number) =>
      createElement(AppMenu, {
        speech: fakeSpeech(),
        tray: fakeTray,
        settingsRequest,
        settingsRequestSection: 'dictation',
      });
    await act(async () => root.render(menu(1)));
    expect(
      tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent,
    ).to.equal('Dictation');

    await act(async () =>
      tabs()
        .find((tab) => tab.textContent === 'Device integration')
        ?.click(),
    );
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('.db-dialog-close')?.click(),
    );
    expect(document.body.querySelector('.db-dialog')).to.equal(null);

    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click(),
    );
    const settingsItem = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Settings',
    );
    await act(async () => settingsItem?.click());
    expect(
      tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent,
    ).to.equal('Device integration');
  });
});
