/**
 * Tests for usePromptDialog / PromptDialog (MF-8).
 *
 * These replace `window.prompt()`, which Electron's renderer does not
 * implement — File > New and Rename Workspace both threw there and did
 * nothing at all. The contract the shell's call sites rely on:
 *
 *   • Enter / the confirm button resolve with the entered text
 *   • Escape, Cancel and the close button resolve `null` (caller does nothing)
 *   • the promise ALWAYS settles — superseding a prompt or unmounting the host
 *     resolves `null` rather than stranding the caller in an await forever
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePromptDialog, type PromptDialogController } from '../src/components/usePromptDialog.js';

describe('usePromptDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: PromptDialogController;

  function Host() {
    const value = usePromptDialog();
    controller = value;
    return value.promptDialog;
  }

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Host));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const input = () => container.querySelector<HTMLInputElement>('.db-git-form-input');
  const confirmButton = () => container.querySelector<HTMLButtonElement>('.db-git-primary-btn');
  const cancelButton = () => container.querySelector<HTMLButtonElement>('.db-git-secondary-btn');

  async function open(initialValue = 'Untitled.md') {
    let settled: string | null | undefined;
    let pending!: Promise<string | null>;
    await act(async () => {
      pending = controller.prompt({ title: 'New document', label: 'Document name', initialValue });
      void pending.then((value) => {
        settled = value;
      });
    });
    return { pending, read: () => settled };
  }

  async function type(value: string) {
    const field = input();
    if (!field) throw new Error('prompt input is not rendered');
    await act(async () => {
      // React tracks the DOM value node; go through the native setter so the
      // synthetic onChange actually fires.
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('renders a labelled, focused field seeded with the initial value', async () => {
    await open('Untitled.md');

    const field = input();
    expect(field).to.not.equal(null);
    expect(field?.value).to.equal('Untitled.md');
    expect(document.activeElement).to.equal(field);
    // The field must be programmatically labelled, not just visually.
    const label = container.querySelector<HTMLLabelElement>('.db-git-form-label');
    expect(label?.htmlFor).to.equal(field?.id);
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).to.equal('true');
  });

  it('resolves with the entered text when Enter is pressed', async () => {
    const { pending } = await open();
    await type('Roadmap.md');
    await act(async () => {
      input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(await pending).to.equal('Roadmap.md');
    // The dialog closes itself once answered.
    expect(input()).to.equal(null);
  });

  it('resolves with the entered text when the confirm button is clicked', async () => {
    const { pending } = await open();
    await type('Notes.md');
    await act(async () => {
      confirmButton()?.click();
    });

    expect(await pending).to.equal('Notes.md');
  });

  it('resolves null on Escape so the caller does nothing', async () => {
    const { pending } = await open();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });

    expect(await pending).to.equal(null);
    expect(input()).to.equal(null);
  });

  it('resolves null when cancelled', async () => {
    const { pending } = await open();
    await act(async () => {
      cancelButton()?.click();
    });

    expect(await pending).to.equal(null);
  });

  it('refuses to submit an empty name', async () => {
    const { pending, read } = await open('Untitled.md');
    await type('   ');

    expect(confirmButton()?.disabled).to.equal(true);
    await act(async () => {
      input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // Still open, still unsettled.
    expect(read()).to.equal(undefined);
    expect(input()).to.not.equal(null);

    // And it can still be cancelled out of.
    await act(async () => cancelButton()?.click());
    expect(await pending).to.equal(null);
  });

  it('settles a superseded prompt rather than stranding its caller', async () => {
    const first = await open('First.md');
    const second = await open('Second.md');

    // The first caller must not be left awaiting forever.
    expect(await first.pending).to.equal(null);
    expect(input()?.value).to.equal('Second.md');

    await act(async () => confirmButton()?.click());
    expect(await second.pending).to.equal('Second.md');
  });

  it('settles a pending prompt when the host unmounts', async () => {
    const { pending } = await open();

    await act(async () => root.unmount());

    // Would hang forever if unmount did not settle it; the suite timeout
    // is the backstop that proves this assertion is real.
    expect(await pending).to.equal(null);

    // Re-mount so afterEach's unmount stays valid.
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Host));
    });
  });

  it('restores focus to the invoking element when it closes', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { pending } = await open();
    expect(document.activeElement).to.equal(input());

    await act(async () => cancelButton()?.click());
    await pending;

    expect(document.activeElement).to.equal(trigger);
    trigger.remove();
  });
});

/**
 * The shell itself is not unit-renderable (lazy editor chunk, workspace
 * bootstrap, IndexedDB), so its call sites are pinned at the source level.
 * This is the check that actually fails on the shipped MF-8 bug.
 */
describe('no native prompt() in @bendyline/docblocks-react', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

  // `prompt(` not preceded by a word char or a dot — so `promptForText(` and
  // `controller.prompt(` are fine, but a bare `prompt('…')` is not.
  const NATIVE_PROMPT = /(?<![\w.$])prompt\s*\(/g;

  it('never calls window.prompt() — Electron’s renderer does not implement it', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      // `.d.ts` files declare signatures (e.g. BeforeInstallPromptEvent's
      // `prompt()`); they cannot call anything.
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      const source = readFileSync(path, 'utf8');
      for (const line of source.split('\n')) {
        // Skip the prose in comments that explains why this rule exists.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (NATIVE_PROMPT.test(line)) offenders.push(`${entry.name}: ${line.trim()}`);
        NATIVE_PROMPT.lastIndex = 0;
      }
    }
    expect(offenders).to.deep.equal([]);
  });
});
