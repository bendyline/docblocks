import { expect } from 'chai';
import {
  LAST_STATE_KEY,
  loadLastState,
  parseLastState,
  saveLastState,
} from '../src/DocBlocksShell/last-state.js';

function createStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  value: string | null;
} {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === LAST_STATE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === LAST_STATE_KEY) this.value = value;
    },
    removeItem(key) {
      if (key === LAST_STATE_KEY) this.value = null;
    },
  };
}

describe('last document state', () => {
  it('accepts only an exact bounded navigation record', () => {
    expect(
      parseLastState({ workspaceId: 'workspace-1', filePath: '/docs/notes.md', view: 'wysiwyg' }),
    ).to.deep.equal({
      workspaceId: 'workspace-1',
      filePath: '/docs/notes.md',
      view: 'wysiwyg',
    });
    expect(
      parseLastState({
        workspaceId: 'workspace-1',
        filePath: '/docs/notes.md',
        view: 'wysiwyg',
        unexpected: true,
      }),
    ).to.equal(null);
    expect(
      parseLastState({ workspaceId: 'workspace-1', filePath: '../escape.md', view: 'wysiwyg' }),
    ).to.equal(null);
    expect(
      parseLastState({ workspaceId: 'workspace-1', filePath: '/notes.md', view: 'video' }),
    ).to.equal(null);
  });

  it('removes malformed persisted state instead of using it for startup navigation', () => {
    const storage = createStorage(JSON.stringify({ workspaceId: 42, filePath: '/', view: 'raw' }));
    expect(loadLastState(storage)).to.equal(null);
    expect(storage.value).to.equal(null);
  });

  it('round-trips a valid state through storage', () => {
    const storage = createStorage();
    const state = { workspaceId: 'workspace-1', filePath: '/notes.md', view: 'preview' } as const;
    saveLastState(state, storage);
    expect(loadLastState(storage)).to.deep.equal(state);
  });
});
