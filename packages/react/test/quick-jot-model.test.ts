import { expect } from 'chai';
import {
  attachmentFileName,
  attachmentReference,
  isImageAttachment,
} from '../src/Home/attachments.js';
import {
  MAX_JOT_ATTACHMENTS,
  dragCarriesFiles,
  spliceText,
  splitJotTask,
  withAttachments,
  withDictatedPhrase,
} from '../src/QuickJot/quick-jot-model.js';

function transfer(types: string[]): DataTransfer {
  return { types } as unknown as DataTransfer;
}

describe('quick jot model', () => {
  it('names attachments safely, even pasted ones with no name', () => {
    expect(attachmentFileName({ name: 'Venue: plan?.PNG', type: 'image/png' })).to.equal(
      'Venue plan.png',
    );
    expect(attachmentFileName({ name: '', type: 'image/jpeg' })).to.equal('image.jpg');
    expect(attachmentFileName({ name: '.hidden', type: 'application/pdf' })).to.equal('hidden.pdf');
    expect(attachmentFileName({ name: 'notes', type: '' })).to.equal('notes');
    expect(attachmentFileName({ name: '', type: 'application/octet-stream' })).to.equal(
      'attachment',
    );
  });

  it('references pictures as images and other files as links', () => {
    const png = { name: 'a.png', type: 'image/png' };
    expect(isImageAttachment({ name: 'scan.JPG', type: '' })).to.equal(true);
    expect(attachmentReference(png, 'Note_files/a.png')).to.equal('![a](Note_files/a.png)');
    expect(attachmentReference(png, 'My note_files/a (2).png')).to.equal(
      '![a (2)](<My note_files/a (2).png>)',
    );
    expect(
      attachmentReference({ name: 'q.pdf', type: 'application/pdf' }, 'Note_files/q.pdf'),
    ).to.equal('[q.pdf](Note_files/q.pdf)');
  });

  it('takes files from outside DocBlocks only', () => {
    expect(dragCarriesFiles(transfer(['Files']))).to.equal(true);
    expect(dragCarriesFiles(transfer(['Files', 'application/x-docblocks-entry']))).to.equal(false);
    expect(dragCarriesFiles(transfer(['text/plain']))).to.equal(false);
    expect(dragCarriesFiles(null)).to.equal(false);
  });

  it('keeps attachments within limits and says what it left out', () => {
    const file = (size = 3) => new File(['x'.repeat(size)], 'a.png', { type: 'image/png' });
    const many = Array.from({ length: MAX_JOT_ATTACHMENTS + 2 }, () => file());
    const result = withAttachments([], many);
    expect(result.attachments).to.have.length(MAX_JOT_ATTACHMENTS);
    expect(result.refused).to.match(/^Quick Jot keeps up to 20 files/);
    expect(result.attachments[0]!.kind).to.equal('image');
    expect(new Set(result.attachments.map((a) => a.id)).size).to.equal(MAX_JOT_ATTACHMENTS);
    expect(withAttachments([], [file()]).refused).to.equal(null);
  });

  it('reads a task from the first line and keeps the rest as notes', () => {
    expect(
      splitJotTask('\n  Call Priya tomorrow \nabout the venue\n\nand the date\n'),
    ).to.deep.equal({ title: 'Call Priya tomorrow', notes: 'about the venue\n\nand the date' });
    expect(splitJotTask('   ')).to.deep.equal({ title: '', notes: '' });
  });

  it('inserts at the caret and adds dictated phrases a space apart', () => {
    expect(spliceText('Hello world', 6, 11, 'there')).to.deep.equal({
      text: 'Hello there',
      caret: 11,
    });
    expect(spliceText('abc', 10, 2, 'X')).to.deep.equal({ text: 'abcX', caret: 4 });
    expect(withDictatedPhrase('', ' Call Priya ')).to.equal('Call Priya');
    expect(withDictatedPhrase('Call Priya', 'tomorrow.')).to.equal('Call Priya tomorrow.');
    expect(withDictatedPhrase('Notes\n', 'one')).to.equal('Notes\none');
    expect(withDictatedPhrase('Same', '  ')).to.equal('Same');
  });
});
