import { expect } from 'chai';
import { parseWorkspacePath, type FileSystemEntry } from '@bendyline/docblocks/filesystem';
import type { WorkspaceOutputsResult } from '@bendyline/docblocks/workspace-settings';
import {
  filterVisibleFileEntries,
  isHiddenFileEntry,
} from '../src/FileExplorer/entry-visibility.js';
import { hiddenCatalogOutputPaths } from '../src/WorkspaceSettings/managed-outputs.js';

function entry(path: string, kind: FileSystemEntry['kind'] = 'directory'): FileSystemEntry {
  return { kind, name: path.split('/').pop() ?? path, path };
}

describe('file entry visibility', () => {
  it('hides document sidecar directories in nested folder listings', () => {
    const entries = [
      entry('/guides/topic_files'),
      entry('/guides/topic.md', 'file'),
      entry('/guides/examples'),
    ];

    expect(filterVisibleFileEntries(entries).map(({ path }) => path)).to.deep.equal([
      '/guides/topic.md',
      '/guides/examples',
    ]);
  });

  it('does not hide files whose names happen to end in _files', () => {
    expect(isHiddenFileEntry(entry('/guides/topic_files', 'file'))).to.equal(false);
  });

  it('continues to hide dot entries from user-facing file lists', () => {
    expect(isHiddenFileEntry(entry('/guides/.versions'))).to.equal(true);
  });

  it('hides tool-managed folders but not lookalike names', () => {
    expect(isHiddenFileEntry(entry('/node_modules'))).to.equal(true);
    expect(isHiddenFileEntry(entry('/site/Node_Modules'))).to.equal(true);
    expect(isHiddenFileEntry(entry('/scripts/__pycache__'))).to.equal(true);
    expect(isHiddenFileEntry(entry('/node_modules_notes'))).to.equal(false);
    expect(isHiddenFileEntry(entry('/notes/modules'))).to.equal(false);
  });

  it('hides host-named files in any case or slash form, but not folders at those paths', () => {
    const entries = [
      entry('/Index.HTML', 'file'),
      entry('catalog.json', 'file'),
      entry('/notes.md', 'file'),
      entry('/out/catalog.json'),
    ];

    expect(
      filterVisibleFileEntries(entries, ['index.html', 'catalog.json', 'out/catalog.json']).map(
        ({ path }) => path,
      ),
    ).to.deep.equal(['/notes.md', '/out/catalog.json']);
  });
});

describe('hidden catalog output paths', () => {
  const html = parseWorkspacePath('index.html');
  const json = parseWorkspacePath('data/catalog.json');
  const settings = {
    version: 1,
    catalog: {
      html: { enabled: true },
      json: { enabled: true, path: 'data/catalog.json' },
    },
  } as const;

  it('hides nothing when no catalog output is enabled', () => {
    expect(hiddenCatalogOutputPaths(null, null)).to.deep.equal([]);
    expect(
      hiddenCatalogOutputPaths({ version: 1, catalog: { html: { enabled: false } } }, null),
    ).to.deep.equal([]);
  });

  it('hides each enabled output before and after the catalog writes it', () => {
    expect(hiddenCatalogOutputPaths(settings, null)).to.deep.equal([
      'index.html',
      'data/catalog.json',
    ]);
    const written: WorkspaceOutputsResult = {
      documentCount: 2,
      outputs: [
        { kind: 'html', path: html, status: 'unchanged' },
        { kind: 'json', path: json, status: 'written' },
      ],
    };
    expect(hiddenCatalogOutputPaths(settings, written)).to.deep.equal([
      'index.html',
      'data/catalog.json',
    ]);
  });

  it('keeps listing a hand-written file the catalog refused to overwrite', () => {
    const blocked: WorkspaceOutputsResult = {
      documentCount: 2,
      outputs: [
        {
          kind: 'html',
          path: html,
          status: 'blocked',
          message: 'index.html already exists and was not created by DocBlocks.',
        },
        { kind: 'json', path: json, status: 'unchanged' },
      ],
    };
    expect(hiddenCatalogOutputPaths(settings, blocked)).to.deep.equal(['data/catalog.json']);
  });
});
