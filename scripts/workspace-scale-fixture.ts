/**
 * A seeded, synthetic workspace for scale work on indexing and search: nested
 * folders of Markdown notes (front matter, headings, lists, links, code,
 * tables) plus some non-Markdown files. The same options always produce the
 * same tree, byte for byte.
 *
 * Planted terms keep search measurements comparable across runs:
 * - `rare` appears in exactly one note;
 * - `mid` appears in about 1% of notes;
 * - `common` is the vocabulary's top word, which most notes contain.
 * Vocabulary words follow a Zipf distribution, like real prose.
 */

export interface ScaleFixtureOptions {
  /** Total files, Markdown and other content together. */
  readonly files: number;
  readonly seed?: number;
  /** Share of files that are not Markdown. Default 0.1. */
  readonly otherRatio?: number;
}

export interface ScaleFixtureFile {
  /** Workspace-relative, '/'-separated. */
  readonly path: string;
  readonly data: Uint8Array;
}

export interface ScaleFixture {
  readonly terms: { readonly rare: string; readonly mid: string; readonly common: string };
  readonly folderCount: number;
  files(): Generator<ScaleFixtureFile>;
}

const RARE_TERM = 'zebracorn';
const MID_TERM = 'lanternfish';
const VOCABULARY_SIZE = 4000;
const FILES_PER_FOLDER = 25;
const MAX_DEPTH = 5;

/** mulberry32: small, fast, and good enough for synthetic text. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = [
  'ka',
  'lo',
  'mi',
  'ner',
  'to',
  'sa',
  'vi',
  'den',
  'ar',
  'po',
  'lin',
  'cu',
  'ra',
  'mo',
  'te',
  'sil',
  'ban',
  'or',
  'phe',
  'qui',
  'zan',
  'el',
  'tor',
  'gra',
  'ste',
  'wil',
  'ho',
  'ny',
  'dra',
  'fen',
];
const STOP_WORDS = ['the', 'and', 'of', 'to', 'a', 'in', 'is', 'that', 'for', 'it', 'with', 'as'];

function buildVocabulary(random: () => number): string[] {
  const words = new Set<string>(STOP_WORDS);
  while (words.size < VOCABULARY_SIZE) {
    const length = 2 + Math.floor(random() * 3);
    let word = '';
    for (let index = 0; index < length; index += 1) {
      word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    }
    if (word !== RARE_TERM && word !== MID_TERM) words.add(word);
  }
  return [...words];
}

function zipfSampler(size: number, random: () => number): () => number {
  const cumulative = new Float64Array(size);
  let total = 0;
  for (let rank = 0; rank < size; rank += 1) {
    total += 1 / (rank + 1) ** 1.07;
    cumulative[rank] = total;
  }
  return () => {
    const target = random() * total;
    let low = 0;
    let high = size - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cumulative[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

function slug(words: readonly string[]): string {
  return words.join('-').toLowerCase();
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function createScaleFixture(options: ScaleFixtureOptions): ScaleFixture {
  const seed = options.seed ?? 20261119;
  const otherRatio = options.otherRatio ?? 0.1;
  const setup = rng(seed);
  const vocabulary = buildVocabulary(setup);
  // The first word after the stop words is the most frequent content word.
  const common = vocabulary[STOP_WORDS.length]!;

  // Folders: a breadth-first tree, roughly FILES_PER_FOLDER files each.
  const folderTarget = Math.max(1, Math.ceil(options.files / FILES_PER_FOLDER));
  const folders: string[] = [''];
  for (let next = 0; folders.length < folderTarget && next < folders.length; next += 1) {
    const parent = folders[next]!;
    const depth = parent === '' ? 0 : parent.split('/').length;
    if (depth >= MAX_DEPTH) continue;
    const children = 3 + Math.floor(setup() * 6);
    for (let child = 0; child < children && folders.length < folderTarget; child += 1) {
      const name = `${vocabulary[STOP_WORDS.length + Math.floor(setup() * 600)]}-${folders.length}`;
      folders.push(parent === '' ? name : `${parent}/${name}`);
    }
  }
  const rareIndex = Math.floor(options.files * 0.37);

  function* files(): Generator<ScaleFixtureFile> {
    const random = rng(seed ^ 0x9e3779b9);
    const nextWord = zipfSampler(vocabulary.length, random);
    const encoder = new TextEncoder();
    const word = () => vocabulary[nextWord()]!;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
    const titles: string[] = [];

    const sentence = (extra?: string): string => {
      const words = Array.from({ length: between(6, 18) }, word);
      if (extra) words.splice(between(0, words.length), 0, extra);
      return `${capitalize(words.join(' '))}.`;
    };
    const paragraph = (extra?: string): string => {
      const count = between(2, 7);
      const plantAt = extra ? between(0, count - 1) : -1;
      return Array.from({ length: count }, (_, index) =>
        sentence(index === plantAt ? extra : undefined),
      ).join(' ');
    };

    for (let index = 0; index < options.files; index += 1) {
      const folder = pick(folders);
      const prefix = folder === '' ? '' : `${folder}/`;

      if (random() < otherRatio) {
        const kind = pick(['png', 'txt', 'csv', 'json', 'pdf'] as const);
        const name = `${slug([word(), word()])}-${index}.${kind}`;
        if (kind === 'png' || kind === 'pdf') {
          const data = new Uint8Array(between(1024, 40 * 1024));
          for (let offset = 0; offset < data.length; offset += 1) {
            data[offset] = Math.floor(random() * 256);
          }
          yield { path: `${prefix}${name}`, data };
        } else if (kind === 'csv') {
          const rows = Array.from({ length: between(5, 60) }, () =>
            Array.from({ length: 5 }, word).join(','),
          );
          yield { path: `${prefix}${name}`, data: encoder.encode(`${rows.join('\n')}\n`) };
        } else if (kind === 'json') {
          const value = Object.fromEntries(Array.from({ length: 8 }, () => [word(), word()]));
          yield { path: `${prefix}${name}`, data: encoder.encode(JSON.stringify(value, null, 2)) };
        } else {
          yield { path: `${prefix}${name}`, data: encoder.encode(`${paragraph()}\n`) };
        }
        continue;
      }

      const titleWords = Array.from({ length: between(2, 5) }, word);
      const title = titleWords.map(capitalize).join(' ');
      titles.push(title);
      const lines: string[] = [];
      if (random() < 0.3) {
        lines.push(
          '---',
          `title: ${title}`,
          `tags: [${word()}, ${word()}]`,
          `date: 2026-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
          '---',
          '',
        );
      }
      lines.push(`# ${title}`, '', paragraph(index === rareIndex ? RARE_TERM : undefined), '');
      const plantMid = random() < 0.01;
      const sections = random() < 0.03 ? between(20, 40) : between(2, 7);
      const midSection = plantMid ? between(0, sections - 1) : -1;
      for (let section = 0; section < sections; section += 1) {
        lines.push(`## ${capitalize(word())} ${word()}`, '');
        const paragraphs = between(1, 4);
        for (let item = 0; item < paragraphs; item += 1) {
          lines.push(paragraph(section === midSection && item === 0 ? MID_TERM : undefined), '');
        }
        const roll = random();
        if (roll < 0.2) {
          for (let item = between(2, 6); item > 0; item -= 1) lines.push(`- ${sentence()}`);
          lines.push('');
        } else if (roll < 0.28) {
          lines.push('```ts', `const ${word()} = '${word()}';`, `export { ${word()} };`, '```', '');
        } else if (roll < 0.33) {
          lines.push('| Name | Value |', '| --- | --- |');
          for (let row = between(2, 6); row > 0; row -= 1) lines.push(`| ${word()} | ${word()} |`);
          lines.push('');
        }
        if (titles.length > 1 && random() < 0.15) {
          lines.push(`See [[${pick(titles)}]].`, '');
        }
      }
      yield {
        path: `${prefix}${slug(titleWords)}-${index}.md`,
        data: encoder.encode(lines.join('\n')),
      };
    }
  }

  return { terms: { rare: RARE_TERM, mid: MID_TERM, common }, folderCount: folders.length, files };
}
