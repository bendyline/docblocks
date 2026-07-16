import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'bendyline.docblocks-vscode';

export async function run(): Promise<void> {
  assert.equal(typeof process.versions.node, 'string', 'desktop extension host must expose Node');
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} was not installed into the desktop extension host`);
  assert.equal(extension.packageJSON.main, './dist/extension.js');
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'docblocks.openEditor',
    'docblocks.openInDocBlocks',
    'docblocks.openSetup',
    'docblocks.documentStatusAction',
  ]) {
    assert.ok(commands.has(command), `desktop extension host did not register ${command}`);
  }

  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'desktop extension-host test workspace was not opened');
  const documentUri = vscode.Uri.joinPath(workspace.uri, 'test-doc.md');
  const document = await vscode.workspace.openTextDocument(documentUri);
  assert.match(document.getText(), /Test Document/u);

  await vscode.commands.executeCommand(
    'vscode.openWith',
    documentUri,
    'docblocks.markdownEditor',
    vscode.ViewColumn.Active,
  );
  await waitFor(
    () =>
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom &&
      vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType ===
        'docblocks.markdownEditor',
    'desktop custom editor did not become the active tab',
  );

  await vscode.commands.executeCommand('docblocks.openSetup');
  await waitFor(
    () => findTab('DocBlocks Setup') !== undefined,
    'desktop setup webview did not open',
  );
  const setupTab = findTab('DocBlocks Setup');
  assert.ok(setupTab?.input instanceof vscode.TabInputWebview);
  assert.match(setupTab.input.viewType, /(?:^|-)docblocks\.setupView$/u);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function findTab(label: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => [...group.tabs])
    .find((tab) => tab.label === label);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
