import { expect } from 'chai';
import { installVscodeStub, uninstallVscodeStub, type VscodeStub } from './helpers/vscodeStub.js';

/**
 * SetupViewProvider imports `vscode`, so it can only be required after the fake
 * module is installed — hence the lazy loader rather than a static import.
 */
interface SetupViewProviderModule {
  SetupViewProvider: {
    createOrShow(): void;
  };
}

let stub: VscodeStub;
let setupModule: SetupViewProviderModule;

// Every hook stays inside this suite on purpose: hooks declared at file scope
// attach to Mocha's root suite and would then run against every test in every
// package of the monorepo run.
describe('SetupViewProvider', () => {
  before(async () => {
    stub = installVscodeStub();
    setupModule =
      (await import('../src/setupViewProvider.js')) as unknown as SetupViewProviderModule;
  });

  after(() => {
    uninstallVscodeStub();
  });

  beforeEach(() => {
    stub = installVscodeStub();
  });

  it('releases its message listener when the setup panel closes', () => {
    setupModule.SetupViewProvider.createOrShow();

    const panel = stub.createdWebviewPanels[0];
    if (!panel) throw new Error('Expected createOrShow to create a setup panel');
    expect(panel.onDidReceiveMessageEmitter.listenerCount).to.equal(1);

    panel.dispose();

    // The listener closes over a fresh provider and a now-dead webview. Its
    // lifetime is the panel's; parking it in context.subscriptions instead kept
    // all three alive until deactivate.
    expect(panel.onDidReceiveMessageEmitter.listenerCount).to.equal(0);
  });

  it('does not accumulate listeners across repeated open/close cycles', () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      setupModule.SetupViewProvider.createOrShow();
      const panel = stub.createdWebviewPanels[cycle];
      if (!panel) throw new Error(`Expected a setup panel for cycle ${cycle}`);
      panel.dispose();
    }

    expect(stub.createdWebviewPanels).to.have.length(3);
    const liveListeners = stub.createdWebviewPanels.reduce(
      (total, panel) => total + panel.onDidReceiveMessageEmitter.listenerCount,
      0,
    );
    expect(liveListeners).to.equal(0);
  });

  it('reveals the existing panel rather than creating a second one', () => {
    setupModule.SetupViewProvider.createOrShow();
    setupModule.SetupViewProvider.createOrShow();

    expect(stub.createdWebviewPanels).to.have.length(1);
    expect(stub.createdWebviewPanels[0]?.revealCount).to.equal(1);
    stub.createdWebviewPanels[0]?.dispose();
  });
});
