/**
 * Tests for useConfirmDialog / ConfirmDialog (SF-6).
 *
 * These replace `window.confirm()` and `window.alert()` in the shell. The
 * contract the call sites rely on:
 *
 *   • confirm resolves `true` on accept, `false` on cancel/Escape/close
 *   • acknowledge resolves once dismissed, by any dismissal route
 *   • the promise ALWAYS settles — superseding a dialog or unmounting the
 *     host resolves rather than stranding the caller in an await forever
 *   • a destructive confirm does not focus the destructive button
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useConfirmDialog,
  type ConfirmDialogController,
} from '../src/components/useConfirmDialog.js';

describe('useConfirmDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: ConfirmDialogController;

  function Host() {
    const value = useConfirmDialog();
    controller = value;
    return value.confirmDialog;
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

  const dialog = () => container.querySelector('[role="dialog"]');
  const confirmButton = () => container.querySelector<HTMLButtonElement>('.db-git-primary-btn');
  const cancelButton = () => container.querySelector<HTMLButtonElement>('.db-git-secondary-btn');
  const message = () => container.querySelector('.db-dialog-message')?.textContent;

  /**
   * Returns the promise *wrapped* in an object on purpose: an async helper
   * that returned it directly would adopt it, so `await ask()` would block
   * until the user answered a dialog nobody had clicked yet.
   */
  async function ask(destructive = false) {
    let settled: boolean | undefined;
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = controller.confirm({
        title: 'Remove workspace',
        message: 'Remove this workspace?',
        confirmLabel: 'Remove',
        destructive,
      });
      void pending.then((value) => {
        settled = value;
      });
    });
    return { pending, read: () => settled };
  }

  it('renders the question in a modal dialog', async () => {
    const { pending } = await ask();

    expect(message()).to.equal('Remove this workspace?');
    expect(dialog()?.getAttribute('aria-modal')).to.equal('true');
    expect(confirmButton()?.textContent).to.equal('Remove');
    expect(cancelButton()?.textContent).to.equal('Cancel');

    await act(async () => cancelButton()?.click());
    await pending;
  });

  it('resolves true when confirmed', async () => {
    const { pending } = await ask();
    await act(async () => confirmButton()?.click());

    expect(await pending).to.equal(true);
    // The dialog closes itself once answered.
    expect(dialog()).to.equal(null);
  });

  it('resolves false when cancelled', async () => {
    const { pending } = await ask();
    await act(async () => cancelButton()?.click());

    expect(await pending).to.equal(false);
  });

  it('resolves false on Escape so the caller does nothing', async () => {
    const { pending } = await ask();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });

    expect(await pending).to.equal(false);
    expect(dialog()).to.equal(null);
  });

  it('focuses the confirm button on an ordinary question', async () => {
    const { pending } = await ask(false);
    expect(document.activeElement).to.equal(confirmButton());
    await act(async () => cancelButton()?.click());
    await pending;
  });

  it('focuses Cancel — not the destructive button — on a destructive question', async () => {
    const { pending } = await ask(true);

    // A reflexive Enter on an unread dialog must not delete the workspace.
    expect(document.activeElement).to.equal(cancelButton());
    expect(confirmButton()?.className).to.contain('db-git-primary-btn--danger');

    await act(async () => cancelButton()?.click());
    expect(await pending).to.equal(false);
  });

  it('does not mark an ordinary question as destructive', async () => {
    const { pending } = await ask(false);
    expect(confirmButton()?.className).to.not.contain('--danger');
    await act(async () => cancelButton()?.click());
    await pending;
  });

  it('settles a superseded question rather than stranding its caller', async () => {
    const first = await ask();
    const second = await ask();

    // The first caller must not be left awaiting forever.
    expect(await first.pending).to.equal(false);

    await act(async () => confirmButton()?.click());
    expect(await second.pending).to.equal(true);
  });

  it('settles a pending question when the host unmounts', async () => {
    const { pending } = await ask();

    await act(async () => root.unmount());

    // Would hang forever if unmount did not settle it; the suite timeout
    // is the backstop that proves this assertion is real.
    expect(await pending).to.equal(false);

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

    const { pending } = await ask();
    await act(async () => cancelButton()?.click());
    await pending;

    expect(document.activeElement).to.equal(trigger);
    trigger.remove();
  });

  describe('acknowledge', () => {
    async function tell() {
      let settled = false;
      let pending!: Promise<void>;
      await act(async () => {
        pending = controller.acknowledge({
          title: 'About DocBlocks',
          message: 'DocBlocks 1.2.3',
        });
        void pending.then(() => {
          settled = true;
        });
      });
      return { pending, read: () => settled };
    }

    it('shows the message with a single dismiss button', async () => {
      const { pending } = await tell();

      expect(message()).to.equal('DocBlocks 1.2.3');
      expect(confirmButton()?.textContent).to.equal('OK');
      // No cancel path: an acknowledgement has nothing to decline.
      expect(cancelButton()).to.equal(null);

      await act(async () => confirmButton()?.click());
      await pending;
    });

    it('resolves when dismissed', async () => {
      const { pending, read } = await tell();
      expect(read()).to.equal(false);

      await act(async () => confirmButton()?.click());
      await pending;

      expect(read()).to.equal(true);
      expect(dialog()).to.equal(null);
    });

    it('resolves on Escape — dismissing is acknowledging', async () => {
      const { pending } = await tell();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      });

      // Must not hang: the shell awaits this before continuing.
      await pending;
      expect(dialog()).to.equal(null);
    });

    it('resolves when the host unmounts', async () => {
      const { pending } = await tell();
      await act(async () => root.unmount());
      await pending;

      root = createRoot(container);
      await act(async () => {
        root.render(createElement(Host));
      });
    });
  });
});

/**
 * The shell itself is not unit-renderable (lazy editor chunk, workspace
 * bootstrap, IndexedDB), so its call sites are pinned at the source level.
 * This is the check that actually fails on the shipped SF-6 bug.
 */
describe('no native alert()/confirm()/prompt() in @bendyline/docblocks-react', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

  // Not preceded by a word char or a dot — so `confirmAction(`, `promptForText(`
  // and `promptEvent.prompt(` are fine, but a bare `confirm('…')` is not.
  const NATIVE_DIALOG = /(?<![\w.$])(alert|confirm|prompt)\s*\(/g;

  /**
   * `FileTreeNode` keeps one `window.confirm()` as `defaultConfirmDelete`: the
   * last-resort prompt for a host that passes no `confirmDelete`. It is not the
   * path this product takes -- `<DocBlocksShell>` passes its own dialog, so no
   * user of the shell sees a native prompt -- but `FileTreeNode` is a public
   * export, and silently destroying a document because an embedder wired up no
   * dialog would be worse than an ugly one.
   *
   * So this entry is deliberate, not debt. The companion test below still
   * asserts the file really does contain a native call, so the exemption
   * disappears the moment the fallback does.
   */
  const KNOWN_OFFENDERS = new Set(['FileTreeNode.tsx']);

  function scan(): string[] {
    const offenders: string[] = [];
    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      // `.d.ts` files declare signatures (e.g. BeforeInstallPromptEvent's
      // `prompt()`); they cannot call anything.
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      if (KNOWN_OFFENDERS.has(entry.name)) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      const source = readFileSync(path, 'utf8');
      for (const line of source.split('\n')) {
        // Skip the prose in comments that explains why this rule exists.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (NATIVE_DIALOG.test(line)) offenders.push(`${entry.name}: ${line.trim()}`);
        NATIVE_DIALOG.lastIndex = 0;
      }
    }
    return offenders;
  }

  it('never calls window.alert(), confirm() or prompt()', () => {
    expect(scan()).to.deep.equal([]);
  });

  it('keeps the known-offender allowlist honest', () => {
    // If FileTreeNode is cleaned up, delete its entry rather than letting the
    // allowlist rot into a permanent exemption.
    const stillOffends = readFileSync(join(srcRoot, 'FileExplorer', 'FileTreeNode.tsx'), 'utf8')
      .split('\n')
      .some((line) => !/^\s*(\*|\/\/)/.test(line) && /window\.confirm\s*\(/.test(line));
    expect(
      stillOffends,
      'FileTreeNode.tsx no longer calls window.confirm() — remove it from KNOWN_OFFENDERS',
    ).to.equal(true);
  });
});
