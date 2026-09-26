import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { DB_BREAKPOINTS } from '../src/layout/form-factor.js';

const styles = readFileSync(
  fileURLToPath(new URL('../src/styles/docblocks.css', import.meta.url)),
  'utf8',
);

describe('adaptive styles', () => {
  it('branches on stamped attributes, never on a width media query', () => {
    // The whole point of the token layer: TypeScript owns the breakpoints and
    // CSS reads them as attributes. A `@media (max-width:` or `min-width:` rule
    // here means a second, silently diverging source of truth.
    const widthQueries = styles.match(/@media[^{]*\((?:max|min)-width:[^)]*\)/g) ?? [];
    expect(
      widthQueries,
      `unexpected width media queries: ${widthQueries.join(', ')}`,
    ).to.deep.equal([]);
  });

  it('keeps only the media queries that cannot be attributes', () => {
    const queries = (styles.match(/@media[^{]*/g) ?? []).map((query) => query.trim());
    for (const query of queries) {
      expect(query).to.match(/prefers-color-scheme|prefers-reduced-motion|display-mode/);
    }
  });

  it('defines the adaptive tokens on :root so portalled menus inherit them', () => {
    // Squisq renders its menus and dialogs into <body>, outside .db-shell.
    expect(styles).to.match(/^:root,\r?\n\.db-shell \{[^}]*--db-target-min: 28px;/ms);
    expect(styles).to.match(/^:root,\r?\n\.db-shell \{[^}]*--db-input-font-size: 13px;/ms);
  });

  it('raises hit targets and input text on a coarse pointer', () => {
    const block = /\[data-db-pointer='coarse'\] \{([^}]*)\}/s.exec(styles)?.[1] ?? '';
    expect(block).to.include('--db-target-min: 44px;');
    expect(block).to.include('--db-control-size: 40px;');
    expect(block).to.include('--db-row-min-height: 44px;');
    // Anything below 16px makes iOS Safari zoom when the field takes focus.
    expect(block).to.include('--db-input-font-size: 16px;');
  });

  it('routes every focusable text control through the input font token', () => {
    // Each of these is a real <input>, <select>, or <textarea>. A hard-coded
    // 13px on any of them is an iOS focus-zoom trap.
    const controls = [
      'db-transient-move-select',
      'db-new-item-input',
      'db-tree-rename-input',
      'db-workspace-create-input',
      'db-settings-select-input',
      'db-export-select',
      'db-export-path-input',
      'db-git-commit-message',
      'db-git-form-input',
    ];
    for (const control of controls) {
      const rule = new RegExp(`\\.${control} \\{[^}]*\\}`, 's').exec(styles)?.[0] ?? '';
      expect(rule, `${control} rule missing`).to.not.equal('');
      expect(rule, `${control} must use --db-input-font-size`).to.include(
        'font-size: var(--db-input-font-size)',
      );
    }
  });

  it('sizes the shell with dvh behind an @supports guard, not a var() fallback', () => {
    // A var() resolving to an unsupported unit is invalid-at-computed-value-time
    // and becomes `unset`, collapsing the shell — it does NOT fall back to the
    // previous declaration. The guard is load-bearing.
    expect(styles).to.match(
      /@supports \(height: 100dvh\) \{\s*\.db-shell \{[^}]*--db-shell-block-size/s,
    );
    expect(styles).to.match(/\.db-shell \{[^}]*height: 100vh;/s);
  });

  it('drops the drawer transform once open so fixed modals escape it', () => {
    // .db-dialog-overlay is `position: fixed; inset: 0` and is rendered inside
    // the sidebar rather than portalled to <body>. Any non-none transform on
    // the sidebar makes it the containing block for that overlay, so every
    // dialog opened from the app menu gets sized and clipped to the drawer.
    const openRule =
      /\[data-db-layout='single-pane'\]\[data-db-drawer='open'\] \.db-shell-sidebar \{([^}]*)\}/s.exec(
        styles,
      )?.[1] ?? '';
    expect(openRule, 'open-drawer rule missing').to.not.equal('');
    expect(openRule).to.include('transform: none;');
  });

  it('reveals hover-only affordances from any-hover, not from width', () => {
    expect(styles).to.include("[data-db-hover='none'] .db-tree-more");
    expect(styles).to.not.match(/@media \(hover: none\)/);
  });

  it('publishes safe-area insets as tokens and consumes them in the sidebar chrome', () => {
    expect(styles).to.include('--db-safe-top: env(safe-area-inset-top, 0px);');
    expect(styles).to.include('--db-safe-bottom: env(safe-area-inset-bottom, 0px);');
    expect(styles).to.match(/\.db-shell-sidebar-header \{[^}]*var\(--db-safe-top\)/s);
    expect(styles).to.match(/\.db-shell-sidebar-footer \{[^}]*var\(--db-safe-bottom\)/s);
    // The inset belongs on the pane DocBlocks owns. Setting padding-bottom on
    // .squisq-status-bar replaces Squisq's own padding instead of adding to it.
    expect(styles).to.match(
      /\.db-shell-editor-area \{[^}]*var\(--db-safe-bottom\) \+ var\(--db-keyboard-inset\)/s,
    );
    expect(styles).to.not.match(/\.squisq-status-bar \{[^}]*padding-bottom/s);
  });

  it('keeps pinch-zoom available while removing the double-tap delay', () => {
    // `touch-action: none` here would disable pinch-zoom of the document, an
    // accessibility regression. `manipulation` only drops double-tap zoom.
    expect(styles).to.match(/\.db-shell \{[^}]*touch-action: manipulation;/s);
  });

  it('agrees with the breakpoints TypeScript publishes', () => {
    // Guards the comment in the token block from drifting from the module.
    expect(DB_BREAKPOINTS.compactMax).to.equal(720);
    expect(DB_BREAKPOINTS.mediumMax).to.equal(1023);
    expect(DB_BREAKPOINTS.expandedMax).to.equal(1439);
  });
});
