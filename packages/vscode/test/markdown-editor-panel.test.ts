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
 * MarkdownEditorPanel imports `vscode`, so it can only be required after the
 * fake module is installed. Everything below therefore goes through this lazy
 * loader rather than a static import.
 */
interface MarkdownEditorPanelModule {
  MarkdownEditorPanel: {
    attachCustomEditor(context: unknown, document: unknown, panel: unknown): Promise<void>;
    disposeAll(): Promise<void>;
  };
}

let stub: VscodeStub;
let panelModule: MarkdownEditorPanelModule;

const DOCUMENT_PATH = '/workspace/notes.md';

function createContext(): unknown {
  return { extensionUri: new FakeUri('/extension'), subscriptions: [] };
}

interface OpenedPanel {
  document: FakeTextDocument;
  panel: FakeWebviewPanel;
  sessionId: string;
}

/** Attach the editor to a document and drive the webview handshake. */
async function openPanel(initialText: string): Promise<OpenedPanel> {
  const document = new FakeTextDocument(new FakeUri(DOCUMENT_PATH), initialText);
  stub.documents.push(document);
  const panel = new FakeWebviewPanel();

  await panelModule.MarkdownEditorPanel.attachCustomEditor(createContext(), document, panel);
  panel.onDidReceiveMessageEmitter.fire({ type: 'ready' });
  await settle();

  const setContent = panel.posted.find(
    (message): message is { type: 'setContent'; sessionId: string } =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'setContent',
  );
  if (!setContent) throw new Error('Expected the panel to send setContent after ready');
  return { document, panel, sessionId: setContent.sessionId };
}

/** Deliver an editor snapshot the way the webview would. */
function sendEdit(
  panel: FakeWebviewPanel,
  sessionId: string,
  content: string,
  clientRevision = 1,
): void {
  panel.onDidReceiveMessageEmitter.fire({
    type: 'edit',
    sessionId,
    clientRevision,
    baseDocumentVersion: 1,
    content,
  });
}

/** Deliver a manual-save request the way the webview's Save control would. */
function sendSave(
  panel: FakeWebviewPanel,
  sessionId: string,
  clientRevision: number,
  requestId = 1,
): void {
  panel.onDidReceiveMessageEmitter.fire({
    type: 'save',
    sessionId,
    requestId,
    clientRevision,
    baseDocumentVersion: 1,
  });
}

interface SetContentMessage {
  type: 'setContent';
  content: string;
}

/** The content the webview is currently displaying, per the last setContent. */
function findLastSetContent(panel: FakeWebviewPanel): string | undefined {
  const contents = panel.posted.filter(
    (message): message is SetContentMessage =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'setContent',
  );
  return contents.at(-1)?.content;
}

interface SaveResultMessage {
  type: 'saveResult';
  ok: boolean;
  message: string | null;
}

function findSaveResult(panel: FakeWebviewPanel): SaveResultMessage | undefined {
  return panel.posted.find(
    (message): message is SaveResultMessage =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'saveResult',
  );
}

/** Close the tab exactly as VS Code does, then await the close-time flush. */
async function closeTab(panel: FakeWebviewPanel): Promise<void> {
  panel.dispose();
  await panelModule.MarkdownEditorPanel.disposeAll();
  await settle();
}

/** Let the session's queues, coalescing, and commit promises drain. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Every hook stays inside this suite on purpose: hooks declared at file scope
// attach to Mocha's root suite and would then run against every test in every
// package of the monorepo run.
describe('MarkdownEditorPanel', () => {
  before(async () => {
    stub = installVscodeStub();
    panelModule =
      (await import('../src/markdownEditorPanel.js')) as unknown as MarkdownEditorPanelModule;
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

  describe('close path', () => {
    it('flushes an unsaved draft to the real document when the tab closes', async () => {
      const { document, panel, sessionId } = await openPanel('# original\n');
      sendEdit(panel, sessionId, '# edited\n');
      await settle();

      // VS Code disposes the panel before the close-time flush runs, so the
      // flush executes against a panel whose title/active accessors throw.
      await closeTab(panel);

      expect(document.savedText).to.equal('# edited\n');
      expect(stub.errorMessages).to.deep.equal([]);
      expect(stub.untitledDocuments).to.deep.equal([]);
    });

    it('does not report a spurious save failure when a clean tab closes', async () => {
      const { panel } = await openPanel('# original\n');

      await closeTab(panel);

      // prepareClose emits synchronously even with nothing to save, which used
      // to drive updateTitle straight into "Webview is disposed".
      expect(stub.errorMessages).to.deep.equal([]);
    });

    it('accepts an edit still queued when the tab closes', async () => {
      const { document, panel, sessionId } = await openPanel('# original\n');
      // No settle: the edit is still queued, so it is applied by the close-time
      // latestEditQueue.flush(). A throw there is swallowed by acceptEdit and
      // reported as a rejected edit even though the session already took it.
      sendEdit(panel, sessionId, '# queued at close\n');

      await closeTab(panel);

      expect(document.savedText).to.equal('# queued at close\n');
      expect(stub.errorMessages).to.deep.equal([]);
    });

    it('leaves the disposed panel untouched instead of throwing', async () => {
      const { panel, sessionId } = await openPanel('# original\n');
      sendEdit(panel, sessionId, '# edited\n');
      await settle();
      // The dirty marker is the last title written while the panel was alive.
      expect(panel.peekTitle()).to.equal('* notes.md');

      await closeTab(panel);

      // The close-time flush reaches a saved session and would repaint the
      // title without the guard; the panel is gone, so it must stay frozen.
      expect(panel.peekTitle()).to.equal('* notes.md');
      expect(stub.errorMessages).to.deep.equal([]);
    });
  });

  describe('opening an already-open document', () => {
    it('reveals the live editor instead of failing the resolve', async () => {
      const { panel: firstPanel } = await openPanel('# original\n');
      const document = stub.documents[0];
      const duplicatePanel = new FakeWebviewPanel();

      // VS Code resolves its custom editor against a document DocBlocks already
      // owns (it is open through the explicit command route, whose panel VS
      // Code does not know about). A rejected resolve becomes an error toast on
      // a broken tab, so this must succeed.
      await panelModule.MarkdownEditorPanel.attachCustomEditor(
        createContext(),
        document,
        duplicatePanel,
      );

      expect(stub.errorMessages).to.deep.equal([]);
      expect(duplicatePanel.disposed).to.equal(true);
      expect(firstPanel.disposed).to.equal(false);
      expect(firstPanel.revealCount).to.equal(1);
    });

    it('keeps the live editor session working after the duplicate is closed', async () => {
      const { panel, sessionId } = await openPanel('# original\n');
      const document = stub.documents[0];

      await panelModule.MarkdownEditorPanel.attachCustomEditor(
        createContext(),
        document,
        new FakeWebviewPanel(),
      );

      // The duplicate must not have displaced the registered panel: the
      // original session still owns the document and still commits.
      sendEdit(panel, sessionId, '# edited\n');
      await closeTab(panel);

      expect(document.savedText).to.equal('# edited\n');
      expect(stub.errorMessages).to.deep.equal([]);
    });
  });

  describe('link navigation', () => {
    beforeEach(() => {
      stub.workspaceFolders.push({ uri: new FakeUri('/workspace'), name: 'workspace', index: 0 });
    });

    it('opens a workspace-relative file in a non-preview VS Code tab', async () => {
      const { panel } = await openPanel('# links\n');

      panel.onDidReceiveMessageEmitter.fire({
        type: 'openLink',
        href: 'docs-src/guide/agent-loop.md#the-loop',
      });
      await settle();

      expect(stub.executedCommands).to.have.length(1);
      expect(stub.executedCommands[0]?.command).to.equal('vscode.open');
      expect((stub.executedCommands[0]?.args[0] as FakeUri).path).to.equal(
        '/workspace/docs-src/guide/agent-loop.md',
      );
      expect(stub.executedCommands[0]?.args[1]).to.deep.equal({ preview: false });
    });

    it('opens canonical HTTP(S) links through VS Code', async () => {
      const { panel } = await openPanel('# links\n');

      panel.onDidReceiveMessageEmitter.fire({
        type: 'openLink',
        href: 'https://example.com/docs/../guide',
      });
      await settle();

      expect(stub.externalUris.map((uri) => uri.toString())).to.deep.equal([
        'https://example.com/guide',
      ]);
      expect(stub.executedCommands).to.deep.equal([]);
    });

    it('rejects local links that escape the workspace', async () => {
      const { panel } = await openPanel('# links\n');

      panel.onDidReceiveMessageEmitter.fire({ type: 'openLink', href: '../outside.md' });
      await settle();

      expect(stub.executedCommands).to.deep.equal([]);
      expect(stub.externalUris).to.deep.equal([]);
      expect(stub.warningMessages).to.deep.equal([
        'DocBlocks only opens HTTP(S) links or files inside the current workspace.',
      ]);
    });
  });

  describe('bursts of external changes', () => {
    /**
     * The panel's bounded message queue holds 128 pending operations, and it is
     * shared with webview requests that await a *modal* dialog inside the queued
     * operation (pickExportTarget/saveExport both await showSaveDialog). While
     * such an operation stalls the tail, nothing drains, so every external
     * change accumulates. A burst larger than the bound used to be dropped
     * newest-first, leaving the webview pinned to a stale snapshot with no
     * conflict indication. The newest snapshot is the only one that still
     * exists, so it must never be the one that is discarded.
     */
    const BURST = 200;

    function fireExternalBurst(document: FakeTextDocument): string {
      let lastText = document.getText();
      for (let index = 1; index <= BURST; index += 1) {
        lastText = `# external ${index}\n`;
        document.setText(lastText);
        stub.onDidChangeTextDocumentEmitter.fire({
          document,
          contentChanges: [{ text: lastText }],
        });
      }
      return lastText;
    }

    it('shows the newest external snapshot after a burst larger than the queue bound', async () => {
      const { document, panel } = await openPanel('# original\n');

      const lastText = fireExternalBurst(document);
      await settle();

      expect(document.getText()).to.equal(lastText);
      expect(findLastSetContent(panel)).to.equal(lastText);
      expect(stub.errorMessages).to.deep.equal([]);
    });

    it('conflicts against the newest external snapshot when the session is dirty', async () => {
      const { document, panel, sessionId } = await openPanel('# original\n');
      sendEdit(panel, sessionId, '# local draft\n');
      await settle();

      const lastText = fireExternalBurst(document);
      await settle();

      // A dirty session must surface the burst as a conflict rather than
      // silently ignoring the snapshots that overflowed the queue.
      expect(stub.warningMessages.join('\n')).to.contain(
        'VS Code buffer changed outside this DocBlocks editor',
      );
      expect(document.getText()).to.equal(lastText);
    });

    it('confirms the live VS Code buffer before reporting a queued conflict', async () => {
      const { document, panel, sessionId } = await openPanel('# original\n');
      sendEdit(panel, sessionId, '# local draft\n');
      await settle();

      document.setText('# transient external snapshot\n');
      stub.onDidChangeTextDocumentEmitter.fire({
        document,
        contentChanges: [{ text: '# transient external snapshot\n' }],
      });
      // The buffer converges before the queued observer runs. The observer
      // must verify the live document instead of prompting from the obsolete
      // event snapshot.
      document.setText('# original\n');
      await settle();

      expect(stub.warningMessages).to.deep.equal([]);
      expect(document.getText()).to.equal('# original\n');
    });

    it('ignores VS Code document events with no content changes', async () => {
      const { document, panel, sessionId } = await openPanel('# original\n');
      sendEdit(panel, sessionId, '# local draft\n');
      await settle();

      stub.onDidChangeTextDocumentEmitter.fire({ document, contentChanges: [] });
      await settle();

      expect(stub.warningMessages).to.deep.equal([]);
    });
  });

  describe('manual save overtaken by a newer edit', () => {
    it('saves the latest revision instead of reporting a revision mismatch', async () => {
      const { document, panel, sessionId } = await openPanel('# original\n');
      sendEdit(panel, sessionId, '# at Ctrl+S\n', 1);
      await settle();

      // Ctrl+S, then the user keeps typing before the save request is
      // processed. The edit takes the fast LatestDocumentEditQueue while the
      // save waits in the bounded message queue, so revision 2 is acknowledged
      // first and the save request for revision 1 arrives stale.
      sendSave(panel, sessionId, 1);
      sendEdit(panel, sessionId, '# typed after Ctrl+S\n', 2);
      await settle();

      const saveResult = findSaveResult(panel);
      expect(saveResult?.ok, saveResult?.message ?? 'no saveResult was posted').to.equal(true);
      expect(document.savedText).to.equal('# typed after Ctrl+S\n');
      expect(stub.errorMessages).to.deep.equal([]);
    });
  });

  describe('save participants', () => {
    it('does not conflict when trimTrailingWhitespace rewrites our own save', async () => {
      stub.configuration.set('files.trimTrailingWhitespace', true);
      const { document, panel, sessionId } = await openPanel('# original\n');
      document.saveParticipant = (text) => text.replace(/[^\S\n]+$/gmu, '');
      // A markdown hard line break is exactly what the trim participant eats.
      sendEdit(panel, sessionId, 'hard break  \nnext line\n');
      await settle();

      await closeTab(panel);

      expect(document.savedText).to.equal('hard break\nnext line\n');
      expect(stub.errorMessages).to.deep.equal([]);
      expect(stub.warningMessages).to.deep.equal([]);
    });

    it('still conflicts when an external edit lands during the save window', async () => {
      stub.configuration.set('files.trimTrailingWhitespace', true);
      const { document, panel, sessionId } = await openPanel('# original\n');
      // Not a whitespace transformation of our write: someone else's content.
      document.saveParticipant = () => '# someone else entirely\n';
      sendEdit(panel, sessionId, '# edited\n');
      await settle();

      stub.warningResponse = undefined;
      await closeTab(panel);

      // Forgiving trailing whitespace must not forgive a competing edit: the
      // user is asked, and the draft is preserved rather than dropped.
      expect(stub.warningMessages.join('\n')).to.contain(
        'VS Code buffer changed outside this DocBlocks editor',
      );
      expect(stub.untitledDocuments.map((draft) => draft.getText())).to.deep.equal(['# edited\n']);
    });

    it('conflicts on a trailing-whitespace rewrite when the setting is off', async () => {
      stub.configuration.set('files.trimTrailingWhitespace', false);
      const { document, panel, sessionId } = await openPanel('# original\n');
      // No participant is configured, so this rewrite is an unexplained change.
      document.saveParticipant = (text) => text.replace(/[^\S\n]+$/gmu, '');
      sendEdit(panel, sessionId, 'hard break  \nnext line\n');
      await settle();

      stub.warningResponse = undefined;
      await closeTab(panel);

      expect(stub.warningMessages.join('\n')).to.contain(
        'VS Code buffer changed outside this DocBlocks editor',
      );
    });
  });
});
