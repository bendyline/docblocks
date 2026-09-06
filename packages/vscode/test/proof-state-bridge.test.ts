import { expect } from 'chai';
import { PROOF_STATE_LIMITS } from '@bendyline/docblocks/vscode';
import { installVscodeStub, uninstallVscodeStub, FakeUri } from './helpers/vscodeStub.js';

/**
 * proofStateBridge imports `vscode`, so it can only be required after the fake
 * module is installed.
 */
type BridgeModule = typeof import('../src/proofStateBridge.js');
let bridge: BridgeModule;

function memento() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => map.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    raw: (key: string): unknown => map.get(key),
  };
}

function stores() {
  return { dictionary: memento(), ignores: memento() };
}

function recorder() {
  const posted: unknown[] = [];
  return {
    posted,
    webview: {
      postMessage: (message: unknown): Promise<boolean> => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
  };
}

before(async () => {
  installVscodeStub();
  bridge = (await import('../src/proofStateBridge.js')) as BridgeModule;
});

after(() => {
  uninstallVscodeStub();
});

describe('VS Code proofing state persistence', () => {
  describe('dictionary (global state)', () => {
    it('round-trips accepted words', async () => {
      const s = stores();
      await bridge.appendProofDictionaryWord(s, 'Bendyline');
      await bridge.appendProofDictionaryWord(s, 'DocBlocks');
      expect(bridge.readProofDictionary(s)).to.deep.equal(['Bendyline', 'DocBlocks']);
    });

    it('does not duplicate a word already accepted', async () => {
      const s = stores();
      await bridge.appendProofDictionaryWord(s, 'Squisq');
      await bridge.appendProofDictionaryWord(s, 'Squisq');
      expect(bridge.readProofDictionary(s)).to.deep.equal(['Squisq']);
    });

    it('keeps the most recent words at the cap', async () => {
      const s = stores();
      const over = PROOF_STATE_LIMITS.dictionaryWords + 5;
      for (let i = 0; i < over; i++) await bridge.appendProofDictionaryWord(s, `word${i}`);
      const words = bridge.readProofDictionary(s);
      expect(words.length).to.equal(PROOF_STATE_LIMITS.dictionaryWords);
      expect(words).to.include(`word${over - 1}`);
      expect(words).to.not.include('word0');
    });

    it('discards corrupted state instead of failing', async () => {
      const s = stores();
      await s.dictionary.update(bridge.PROOF_DICTIONARY_STATE_KEY, { not: 'an array' });
      expect(bridge.readProofDictionary(s)).to.deep.equal([]);
    });

    it('drops individual entries that are not usable words', async () => {
      const s = stores();
      await s.dictionary.update(bridge.PROOF_DICTIONARY_STATE_KEY, [
        'keep',
        42,
        '',
        'x'.repeat(PROOF_STATE_LIMITS.wordCharacters + 1),
        'alsokeep',
      ]);
      expect(bridge.readProofDictionary(s)).to.deep.equal(['keep', 'alsokeep']);
    });

    it('keeps the dictionary out of workspace-scoped storage', async () => {
      // A personal vocabulary must follow the user across workspaces.
      const s = stores();
      await bridge.appendProofDictionaryWord(s, 'Bendyline');
      expect(s.dictionary.raw(bridge.PROOF_DICTIONARY_STATE_KEY)).to.deep.equal(['Bendyline']);
      expect(s.ignores.raw(bridge.PROOF_DICTIONARY_STATE_KEY)).to.equal(undefined);
    });
  });

  describe('ignores (workspace state)', () => {
    it('round-trips one document payload verbatim', async () => {
      const s = stores();
      // Real exports carry context hashes above 2^53; parsing would corrupt them.
      const opaque = '{"context_hashes":[17946180198125199793]}';
      await bridge.writeProofIgnores(s, 'docs/notes.md', opaque);
      expect(bridge.readProofIgnores(s, 'docs/notes.md')).to.equal(opaque);
    });

    it('keeps documents separate', async () => {
      const s = stores();
      await bridge.writeProofIgnores(s, 'a.md', 'A');
      await bridge.writeProofIgnores(s, 'b.md', 'B');
      expect(bridge.readProofIgnores(s, 'a.md')).to.equal('A');
      expect(bridge.readProofIgnores(s, 'b.md')).to.equal('B');
    });

    it('reports no state for an unknown document', () => {
      expect(bridge.readProofIgnores(stores(), 'never-seen.md')).to.equal(null);
    });

    it('clears a document when the engine exports nothing', async () => {
      const s = stores();
      await bridge.writeProofIgnores(s, 'a.md', 'A');
      await bridge.writeProofIgnores(s, 'a.md', '');
      expect(bridge.readProofIgnores(s, 'a.md')).to.equal(null);
    });

    it('evicts the least recently written document past the cap', async () => {
      const s = stores();
      const over = bridge.MAX_PROOF_IGNORE_DOCUMENTS + 5;
      for (let i = 0; i < over; i++) {
        await bridge.writeProofIgnores(s, `doc-${i}.md`, `v${i}`, 1000 + i);
      }
      expect(bridge.readProofIgnores(s, 'doc-0.md')).to.equal(null);
      expect(bridge.readProofIgnores(s, `doc-${over - 1}.md`)).to.equal(`v${over - 1}`);
      const persisted = s.ignores.raw(bridge.PROOF_IGNORES_STATE_KEY) as Record<string, unknown>;
      expect(Object.keys(persisted).length).to.equal(bridge.MAX_PROOF_IGNORE_DOCUMENTS);
    });

    it('rejects an oversized payload already in storage', async () => {
      const s = stores();
      await s.ignores.update(bridge.PROOF_IGNORES_STATE_KEY, {
        'big.md': { json: 'x'.repeat(PROOF_STATE_LIMITS.ignoredJsonCharacters + 1), savedAt: 1 },
        'ok.md': { json: 'fine', savedAt: 2 },
      });
      expect(bridge.readProofIgnores(s, 'big.md')).to.equal(null);
      expect(bridge.readProofIgnores(s, 'ok.md')).to.equal('fine');
    });

    it('discards corrupted state instead of failing', async () => {
      const s = stores();
      await s.ignores.update(bridge.PROOF_IGNORES_STATE_KEY, ['not', 'a', 'map']);
      expect(bridge.readProofIgnores(s, 'a.md')).to.equal(null);
    });

    it('keeps ignores out of global storage', async () => {
      // Keys are workspace-relative paths; they mean nothing outside it.
      const s = stores();
      await bridge.writeProofIgnores(s, 'a.md', 'A');
      expect(s.ignores.raw(bridge.PROOF_IGNORES_STATE_KEY)).to.be.an('object');
      expect(s.dictionary.raw(bridge.PROOF_IGNORES_STATE_KEY)).to.equal(undefined);
    });
  });

  describe('message handling', () => {
    it('answers a dictionary load with the stored words', async () => {
      const s = stores();
      await bridge.appendProofDictionaryWord(s, 'Squisq');
      const { posted, webview } = recorder();
      await bridge.handleProofStateMessage(
        { type: 'loadProofDictionary', requestId: 7 },
        new FakeUri('/ws/notes.md') as never,
        webview,
        s,
      );
      expect(posted).to.deep.equal([
        { type: 'proofDictionaryLoaded', requestId: 7, words: ['Squisq'] },
      ]);
    });

    it('derives the ignore key from the panel URI, not from the webview', async () => {
      const s = stores();
      const uri = new FakeUri('/ws/notes.md') as never;
      const { webview } = recorder();
      await bridge.handleProofStateMessage(
        { type: 'saveProofIgnores', ignoredJson: 'IGNORES' },
        uri,
        webview,
        s,
      );
      // The webview never names a document; the stored key comes from the URI.
      expect(bridge.readProofIgnores(s, bridge.proofIgnoreDocumentKey(uri))).to.equal('IGNORES');
    });

    it('answers an ignore load for this panel document', async () => {
      const s = stores();
      const uri = new FakeUri('/ws/notes.md') as never;
      await bridge.writeProofIgnores(s, bridge.proofIgnoreDocumentKey(uri), 'IGNORES');
      const { posted, webview } = recorder();
      await bridge.handleProofStateMessage(
        { type: 'loadProofIgnores', requestId: 3 },
        uri,
        webview,
        s,
      );
      expect(posted).to.deep.equal([
        { type: 'proofIgnoresLoaded', requestId: 3, ignoredJson: 'IGNORES' },
      ]);
    });

    it('persists an accepted word without replying', async () => {
      const s = stores();
      const { posted, webview } = recorder();
      await bridge.handleProofStateMessage(
        { type: 'addProofDictionaryWord', word: 'Bendyline' },
        new FakeUri('/ws/notes.md') as never,
        webview,
        s,
      );
      expect(posted).to.deep.equal([]);
      expect(bridge.readProofDictionary(s)).to.deep.equal(['Bendyline']);
    });
  });
});
