import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ProofingSettingsControls } from '../src/Settings/Settings.js';
import {
  DEFAULT_PROOFING_PREFERENCES,
  loadProofingPreferences,
  saveProofingPreferences,
  type ProofingPreferences,
} from '../src/preferences/proofing.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const STORAGE_KEY = 'docblocks:proofingPreferences';

describe('proofing preferences', () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('checks both categories until the user says otherwise', () => {
    expect(loadProofingPreferences()).to.deep.equal({ spelling: true, grammar: true });
    expect(DEFAULT_PROOFING_PREFERENCES).to.deep.equal({ spelling: true, grammar: true });
  });

  it('round-trips a saved choice', () => {
    saveProofingPreferences({ spelling: true, grammar: false });
    expect(loadProofingPreferences()).to.deep.equal({ spelling: true, grammar: false });
  });

  it('falls back per key rather than discarding a partial record', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ grammar: false }));
    expect(loadProofingPreferences()).to.deep.equal({ spelling: true, grammar: false });
  });

  it('survives malformed stored JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadProofingPreferences()).to.deep.equal({ spelling: true, grammar: true });
  });
});

describe('ProofingSettingsControls', () => {
  async function render(value: ProofingPreferences) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const changes: ProofingPreferences[] = [];
    await act(async () => {
      root.render(
        createElement(ProofingSettingsControls, {
          value,
          onChange: (next) => changes.push(next),
        }),
      );
    });
    return {
      container,
      changes,
      async cleanup() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  it('offers a checkbox per category, reflecting the current values', async () => {
    const { container, cleanup } = await render({ spelling: true, grammar: false });
    try {
      const labels = Array.from(container.querySelectorAll('label')).map((label) =>
        label.textContent?.trim(),
      );
      expect(labels).to.deep.equal(['Show inline spell checking', 'Show inline grammar checking']);
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input'));
      expect(boxes.map((box) => box.checked)).to.deep.equal([true, false]);
    } finally {
      await cleanup();
    }
  });

  it('says grammar checking is English-only', async () => {
    const { container, cleanup } = await render(DEFAULT_PROOFING_PREFERENCES);
    try {
      expect(container.textContent).to.contain(
        '(Grammar checking is currently only available for English)',
      );
    } finally {
      await cleanup();
    }
  });

  it('reports one category flip at a time, leaving the other alone', async () => {
    const { container, changes, cleanup } = await render({ spelling: true, grammar: true });
    try {
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input'));
      await act(async () => {
        boxes[1].click();
      });
      expect(changes).to.deep.equal([{ spelling: true, grammar: false }]);
    } finally {
      await cleanup();
    }
  });
});
