import { expect } from 'chai';

import {
  chunkStudySections,
  segmentStudySections,
  studyBudget,
  studyCharacters,
  type StudyBudget,
} from '../src/Ai/study-sections.js';

const SOURCE = [
  '---',
  'title: Plants',
  '---',
  '',
  'An opening paragraph before any heading.',
  '',
  '# Photosynthesis {[factCard]}',
  '',
  'Plants take in **carbon dioxide** and release oxygen.',
  '',
  '- Light',
  '- Water',
  '',
  '```svg',
  '<svg viewBox="0 0 10 10"><title>Leaf</title></svg>',
  '```',
  '',
  '## Empty section',
  '',
  '## Roots',
  '',
  '| Part | Job |',
  '|---|---|',
  '| Root | Water |',
  '',
].join('\n');

function sentence(index: number): string {
  return `Sentence ${String(index)} explains another detail about how plants grow.`;
}

function budget(overrides: Partial<StudyBudget>): StudyBudget {
  return { ...studyBudget(4_096), ...overrides };
}

describe('study aid sections', () => {
  it('keeps prose under its heading and leaves out code, pictures, and empty sections', () => {
    expect(segmentStudySections(SOURCE)).to.deep.equal([
      { heading: '', text: 'An opening paragraph before any heading.' },
      {
        heading: 'Photosynthesis',
        text: 'Plants take in carbon dioxide and release oxygen.\n\nLight\nWater',
      },
      { heading: 'Roots', text: 'Part Job\nRoot Water' },
    ]);
  });

  it('sizes budgets for small and large context windows', () => {
    const small = studyBudget(null);
    expect(small.contextTokens).to.equal(4_096);
    expect(small.summaryTokens).to.be.at.most(1_024);
    expect(small.itemTokens).to.be.at.most(1_024);
    // What one call carries, plus its output, fits the window at 3 characters a token.
    expect(small.chunkCharacters / 3 + small.itemTokens).to.be.below(small.contextTokens);
    const large = studyBudget(131_072);
    expect(large.chunkCharacters).to.equal(24_000);
    expect(large.maxChunks).to.be.greaterThan(small.maxChunks);
  });

  it('puts a short document in one part', () => {
    const { chunks, shortened } = chunkStudySections(
      segmentStudySections(SOURCE),
      studyBudget(4_096),
    );
    expect(chunks).to.have.length(1);
    expect(shortened).to.equal(false);
    expect(chunks[0]?.text).to.contain('## Photosynthesis\nPlants take in');
  });

  it('packs sections in order, splitting a long one between paragraphs', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => sentence(index)).join('\n\n');
    const sections = [
      { heading: 'Intro', text: 'Short intro.' },
      { heading: 'Growth', text: paragraphs },
      { heading: 'End', text: 'Short ending.' },
    ];
    const { chunks, shortened } = chunkStudySections(
      sections,
      budget({ chunkCharacters: 400, maxChunks: 20 }),
    );
    expect(shortened).to.equal(false);
    expect(chunks.length).to.be.at.least(2);
    for (const chunk of chunks) expect(chunk.text.length).to.be.at.most(400);
    const all = chunks.map((chunk) => chunk.text).join('\n\n');
    for (let index = 0; index < 12; index++) expect(all).to.contain(sentence(index));
    expect(all.indexOf('Short intro.')).to.be.below(all.indexOf(sentence(0)));
    expect(all.indexOf(sentence(11))).to.be.below(all.indexOf('Short ending.'));
    expect(all).to.contain('## Growth (continued)');
  });

  it('splits one paragraph longer than a part between sentences', () => {
    const text = Array.from({ length: 30 }, (_, index) => sentence(index)).join(' ');
    const { chunks } = chunkStudySections(
      [{ heading: '', text }],
      budget({ chunkCharacters: 500, maxChunks: 20 }),
    );
    expect(chunks.length).to.be.greaterThan(3);
    for (const chunk of chunks) expect(chunk.text.length).to.be.at.most(500);
    expect(chunks.map((chunk) => chunk.text).join(' ')).to.equal(text);
  });

  it('shortens every section, never the end, when the document needs too many parts', () => {
    const sections = Array.from({ length: 10 }, (_, index) => ({
      heading: `Part ${String(index + 1)}`,
      text: Array.from({ length: 8 }, (__, line) => sentence(index * 10 + line)).join('\n\n'),
    }));
    const tight = budget({ chunkCharacters: 600, maxChunks: 3 });
    const { chunks, shortened } = chunkStudySections(sections, tight);
    expect(shortened).to.equal(true);
    expect(chunks.length).to.be.at.most(3);
    const all = chunks.map((chunk) => chunk.text).join('\n\n');
    expect(all).to.contain('## Part 1');
    expect(all).to.contain('## Part 10');
    expect(studyCharacters(sections)).to.be.greaterThan(all.length);
  });

  it('returns no parts for a document with no prose', () => {
    expect(
      chunkStudySections(segmentStudySections('# Title\n\n```js\nx\n```\n'), studyBudget(4_096)),
    ).to.deep.equal({ chunks: [], shortened: false });
  });
});
