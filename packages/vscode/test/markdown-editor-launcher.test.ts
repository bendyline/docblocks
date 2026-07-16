import { expect } from 'chai';
import {
  installVscodeStub,
  uninstallVscodeStub,
  FakeTextDocument,
  FakeUri,
  FakeWebviewPanel,
  type VscodeStub,
} from './helpers/vscodeStub.js';

/**
 * The launcher imports `vscode` (directly and through MarkdownEditorPanel), so
 * it can only be required after the fake module is installed.
 */
interface LauncherModule {
  MarkdownEditorLauncher: new (context: unknown) => {
    resolveCustomTextEditor(
      document: unknown,
      panel: unknown,
      token: unknown,
    ): Thenable<void> | void;
  };
}

interface PanelModule {
  MarkdownEditorPanel: { disposeAll(): Promise<void> };
}

let stub: VscodeStub;
let launcherModule: LauncherModule;
let panelModule: PanelModule;

const DOCUMENT_PATH = '/workspace/huge.md';
// Mirrors HOST_WIRE_LIMITS.documentCharacters, the bound toHostSnapshot throws on.
const DOCUMENT_CHARACTER_LIMIT = 20 * 1024 * 1024;

function createContext(): unknown {
  return { extensionUri: new FakeUri('/extension'), subscriptions: [] };
}

const liveToken = { isCancellationRequested: false };

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('MarkdownEditorLauncher', () => {
  before(async () => {
    stub = installVscodeStub();
    launcherModule =
      (await import('../src/markdownEditorLauncher.js')) as unknown as LauncherModule;
    panelModule = (await import('../src/markdownEditorPanel.js')) as unknown as PanelModule;
  });

  after(() => {
    uninstallVscodeStub();
  });

  beforeEach(() => {
    stub = installVscodeStub();
    stub.configuration.set('docblocks.autoSave', false);
  });

  afterEach(async () => {
    await panelModule.MarkdownEditorPanel.disposeAll();
  });

  /**
   * DocBlocks claims every *.md file with `priority: "default"`, so this is the
   * editor VS Code opens when a markdown file is clicked. A document over the
   * wire limit used to reject the resolve: the panel was disposed, our toast
   * and VS Code's own resolve failure both fired, and the file could not be
   * opened at all. It has to degrade to an explanation plus a way out instead.
   */
  describe('a document larger than the editor wire limit', () => {
    function createOversizeDocument(): FakeTextDocument {
      const document = new FakeTextDocument(
        new FakeUri(DOCUMENT_PATH),
        'a'.repeat(DOCUMENT_CHARACTER_LIMIT + 1),
      );
      stub.documents.push(document);
      return document;
    }

    it('explains the limit in the panel instead of failing the resolve', async () => {
      const document = createOversizeDocument();
      const panel = new FakeWebviewPanel();
      const launcher = new launcherModule.MarkdownEditorLauncher(createContext());

      await launcher.resolveCustomTextEditor(document, panel, liveToken);
      await settle();

      // A live tab with an explanation, not a disposed one with two errors.
      expect(panel.disposed).to.equal(false);
      expect(stub.errorMessages).to.deep.equal([]);
      expect(panel.webview.html).to.contain('too large');
      expect(panel.webview.html).to.contain('20 MB');
    });

    it('offers a text-editor fallback and reopens with the built-in editor', async () => {
      const document = createOversizeDocument();
      const panel = new FakeWebviewPanel();
      const launcher = new launcherModule.MarkdownEditorLauncher(createContext());
      stub.warningResponse = 'Reopen with Text Editor';

      await launcher.resolveCustomTextEditor(document, panel, liveToken);
      await settle();

      expect(stub.warningMessages.join('\n')).to.contain('larger than the 20 MB');
      expect(stub.executedCommands).to.have.lengthOf(1);
      const [reopen] = stub.executedCommands;
      expect(reopen.command).to.equal('vscode.openWith');
      expect(reopen.args[0]).to.equal(document.uri);
      expect(reopen.args[1]).to.equal('default');
    });

    it('does not reopen when the warning is dismissed', async () => {
      const document = createOversizeDocument();
      const panel = new FakeWebviewPanel();
      const launcher = new launcherModule.MarkdownEditorLauncher(createContext());
      stub.warningResponse = undefined;

      await launcher.resolveCustomTextEditor(document, panel, liveToken);
      await settle();

      expect(stub.executedCommands).to.deep.equal([]);
      expect(panel.disposed).to.equal(false);
    });
  });

  describe('a document within the wire limit', () => {
    it('still opens the real DocBlocks editor', async () => {
      const document = new FakeTextDocument(new FakeUri('/workspace/small.md'), '# small\n');
      stub.documents.push(document);
      const panel = new FakeWebviewPanel();
      const launcher = new launcherModule.MarkdownEditorLauncher(createContext());

      await launcher.resolveCustomTextEditor(document, panel, liveToken);
      panel.onDidReceiveMessageEmitter.fire({ type: 'ready' });
      await settle();

      // The oversize guard must not intercept ordinary documents: this panel
      // gets the real webview bundle and the setContent handshake.
      expect(stub.warningMessages).to.deep.equal([]);
      expect(stub.executedCommands).to.deep.equal([]);
      expect(panel.posted.some((m) => (m as { type?: string }).type === 'setContent')).to.equal(
        true,
      );
    });
  });
});
