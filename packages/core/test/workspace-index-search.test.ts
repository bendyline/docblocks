import { expect } from 'chai';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  buildLiteralMatcher,
  buildSnippet,
  createCheckpoint,
  searchDocuments,
  type SearchableDocument,
} from '../src/workspace-index/search.js';
import { extractSearchText, lineSearchText } from '../src/workspace-index/search-text.js';
import type { IndexedDocument } from '../src/workspace-index/types.js';

function matches(
  query: string,
  text: string,
  options: { matchCase?: boolean; wholeWord?: boolean } = {},
) {
  const matcher = buildLiteralMatcher({ text: query, ...options });
  return matcher ? [...text.normalize('NFC').matchAll(matcher)].map((match) => match[0]) : null;
}

function document(
  path: string,
  title: string,
  body: string,
  lastModified = '2026-01-01T00:00:00.000Z',
): SearchableDocument {
  const record: IndexedDocument = {
    path: parseWorkspacePath(path),
    sourcePath: parseWorkspacePath(path),
    format: 'markdown',
    lastModified,
    title,
    outline: [],
    wordCount: 0,
    content: 'full',
  };
  return { record, text: lineSearchText(body), pending: false };
}

const noYield = createCheckpoint(
  () => Promise.resolve(),
  () => 0,
  undefined,
);

describe('workspace search matching', () => {
  it('treats every query character literally', () => {
    expect(matches('a.b*c', 'a.b*c and axbbc')).to.deep.equal(['a.b*c']);
    expect(matches('re-run', 'please re-run it')).to.deep.equal(['re-run']);
    expect(matches('(x)[y]{z}|^$\\/', 'q (x)[y]{z}|^$\\/ q')).to.deep.equal(['(x)[y]{z}|^$\\/']);
  });

  it('rejects empty and over-long queries', () => {
    expect(buildLiteralMatcher({ text: '   ' })).to.equal(null);
    expect(buildLiteralMatcher({ text: 'x'.repeat(257) })).to.equal(null);
  });

  it('folds case with Unicode rules unless Match case is on', () => {
    expect(matches('élan', 'ÉLAN élan')).to.deep.equal(['ÉLAN', 'élan']);
    // Simple case folding maps final sigma and the tonos capitals together.
    expect(matches('σοφός', 'ΣΟΦΌΣ')).to.deep.equal(['ΣΟΦΌΣ']);
    expect(matches('ς', 'Σ σ ς')).to.deep.equal(['Σ', 'σ', 'ς']);
    expect(matches('Alpha', 'alpha Alpha', { matchCase: true })).to.deep.equal(['Alpha']);
  });

  it('matches decomposed queries against composed text', () => {
    expect(matches('café', 'un café')).to.deep.equal(['café']);
  });

  it('honours whole-word boundaries only at word-character ends', () => {
    expect(matches('cat', 'cat category concat cat_s', { wholeWord: true })).to.deep.equal(['cat']);
    expect(matches('c++', 'use c++ or c++11', { wholeWord: true })).to.deep.equal(['c++', 'c++']);
    expect(matches('naïve', 'naïve naïvety', { wholeWord: true })).to.deep.equal(['naïve']);
  });
});

describe('workspace search text', () => {
  it('maps rendered text to source lines across Markdown constructs', () => {
    const source = [
      '---', //  1
      'title: Front', //  2
      '---', //  3
      '', //  4
      '# Heading **bold**', //  5
      'soft line', //  6
      'continues  ', //  7
      'after hard break', //  8
      '', //  9
      '- item one', // 10
      '  - nested item', // 11
      '', // 12
      '| a | b |', // 13
      '|---|---|', // 14
      '| c | d |', // 15
      '', // 16
      '```js', // 17
      'const x = 1;', // 18
      '```', // 19
      '', // 20
      '    indented code', // 21
    ].join('\n');
    const text = extractSearchText(parseMarkdown(source), source);
    const byLine = Object.fromEntries(
      text.lines.map((line, index) => [text.sourceLines[index], line]),
    );
    expect(byLine[2]).to.equal('title: Front');
    expect(byLine[5]).to.equal('Heading bold');
    expect(byLine[6]).to.equal('soft line');
    expect(byLine[7]).to.equal('continues');
    expect(byLine[8]).to.equal('after hard break');
    expect(byLine[10]).to.equal('item one');
    expect(byLine[11]).to.equal('nested item');
    expect(byLine[13]).to.equal('a | b');
    expect(byLine[15]).to.equal('c | d');
    expect(byLine[18]).to.equal('const x = 1;');
    expect(byLine[21]).to.equal('indented code');
    expect(text.kinds[text.sourceLines.indexOf(5)]).to.equal('heading');
    expect(text.kinds[text.sourceLines.indexOf(2)]).to.equal('frontmatter');
    expect(text.kinds[text.sourceLines.indexOf(18)]).to.equal('code');
  });
});

describe('workspace search snippets', () => {
  it('trims leading indentation and shifts ranges', () => {
    expect(buildSnippet('    find me', [[9, 11]])).to.deep.equal({
      snippet: 'find me',
      ranges: [[5, 7]],
    });
  });

  it('windows long lines around the first match with ellipses', () => {
    const line = `${'a'.repeat(300)}needle${'b'.repeat(300)}`;
    const { snippet, ranges } = buildSnippet(line, [[300, 306]]);
    expect(snippet.startsWith('…')).to.equal(true);
    expect(snippet.endsWith('…')).to.equal(true);
    const [start, end] = ranges[0]!;
    expect(snippet.slice(start, end)).to.equal('needle');
  });
});

describe('workspace search ranking', () => {
  it('ranks title hits, then match count, then recency, then path', async () => {
    const result = await searchDocuments(
      [
        document('b.md', 'Beta', 'apple apple apple', '2026-01-01T00:00:00.000Z'),
        document('c.md', 'Gamma', 'apple', '2026-03-01T00:00:00.000Z'),
        document('d.md', 'Delta', 'apple', '2026-02-01T00:00:00.000Z'),
        document('apple.md', 'Fruit', 'nothing here'),
        document('e.md', 'Apple pie', 'pie'),
        document('z.md', 'Zed', 'no match'),
      ],
      { text: 'apple' },
      noYield,
    );
    // Title and file-name hits tie on match count and recency, then sort by path.
    expect(result.documents.map((entry) => entry.path)).to.deep.equal([
      'apple.md',
      'e.md',
      'b.md',
      'c.md',
      'd.md',
    ]);
    expect(result.documents[0]!.titleRanges).to.deep.equal([]);
    expect(result.documents[1]!.titleRanges).to.deep.equal([[0, 5]]);
    expect(result.totalMatches).to.equal(5);
  });

  it('reports line numbers, occurrences, and per-document caps', async () => {
    const body = ['one hit', 'none', 'hit hit', 'hit'].join('\n');
    const result = await searchDocuments([document('a.md', 'A', body)], { text: 'hit' }, noYield, {
      maxLinesPerDocument: 2,
    });
    const [entry] = result.documents;
    expect(entry!.matches.map((match) => [match.line, match.occurrence])).to.deep.equal([
      [1, 0],
      [3, 1],
    ]);
    expect(entry!.moreMatches).to.equal(true);
    expect(entry!.matchCount).to.equal(4);
  });

  it('marks results truncated past the document cap and counts pending documents', async () => {
    const pending: SearchableDocument = {
      ...document('p.md', 'Pending', ''),
      text: null,
      pending: true,
    };
    const result = await searchDocuments(
      [document('a.md', 'A', 'x'), document('b.md', 'B', 'x'), pending],
      { text: 'x' },
      noYield,
      { maxDocuments: 1 },
    );
    expect(result.documents).to.have.length(1);
    expect(result.truncated).to.equal(true);
    expect(result.pendingDocuments).to.equal(1);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const checkpoint = createCheckpoint(
      () => Promise.resolve(),
      () => 0,
      controller.signal,
    );
    let failure: unknown;
    try {
      await searchDocuments([document('a.md', 'A', 'x')], { text: 'x' }, checkpoint);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });
});
