import { expect } from 'chai';
import {
  resolveVscodeBodyTheme,
  readVscodeBodyTheme,
  type VscodeColorScheme,
} from '../webview/src/vscodeBodyTheme.js';
import { installVscodeStub, uninstallVscodeStub, type VscodeStub } from './helpers/vscodeStub.js';

/**
 * `webviewHelper` imports `vscode`, so it can only be required after the fake
 * module is installed — hence the lazy loader rather than a static import.
 */
interface WebviewHelperModule {
  getVscodeTheme(): VscodeColorScheme;
}

/**
 * The body classes VS Code applies for each `ColorThemeKind`, mirroring
 * `applyStyles` in its webview host page
 * (`out/vs/workbench/contrib/webview/browser/pre/index.html`). High-contrast
 * light carries `vscode-high-contrast` too, "for backwards compatibility".
 */
const BODY_CLASSES_BY_KIND: Record<number, string[]> = {
  1: ['vscode-light'],
  2: ['vscode-dark'],
  3: ['vscode-high-contrast'],
  4: ['vscode-high-contrast-light', 'vscode-high-contrast'],
};

function setBodyClasses(classes: string[]): void {
  document.body.className = classes.join(' ');
}

describe('VS Code webview theme', () => {
  afterEach(() => {
    document.body.className = '';
  });

  describe('body class mapping', () => {
    it('maps every VS Code theme class to a scheme', () => {
      expect(resolveVscodeBodyTheme(['vscode-light'])).to.equal('light');
      expect(resolveVscodeBodyTheme(['vscode-dark'])).to.equal('dark');
      expect(resolveVscodeBodyTheme(['vscode-high-contrast'])).to.equal('dark');
      expect(resolveVscodeBodyTheme(['vscode-high-contrast-light'])).to.equal('light');
    });

    it('keeps high-contrast light on the light branch despite its compatibility class', () => {
      // VS Code stamps both classes for HC light. Testing `vscode-high-contrast`
      // first would resolve dark and contradict the host.
      expect(
        resolveVscodeBodyTheme(['vscode-high-contrast-light', 'vscode-high-contrast']),
      ).to.equal('light');
      expect(
        resolveVscodeBodyTheme(['vscode-high-contrast', 'vscode-high-contrast-light']),
      ).to.equal('light');
    });

    it('reports no theme class rather than guessing', () => {
      expect(resolveVscodeBodyTheme([])).to.equal(null);
      expect(resolveVscodeBodyTheme(['vscode-reduce-motion', 'some-other-class'])).to.equal(null);
    });
  });

  describe('reading the live document', () => {
    it('reads each theme VS Code has already stamped on <body>', () => {
      for (const [kind, classes] of Object.entries(BODY_CLASSES_BY_KIND)) {
        setBodyClasses(classes);
        const expected = Number(kind) === 2 || Number(kind) === 3 ? 'dark' : 'light';
        expect(readVscodeBodyTheme(), `kind ${kind}`).to.equal(expected);
      }
    });

    it('ignores unrelated body classes VS Code sets alongside the theme', () => {
      setBodyClasses(['vscode-light', 'vscode-reduce-motion', 'vscode-using-screen-reader']);
      expect(readVscodeBodyTheme()).to.equal('light');
    });

    it('falls back to light when no theme class is present', () => {
      // Only reachable outside a real VS Code webview; must not be 'dark',
      // which is the dark-by-default bug this seeding replaces.
      setBodyClasses([]);
      expect(readVscodeBodyTheme()).to.equal('light');
    });
  });

  describe('agreement with the extension host', () => {
    let stub: VscodeStub;
    let helper: WebviewHelperModule;

    before(async () => {
      stub = installVscodeStub();
      helper = (await import('../src/webviewHelper.js')) as unknown as WebviewHelperModule;
    });

    after(() => {
      uninstallVscodeStub();
    });

    it('resolves the same scheme as the host for every ColorThemeKind', () => {
      const window = stub.module.window as { activeColorTheme: { kind: number } };
      for (const [kind, classes] of Object.entries(BODY_CLASSES_BY_KIND)) {
        window.activeColorTheme.kind = Number(kind);
        // The host reads the ColorThemeKind enum; the webview reads the body
        // class VS Code derives from that same kind. Different inputs, one
        // intent — they must never disagree, least of all on high contrast.
        expect(resolveVscodeBodyTheme(classes), `kind ${kind}`).to.equal(helper.getVscodeTheme());
      }
    });

    it('covers every ColorThemeKind the installed VS Code API declares', () => {
      // Guards against a future API version adding a kind that the body-class
      // table above silently stops accounting for.
      const kinds = stub.module.ColorThemeKind as Record<string, number>;
      const declared = Object.values(kinds).sort();
      expect(declared).to.deep.equal(Object.keys(BODY_CLASSES_BY_KIND).map(Number).sort());
    });
  });
});
