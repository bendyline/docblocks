import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WriteCanvasSettingsControls } from '../src/Settings/Settings.js';
import type { WriteCanvasPreferences } from '../src/preferences/write-canvas.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('Write canvas font picker', () => {
  it('renders the selected heading and body labels in their respective fonts', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const value: WriteCanvasPreferences = {
      textSize: 16,
      lineSpacing: 1.7,
      fontScheme: 'playfair-pt-serif',
    };

    try {
      await act(async () => {
        root.render(createElement(WriteCanvasSettingsControls, { value, onChange: () => {} }));
      });

      expect(container.querySelector('select')).to.equal(null);
      expect(
        container.querySelector<HTMLElement>('.db-font-picker-trigger .db-font-picker-heading')
          ?.style.fontFamily,
      ).to.contain('Playfair Display');
      expect(
        container.querySelector<HTMLElement>('.db-font-picker-trigger .db-font-picker-body')?.style
          .fontFamily,
      ).to.contain('PT Serif');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('shows visual previews and selects an option with pointer input', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const changes: WriteCanvasPreferences[] = [];
    const value: WriteCanvasPreferences = {
      textSize: 16,
      lineSpacing: 1.7,
      fontScheme: 'theme',
    };

    try {
      await act(async () => {
        root.render(
          createElement(WriteCanvasSettingsControls, {
            value,
            onChange: (nextValue: WriteCanvasPreferences) => changes.push(nextValue),
          }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-font-picker-trigger')?.click();
      });

      const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
      expect(options).to.have.length(10);
      const pairing = options.find((option) => option.textContent?.includes('Lora'));
      expect(
        pairing?.querySelector<HTMLElement>('.db-font-picker-heading')?.style.fontFamily,
      ).to.contain('Hanken Grotesk');
      expect(
        pairing?.querySelector<HTMLElement>('.db-font-picker-body')?.style.fontFamily,
      ).to.contain('Lora');

      await act(async () => pairing?.click());
      expect(changes.at(-1)?.fontScheme).to.equal('hanken-lora');
      expect(container.querySelector('[role="listbox"]')).to.equal(null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('supports listbox keyboard navigation and selection', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const changes: WriteCanvasPreferences[] = [];
    const value: WriteCanvasPreferences = {
      textSize: 16,
      lineSpacing: 1.7,
      fontScheme: 'theme',
    };

    try {
      await act(async () => {
        root.render(
          createElement(WriteCanvasSettingsControls, {
            value,
            onChange: (nextValue: WriteCanvasPreferences) => changes.push(nextValue),
          }),
        );
      });
      const trigger = container.querySelector<HTMLButtonElement>('.db-font-picker-trigger');
      await act(async () => {
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
      expect(listbox).not.to.equal(null);

      await act(async () => {
        listbox?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      await act(async () => {
        listbox?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(changes.at(-1)?.fontScheme).to.equal('serif-sans');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
