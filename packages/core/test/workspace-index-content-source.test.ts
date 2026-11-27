/**
 * The workspace index keeps a document's writing, not the side information
 * kept in it (Squisq accessory blocks: slide summaries, study cards): a quiz
 * card's checklist is not a list of steps, and a card is not searched or
 * cited as the person's notes — while every other line keeps its number.
 */
import { expect } from 'chai';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import { analyzeDocumentBytes } from '../src/workspace-index/analyze.js';
import { blankDroppedLines } from '../src/workspace-index/content-source.js';

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const identity = {
  path: parseWorkspacePath('notes.md'),
  sourcePath: parseWorkspacePath('notes.md'),
  format: 'markdown' as const,
  lastModified: '',
};

const NOTES = [
  '# Plants',
  '',
  'Plants turn light into sugar.',
  '',
  '- [x] Water the ferns',
  '- [ ] Repot the basil',
  '',
  '## Where does it happen? {[quiz origin=ai]}',
  '',
  '- [ ] In the roots',
  '- [x] In the leaves',
  '',
  'Zanzibarquiz explains it.',
  '',
  '## Watering',
  '',
  'Water in the morning.',
].join('\n');

describe('workspace index: side information kept in a document', () => {
  it('counts only the document’s own checklist as steps', async () => {
    const analyzed = await analyzeDocumentBytes(identity, encode(NOTES), {
      maxParseBytes: 1_000_000,
    });
    expect(analyzed.record.checklist).to.deep.equal({ done: 1, total: 2 });
  });

  it('leaves a study card out of the searched and cited text, keeping every line’s number', async () => {
    const analyzed = await analyzeDocumentBytes(identity, encode(NOTES), {
      maxParseBytes: 1_000_000,
    });
    const searched = analyzed.text!.lines.join('\n');
    expect(searched).to.not.contain('Zanzibarquiz');
    expect(searched).to.contain('Water in the morning.');
    expect(analyzed.body).to.be.a('string');
    expect(analyzed.body).to.not.contain('Zanzibarquiz');
    expect(analyzed.body!.split('\n')).to.have.length(NOTES.split('\n').length);
    expect(analyzed.body!.split('\n')[16]).to.equal('Water in the morning.');
  });

  it('keeps a document without side information exactly as read', async () => {
    const plain = NOTES.split('## Where does it happen?')[0]!;
    const analyzed = await analyzeDocumentBytes(identity, encode(plain), {
      maxParseBytes: 1_000_000,
    });
    expect(analyzed.body).to.equal(undefined);
    expect(blankDroppedLines('a\nb', [])).to.equal('a\nb');
  });
});
