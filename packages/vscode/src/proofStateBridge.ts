/**
 * Host persistence for proofing state in the VS Code extension.
 *
 * Squisq never writes dismissed findings or app-dictionary words into the
 * document — they are one person's editing preferences, and a file travelling
 * through git must not carry them. A webview has no durable storage of its
 * own, so both live in extension-host state:
 *
 * - **dictionary → `globalState`.** A personal vocabulary is not specific to
 *   one workspace; a word accepted in one project should stay accepted in the
 *   next.
 * - **ignores → `workspaceState`, keyed by workspace-relative path.** A
 *   dismissal is about one document, and the key only means anything inside
 *   the workspace that defines it.
 *
 * Neither message carries a document path. A panel owns exactly one document,
 * so the key is derived here from the panel's own URI rather than trusted from
 * the webview — the same rule the media bridge follows.
 */

import * as vscode from 'vscode';
import { PROOF_STATE_LIMITS, type WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';

export const PROOF_DICTIONARY_STATE_KEY = 'docblocks.proofDictionary';
export const PROOF_IGNORES_STATE_KEY = 'docblocks.proofIgnores';

/**
 * Cap on documents whose dismissals are remembered per workspace. Least
 * recently written is evicted first, so proofing can never grow the workspace
 * state without bound.
 */
export const MAX_PROOF_IGNORE_DOCUMENTS = 200;

export type ProofStateMessage = Extract<
  WebviewToExtensionMessage,
  {
    type:
      | 'loadProofDictionary'
      | 'addProofDictionaryWord'
      | 'loadProofIgnores'
      | 'saveProofIgnores';
  }
>;

interface ProofIgnoreEntry {
  /** The engine's opaque export. Never parsed. */
  readonly json: string;
  /** Epoch millis of the last write; used only for eviction order. */
  readonly savedAt: number;
}

/** Minimal surface of the extension context this bridge needs. */
export interface ProofStateMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ProofStateStores {
  readonly dictionary: ProofStateMemento;
  readonly ignores: ProofStateMemento;
}

/**
 * Key one document's dismissals. `workspaceState` is already per-workspace, so
 * this only has to be unique within one.
 */
export function proofIgnoreDocumentKey(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

/**
 * Read the stored dictionary, discarding anything that no longer validates.
 *
 * Deduplicated through a Set rather than a scan per entry: this runs on every
 * accepted word, and at the 5,000-word cap a linear scan would make one add
 * cost millions of comparisons.
 */
export function readProofDictionary(stores: ProofStateStores): string[] {
  const stored = stores.dictionary.get<unknown>(PROOF_DICTIONARY_STATE_KEY);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  for (const entry of stored) {
    if (typeof entry !== 'string') continue;
    if (entry.length === 0 || entry.length > PROOF_STATE_LIMITS.wordCharacters) continue;
    seen.add(entry);
    if (seen.size >= PROOF_STATE_LIMITS.dictionaryWords) break;
  }
  return [...seen];
}

/** Accept one more word app-wide. Returns the resulting list. */
export async function appendProofDictionaryWord(
  stores: ProofStateStores,
  word: string,
): Promise<string[]> {
  const words = readProofDictionary(stores);
  if (words.includes(word)) return words;
  words.push(word);
  // Oldest-first eviction keeps the most recently accepted words.
  const bounded = words.slice(-PROOF_STATE_LIMITS.dictionaryWords);
  await stores.dictionary.update(PROOF_DICTIONARY_STATE_KEY, bounded);
  return bounded;
}

function readIgnoreEntries(stores: ProofStateStores): Record<string, ProofIgnoreEntry> {
  const stored = stores.ignores.get<unknown>(PROOF_IGNORES_STATE_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const entries: Record<string, ProofIgnoreEntry> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const json = Reflect.get(value, 'json');
    const savedAt = Reflect.get(value, 'savedAt');
    if (typeof json !== 'string' || json.length > PROOF_STATE_LIMITS.ignoredJsonCharacters) {
      continue;
    }
    entries[key] = { json, savedAt: typeof savedAt === 'number' ? savedAt : 0 };
  }
  return entries;
}

/** Previously dismissed findings for one document, if any. */
export function readProofIgnores(stores: ProofStateStores, documentKey: string): string | null {
  return readIgnoreEntries(stores)[documentKey]?.json ?? null;
}

/** Persist one document's dismissals, evicting the least recently written. */
export async function writeProofIgnores(
  stores: ProofStateStores,
  documentKey: string,
  ignoredJson: string,
  now: number = Date.now(),
): Promise<void> {
  const entries = readIgnoreEntries(stores);
  if (ignoredJson.length === 0) delete entries[documentKey];
  else entries[documentKey] = { json: ignoredJson, savedAt: now };

  const keys = Object.keys(entries);
  if (keys.length > MAX_PROOF_IGNORE_DOCUMENTS) {
    const ordered = keys.sort((a, b) => (entries[a]?.savedAt ?? 0) - (entries[b]?.savedAt ?? 0));
    for (const key of ordered.slice(0, keys.length - MAX_PROOF_IGNORE_DOCUMENTS)) {
      delete entries[key];
    }
  }
  await stores.ignores.update(PROOF_IGNORES_STATE_KEY, entries);
}

/** Handle one proofing-state message from the webview. */
export async function handleProofStateMessage(
  message: ProofStateMessage,
  documentUri: vscode.Uri,
  webview: Pick<vscode.Webview, 'postMessage'>,
  stores: ProofStateStores,
): Promise<void> {
  switch (message.type) {
    case 'loadProofDictionary':
      await webview.postMessage({
        type: 'proofDictionaryLoaded',
        requestId: message.requestId,
        words: readProofDictionary(stores),
      });
      return;

    case 'addProofDictionaryWord':
      await appendProofDictionaryWord(stores, message.word);
      return;

    case 'loadProofIgnores':
      await webview.postMessage({
        type: 'proofIgnoresLoaded',
        requestId: message.requestId,
        ignoredJson: readProofIgnores(stores, proofIgnoreDocumentKey(documentUri)),
      });
      return;

    case 'saveProofIgnores':
      await writeProofIgnores(stores, proofIgnoreDocumentKey(documentUri), message.ignoredJson);
      return;
  }
}
