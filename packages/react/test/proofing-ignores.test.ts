import { expect } from 'chai';
import {
  createLocalProofingIgnoreStore,
  proofingIgnoreKey,
  type ProofingIgnoreStorage,
} from '../src/Proofing/proofing-ignores.js';

function fakeStorage(): ProofingIgnoreStorage & { raw(): string | null; failWrites(): void } {
  let value: string | null = null;
  let failing = false;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      if (failing) throw new Error('QuotaExceededError');
      value = next;
    },
    raw: () => value,
    failWrites: () => {
      failing = true;
    },
  };
}

const doc = (fileName: string) => ({ articleId: fileName, fileName });

describe('proofing ignore store', () => {
  it('round-trips the engine payload verbatim', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    // The real export carries context hashes above 2^53. Parsing it would
    // silently corrupt them, so the store must only ever move the string.
    const opaque = '{"ignored":[9007199254740993,18446744073709551615]}';
    store.save(doc('/notes.md'), opaque);
    expect(store.load(doc('/notes.md'))).to.equal(opaque);
  });

  it('scopes entries by workspace, not just path', () => {
    const storage = fakeStorage();
    const inA = createLocalProofingIgnoreStore(() => 'ws-a', storage);
    const inB = createLocalProofingIgnoreStore(() => 'ws-b', storage);
    inA.save(doc('/readme.md'), 'A');
    inB.save(doc('/readme.md'), 'B');
    expect(inA.load(doc('/readme.md'))).to.equal('A');
    expect(inB.load(doc('/readme.md'))).to.equal('B');
  });

  it('separates documents within one workspace', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    store.save(doc('/one.md'), 'ONE');
    store.save(doc('/two.md'), 'TWO');
    expect(store.load(doc('/one.md'))).to.equal('ONE');
    expect(store.load(doc('/two.md'))).to.equal('TWO');
  });

  it('falls back to the article id when there is no file name', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    store.save({ articleId: 'untitled' }, 'SCRATCH');
    expect(store.load({ articleId: 'untitled' })).to.equal('SCRATCH');
  });

  it('does not persist while no workspace is active', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => null, storage);
    store.save(doc('/notes.md'), 'X');
    expect(storage.raw()).to.equal(null);
    expect(store.load(doc('/notes.md'))).to.equal(undefined);
  });

  it('tracks the active workspace as it changes under a mounted shell', () => {
    const storage = fakeStorage();
    let workspace = 'ws-a';
    const store = createLocalProofingIgnoreStore(() => workspace, storage);
    store.save(doc('/x.md'), 'FROM-A');
    workspace = 'ws-b';
    expect(store.load(doc('/x.md'))).to.equal(undefined);
    workspace = 'ws-a';
    expect(store.load(doc('/x.md'))).to.equal('FROM-A');
  });

  it('drops an oversized payload instead of evicting everything else', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    store.save(doc('/keep.md'), 'KEEP');
    store.save(doc('/huge.md'), 'x'.repeat(64 * 1024 + 1));
    expect(store.load(doc('/huge.md'))).to.equal(undefined);
    expect(store.load(doc('/keep.md'))).to.equal('KEEP');
  });

  it('evicts the least recently written document past the cap', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    for (let i = 0; i < 205; i++) store.save(doc(`/doc-${i}.md`), `v${i}`);
    expect(store.load(doc('/doc-0.md'))).to.equal(undefined);
    expect(store.load(doc('/doc-204.md'))).to.equal('v204');
    const persisted = JSON.parse(storage.raw() ?? '{}') as Record<string, unknown>;
    expect(Object.keys(persisted).length).to.equal(200);
  });

  it('survives a storage quota failure without throwing', () => {
    const storage = fakeStorage();
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    storage.failWrites();
    expect(() => store.save(doc('/notes.md'), 'X')).to.not.throw();
  });

  it('ignores malformed persisted state rather than failing the editor', () => {
    const storage = fakeStorage();
    storage.setItem('docblocks:proofingIgnores', 'not json at all');
    const store = createLocalProofingIgnoreStore(() => 'ws-1', storage);
    expect(store.load(doc('/notes.md'))).to.equal(undefined);
    expect(() => store.save(doc('/notes.md'), 'X')).to.not.throw();
    expect(store.load(doc('/notes.md'))).to.equal('X');
  });

  it('keys workspace and path unambiguously', () => {
    expect(proofingIgnoreKey('ws', '/a.md')).to.not.equal(proofingIgnoreKey('ws/a.md', ''));
  });
});
