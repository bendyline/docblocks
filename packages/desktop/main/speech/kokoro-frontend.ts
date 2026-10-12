import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type KokoroLexicon,
  parseKokoroLexicon,
  planKokoroSpeech,
  type KokoroWordTokens,
} from '@bendyline/gezel/kokoro';

/**
 * Kokoro's text frontend, ported from Gezel's `kokoro-frontend.ts`.
 *
 * Kokoro reads phoneme ids, not text. The usual route — kokoro-js calling
 * `phonemizer` — embeds eSpeak NG, which is GPL-3 and cannot ship in a store
 * build. Gezel's shared `@bendyline/gezel/kokoro` frontend and its pinned
 * dictionaries replace it, so DocBlocks pronounces every sentence exactly as
 * Gezel does. The one addition here is source offsets: each utterance knows
 * which slice of the request text it speaks, so narration timing and reading
 * highlights can map audio back to the document.
 */

export type KokoroLanguage = 'us' | 'gb';

export interface KokoroUtterance {
  /** UTF-16 range of the request text this utterance speaks. */
  readonly textStart: number;
  readonly textEnd: number;
  readonly phonemes: string;
  /** Padded token ids. */
  readonly tokens: readonly number[];
  readonly words: readonly KokoroWordTokens[];
}

/** American voices are `a*`, British voices are `b*`; anything else reads as American. */
export function kokoroLanguageForVoice(voiceId: string): KokoroLanguage {
  return voiceId.startsWith('b') ? 'gb' : 'us';
}

const LEXICON_FILES: Readonly<Record<KokoroLanguage, string>> = {
  us: 'lexicon-us-en.txt.gz',
  gb: 'lexicon-gb-en.txt.gz',
};

/** Sentences with their offsets: Gezel's split on `[.!?…]` followed by whitespace. */
export function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  const boundary = /(?<=[.!?…])\s+/gu;
  let cursor = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      sentences.push({
        text: trimmed,
        start: from + leading,
        end: from + leading + trimmed.length,
      });
    }
  };
  for (const match of text.matchAll(boundary)) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);
  return sentences;
}

export class KokoroFrontend {
  private readonly loaded = new Map<KokoroLanguage, Promise<KokoroLexicon>>();

  constructor(private readonly lexiconDir: string) {}

  private lexicon(language: KokoroLanguage): Promise<KokoroLexicon> {
    const cached = this.loaded.get(language);
    if (cached) return cached;
    const file = path.join(this.lexiconDir, LEXICON_FILES[language]);
    const pending = readFile(file).then(
      (packed) => parseKokoroLexicon(gunzipSync(packed).toString('utf8')),
      (cause: unknown) => {
        throw new Error(`The narration pronunciation dictionary is missing at ${file}.`, {
          cause,
        });
      },
    );
    // A failed read must not be cached as a permanent failure.
    void pending.catch(() => this.loaded.delete(language));
    this.loaded.set(language, pending);
    return pending;
  }

  /** Break text into model-sized utterances, sentence by sentence. */
  async plan(text: string, voiceId: string): Promise<KokoroUtterance[]> {
    const lexicon = await this.lexicon(kokoroLanguageForVoice(voiceId));
    const utterances: KokoroUtterance[] = [];
    for (const sentence of splitSentences(text)) {
      for (const piece of planKokoroSpeech(sentence.text, { lexicon })) {
        utterances.push({
          ...piece,
          textStart: sentence.start + piece.textStart,
          textEnd: sentence.start + piece.textEnd,
          words: piece.words.map((word) => ({
            ...word,
            textStart: sentence.start + word.textStart,
            textEnd: sentence.start + word.textEnd,
          })),
        });
      }
    }
    return utterances;
  }
}

/**
 * The style vector for an utterance: voice packs hold one 256-float vector per
 * phoneme count, and kokoro-js indexes them by token count minus the two pads.
 */
export function styleOffset(tokenCount: number): number {
  return 256 * Math.min(Math.max(tokenCount - 2, 0), 509);
}

/**
 * The dictionaries ship inside the installed Gezel service (Apache-2.0, from
 * the pinned sherpa-onnx Kokoro voice pack), which DocBlocks already depends
 * on, so nothing is copied. A Gezel release that moves them fails the unit
 * test that resolves this path.
 */
export function kokoroLexiconDir(gezelServicePackageJson: string): string {
  return path.join(path.dirname(gezelServicePackageJson), 'dist', 'kokoro-lexicon');
}

/** The prebuilt ONNX Runtime binding for a platform, inside the installed package. */
export function onnxRuntimeBinding(
  onnxRuntimePackageJson: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(
    path.dirname(onnxRuntimePackageJson),
    'bin',
    'napi-v6',
    platform,
    arch,
    'onnxruntime_binding.node',
  );
}
