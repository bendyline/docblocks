import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_INTERFACE_FONT,
  loadInterfaceFont,
  saveInterfaceFont,
} from '../src/preferences/theme.js';
import { INTERFACE_FONT_ATTRIBUTE } from '../src/layout/useInterfaceFontAttribute.js';

/**
 * The interface-font preference decides whether the shell chrome uses the
 * bundled face or follows the operating system.
 *
 * It is a user-facing choice: the bundled face renders the same chrome on every
 * operating system, while the system stack resolves a different typeface on
 * each platform.
 */
describe('interface font preference', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('uses the bundled face until someone chooses otherwise', () => {
    // The default is the bundled Hanken Grotesk face, so the app and
    // docblocks.com share one typeface and every OS renders the same chrome.
    expect(DEFAULT_INTERFACE_FONT).to.equal('fixed');
    expect(loadInterfaceFont()).to.equal('fixed');
  });

  it('round-trips both choices', () => {
    saveInterfaceFont('fixed');
    expect(loadInterfaceFont()).to.equal('fixed');
    saveInterfaceFont('system');
    expect(loadInterfaceFont()).to.equal('system');
  });

  it('ignores a stored value it does not recognise', () => {
    localStorage.setItem('docblocks:interfaceFont', 'roboto-ultra');
    expect(loadInterfaceFont()).to.equal('fixed');
  });

  it('reads the key the E2E specs seed', () => {
    // The E2E specs set this key directly through addInitScript, before any
    // application code runs, so the name is part of that contract.
    localStorage.setItem('docblocks:interfaceFont', 'fixed');
    expect(loadInterfaceFont()).to.equal('fixed');
  });

  it('survives storage being unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      expect(loadInterfaceFont()).to.equal('fixed');
      expect(() => saveInterfaceFont('system')).to.not.throw();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });

  it('names the root attribute the stylesheet keys off', () => {
    // Bound on the document root rather than the shell because Squisq portals
    // its menus onto <body>; a selector scoped to .db-shell would leave those
    // on the system stack while the shell switched.
    expect(INTERFACE_FONT_ATTRIBUTE).to.equal('data-db-interface-font');
  });

  describe('the stylesheet contract', () => {
    const stylesheet = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/docblocks.css'),
      'utf8',
    );

    it('declares the chrome typeface as one token, defaulting to the bundled face', () => {
      expect(stylesheet).to.match(/--db-ui-font:\s*'DocBlocks Fixed UI'/u);
    });

    it('swaps that token for the system stack under the root attribute', () => {
      expect(stylesheet).to.contain("[data-db-interface-font='system']");
      expect(stylesheet).to.match(/--db-ui-font:\s*system-ui/u);
    });

    it('carries the chrome face into Squisq by default, not only in one mode', () => {
      // Squisq portals its menus onto <body>; the bridge has to be bound on the
      // root palette block or a menu keeps Squisq's own stack.
      const rootBlock = stylesheet.slice(0, stylesheet.indexOf('/* ── Adaptive tokens'));
      expect(rootBlock).to.contain('--squisq-ux-font: var(--db-ui-font);');
    });

    it('routes every chrome font declaration through the token', () => {
      // A new rule that names `system-ui` directly would keep following the OS
      // even with the bundled face selected — invisible until a baseline
      // disagreed across platforms. The two token declarations above are the
      // only allowed uses.
      // Comments mention the stack by name, so they are stripped first.
      const rules = stylesheet.replace(/\/\*[\s\S]*?\*\//gu, '');
      const systemUiUses = [...rules.matchAll(/system-ui/gu)].length;
      const tokenDeclarations = [...rules.matchAll(/--db-ui-font:/gu)].length;
      expect(
        systemUiUses,
        'system-ui should appear only inside the --db-ui-font declarations',
      ).to.equal(tokenDeclarations);
    });
  });
});
