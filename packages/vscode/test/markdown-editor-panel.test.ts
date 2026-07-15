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
      expect(stub.warningMessages.join('\n')).to.contain('changed outside DocBlocks');
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

      expect(stub.warningMessages.join('\n')).to.contain('changed outside DocBlocks');
    });
  });
});
