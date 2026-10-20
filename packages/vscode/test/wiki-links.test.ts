import { expect } from 'chai';
import {
  installVscodeStub,
  uninstallVscodeStub,
  FakeUri,
  FakeFileSystemError,
  type VscodeStub,
} from './helpers/vscodeStub.js';
import {
  parseExtensionToWebviewMessage,
  parseWebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';

type WikiModule = typeof import('../src/wikiLinks.js');
let wiki: WikiModule;
let stub: VscodeStub;
const root = new FakeUri('/wiki');
const source = new FakeUri('/wiki/source.md');
const files = new Set<string>();
const symlinks = new Set<string>();
let events: string[];
class CreateEdit {
  entries: { uri: FakeUri; options: { overwrite: boolean; ignoreIfExists: boolean } }[] = [];
  createFile(uri: FakeUri, options: { overwrite: boolean; ignoreIfExists: boolean }) {
    this.entries.push({ uri, options });
  }
}

describe('VS Code wiki articles', () => {
  before(async () => {
    stub = installVscodeStub();
    wiki = await import('../src/wikiLinks.js');
  });
  beforeEach(() => {
    stub = installVscodeStub();
    files.clear();
    symlinks.clear();
    events = [];
    stub.workspaceFolders.push({ uri: root, name: 'Wiki', index: 0 });
    stub.module.WorkspaceEdit = CreateEdit;
    const workspace = stub.module.workspace as {
      isTrusted: boolean;
      fs: unknown;
      applyEdit: unknown;
    };
    workspace.isTrusted = true;
    workspace.fs = {
      isWritableFileSystem: () => true,
      async readDirectory(uri: FakeUri) {
        events.push(`list:${uri.path}`);
        const entries = new Map<string, number>();
        for (const file of files) {
          if (!file.startsWith(`${uri.path}/`)) continue;
          const rest = file.slice(uri.path.length + 1);
          entries.set(rest.split('/')[0], rest.includes('/') ? 2 : 1);
        }
        for (const link of symlinks) {
          if (link.startsWith(`${uri.path}/`) && !link.slice(uri.path.length + 1).includes('/'))
            entries.set(link.slice(uri.path.length + 1), 66);
        }
        return [...entries];
      },
      async stat(uri: FakeUri) {
        if (symlinks.has(uri.path)) return { type: 66, ctime: 0, mtime: 0, size: 0 };
        if (files.has(uri.path)) return { type: 1, ctime: 0, mtime: 0, size: 0 };
        if (uri.path === '/wiki' || [...files].some((file) => file.startsWith(uri.path + '/')))
          return { type: 2, ctime: 0, mtime: 0, size: 0 };
        throw FakeFileSystemError.FileNotFound(uri);
      },
    };
    workspace.applyEdit = async (edit: CreateEdit) => {
      events.push('create');
      for (const entry of edit.entries) {
        expect(entry.options).to.deep.equal({ overwrite: false, ignoreIfExists: true });
        files.add(entry.uri.path);
      }
      return true;
    };
  });
  after(() => uninstallVscodeStub());
  const access = (target: string, action: 'exists' | 'create' | 'open') =>
    wiki.accessWikiArticle(source as never, target, action, async () => {
      events.push('flush');
    });

  it('lists only the requested folder and never creates during autocomplete', async () => {
    for (const file of [
      '/wiki/source.md',
      '/wiki/reference/foo.md',
      '/wiki/reference/foo.html',
      '/wiki/source_files/body.md',
      '/wiki/.hidden/a.md',
    ])
      files.add(file);
    symlinks.add('/wiki/link');
    expect(await wiki.suggestWikiArticleTargets(source as never, '')).to.deep.equal([
      { target: 'reference/', label: 'reference/', kind: 'folder' },
    ]);
    expect(
      await wiki.suggestWikiArticleTargets(source as never, 'reference/f'),
    ).to.have.deep.members([
      { target: 'reference/foo.md', label: 'foo.md', kind: 'article' },
      { target: 'reference/foo.html', label: 'foo.html', kind: 'article' },
    ]);
    expect(events).to.deep.equal(['list:/wiki', 'list:/wiki/reference']);
    for (const query of ['../', 'link/']) {
      try {
        await wiki.suggestWikiArticleTargets(source as never, query);
        expect.fail('accepted unsafe folder');
      } catch (error) {
        expect(String(error)).not.to.contain('accepted unsafe folder');
      }
    }
    expect(events).to.deep.equal(['list:/wiki', 'list:/wiki/reference']);
  });

  it('bounds autocomplete messages and rejects unknown wire fields', () => {
    const request = { type: 'wikiSuggestRequest', requestId: 3, query: '' };
    expect(parseWebviewToExtensionMessage(request)).to.deep.equal(request);
    expect(parseWebviewToExtensionMessage({ ...request, query: 'a'.repeat(2049) })).to.equal(null);
    expect(parseWebviewToExtensionMessage({ ...request, absolutePath: '/outside' })).to.equal(null);
    const item = { target: 'reference/', label: 'reference/', kind: 'folder' };
    const response = { type: 'wikiSuggestions', requestId: 3, items: [item] };
    expect(parseExtensionToWebviewMessage(response)).to.deep.equal(response);
    expect(parseExtensionToWebviewMessage({ ...response, items: Array(21).fill(item) })).to.equal(
      null,
    );
    expect(
      parseExtensionToWebviewMessage({ ...response, items: [{ ...item, content: 'extra' }] }),
    ).to.equal(null);
  });

  it('checks without writing, then flushes before creating and opening a subfolder article', async () => {
    expect(await access('reference/blah', 'exists')).to.equal(false);
    expect(events).to.deep.equal([]);
    expect(await access('reference/blah', 'create')).to.equal(true);
    expect(events).to.deep.equal(['flush', 'create']);
    expect(files.has('/wiki/reference/blah.md')).to.equal(true);
    expect(stub.executedCommands.at(-1)?.command).to.equal('vscode.openWith');
    events = [];
    await access('reference/blah', 'create');
    expect(events).to.deep.equal(['flush']);
  });
  it('rejects traversal, symlink parents, and untrusted creation', async () => {
    for (const target of ['../outside', '/outside', '%2e%2e/outside']) {
      try {
        await access(target, 'create');
        expect.fail('accepted traversal');
      } catch (error) {
        expect(String(error)).not.to.contain('accepted traversal');
      }
    }
    symlinks.add('/wiki/reference');
    try {
      await access('reference/blah', 'create');
      expect.fail('accepted symlink');
    } catch (error) {
      expect(String(error)).to.contain('symbolic links');
    }
    (stub.module.workspace as { isTrusted: boolean }).isTrusted = false;
    try {
      await access('new', 'create');
      expect.fail('accepted untrusted');
    } catch (error) {
      expect(String(error)).to.contain('does not allow');
    }
    expect(events).not.to.include('create');
  });
  it('does not create anything after a source save fails', async () => {
    try {
      await wiki.accessWikiArticle(source as never, 'new', 'create', async () => {
        throw new Error('save failed');
      });
      expect.fail('ignored save failure');
    } catch (error) {
      expect(String(error)).to.contain('save failed');
    }
    expect(files.size).to.equal(0);
  });
  it('opens existing explicit HTML targets without creating empty HTML files', async () => {
    files.add('/wiki/existing.html');
    expect(await access('existing.html', 'open')).to.equal(true);
    expect(stub.executedCommands.at(-1)?.command).to.equal('vscode.open');
    try {
      await access('missing.html', 'create');
      expect.fail('created empty HTML');
    } catch (error) {
      expect(String(error)).to.contain('Create HTML articles in a DocBlocks workspace');
    }
    expect(files.has('/wiki/missing.html')).to.equal(false);
  });
  it('validates the exact request and response wire shapes', () => {
    const request = { type: 'wikiLinkRequest', requestId: 1, target: 'foo', action: 'create' };
    expect(parseWebviewToExtensionMessage(request)).to.deep.equal(request);
    expect(parseWebviewToExtensionMessage({ ...request, absolutePath: '/outside' })).to.equal(null);
    expect(parseWebviewToExtensionMessage({ ...request, action: 'delete' })).to.equal(null);
    expect(
      parseExtensionToWebviewMessage({ type: 'wikiLinkResult', requestId: 1, exists: true }),
    ).not.to.equal(null);
    expect(
      parseExtensionToWebviewMessage({ type: 'wikiLinkResult', requestId: 1, exists: 'true' }),
    ).to.equal(null);
  });
});
