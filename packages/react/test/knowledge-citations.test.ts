import { expect } from 'chai';

import { citationsToFootnotes, stripCitationMarkers } from '../src/Ai/knowledge-citations.js';

const evidence = [
  { title: 'Panama Hotel (Seattle)', catalogId: 'pnw', text: 'Built in 1910.' },
  { title: 'Nihonmachi', catalogId: 'pnw', text: 'Japantown.' },
];
const names = new Map([['pnw', 'Pacific Northwest']]);

describe('knowledge citations in inserted text', () => {
  it('turns each cited passage into one footnote naming its article and catalog', () => {
    expect(
      citationsToFootnotes(
        'It opened in 1910 [1]. It anchored Japantown [2, 1].\n\nIt still stands [1].',
        evidence,
        names,
        '# Panama Hotel\n',
      ),
    ).to.equal(
      'It opened in 1910[^source-1]. It anchored Japantown[^source-2][^source-1].\n\n' +
        'It still stands[^source-1].\n\n' +
        '[^source-1]: Panama Hotel (Seattle), from the Pacific Northwest knowledge catalog.\n' +
        '[^source-2]: Nihonmachi, from the Pacific Northwest knowledge catalog.',
    );
  });

  it("keeps clear of the document's footnotes, links and code, and drops unknown numbers", () => {
    const result = citationsToFootnotes(
      'See [the site](https://example.com) and note[^1] [2] [9].\n\n```\nlist[1]\n```',
      evidence,
      names,
      'Earlier.[^source-1]\n\n[^source-1]: Mine.',
    );
    expect(result).to.equal(
      'See [the site](https://example.com) and note[^1][^source-2].\n\n```\nlist[1]\n```\n\n' +
        '[^source-2]: Nihonmachi, from the Pacific Northwest knowledge catalog.',
    );
  });

  it('gives passages from one article one footnote', () => {
    const sameArticle = [
      { title: 'Panama Hotel (Seattle)', catalogId: 'pnw', text: 'Built in 1910.' },
      { title: 'Panama Hotel (Seattle)', catalogId: 'pnw', text: 'Key facts.' },
    ];
    expect(
      citationsToFootnotes(
        'Built in 1910 [1]. Listed in 2006 [2]. Both [1, 2].',
        sameArticle,
        names,
        '',
      ),
    ).to.equal(
      'Built in 1910[^source-1]. Listed in 2006[^source-1]. Both[^source-1].\n\n' +
        '[^source-1]: Panama Hotel (Seattle), from the Pacific Northwest knowledge catalog.',
    );
  });

  it('leaves text without citations alone', () => {
    expect(citationsToFootnotes('No sources here.', evidence, names, '')).to.equal(
      'No sources here.',
    );
  });

  it('strips markers where a rewritten selection has nowhere to put a note', () => {
    expect(stripCitationMarkers('Built in 1910 [1], in Japantown [1-2].')).to.equal(
      'Built in 1910, in Japantown.',
    );
  });
});
