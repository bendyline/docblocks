/**
 * A workspace catalog entry describes the person's writing: its outline and
 * word count leave out side information kept in the document (slide
 * summaries, study cards).
 */
import { expect } from 'chai';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { catalogEntryFromDocument } from '../src/workspace-settings/catalog.js';

describe('workspace catalog: side information kept in a document', () => {
  it('leaves slide summaries and study cards out of the outline and word count', async () => {
    const withCards = [
      '# Plants',
      '',
      'Leaves catch the light.',
      '',
      '## Where does it happen? {[quiz]}',
      '',
      '- [x] In the leaves',
      '- [ ] In the roots',
      '',
      '## A slide {[summary]}',
      '',
      '- A point',
      '',
      '## Watering',
      '',
      'Water in the morning.',
    ].join('\n');
    const plain = '# Plants\n\nLeaves catch the light.\n\n## Watering\n\nWater in the morning.';
    const source = { path: 'notes.md', format: 'markdown' as const };
    const entry = await catalogEntryFromDocument(source, parseMarkdown(withCards));
    const expected = await catalogEntryFromDocument(source, parseMarkdown(plain));
    expect(entry.outline).to.deep.equal(expected.outline);
    expect(entry.wordCount).to.equal(expected.wordCount);
  });
});
