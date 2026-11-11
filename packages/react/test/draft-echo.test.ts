import { expect } from 'chai';

import { elideSvgPictures } from '../src/Ai/ai-pictures.js';
import { withoutDocumentEcho } from '../src/Ai/draft-echo.js';

const TWIT = '# Twit\n\nThis is fun\n\nYay hybrid yay yay yay\n';

describe('withoutDocumentEcho', () => {
  it('removes the whole document copied ahead of new text', () => {
    // Gemma 4 E2B, asked for a story, returned the document and then the story.
    const result = withoutDocumentEcho(`${TWIT}\nOnce upon a time, in a meadow.`, TWIT);
    expect(result).to.deep.equal({ text: 'Once upon a time, in a meadow.', removed: true });
  });

  it('removes a copied title at another level and the document copied after new text', () => {
    // Apple's on-device model, asked for an introduction.
    expect(withoutDocumentEcho('## Twit\n\nA brief note.', TWIT).text).to.equal('A brief note.');
    expect(
      withoutDocumentEcho(
        '# Twit\n\nA brief expression of excitement.\n\nThis is fun\n\nYay hybrid yay yay yay',
        TWIT,
      ).text,
    ).to.equal('A brief expression of excitement.');
  });

  it('removes a fenced copy of the document', () => {
    const draft =
      '## Introduction\n\nA brief expression of enthusiasm.\n\n```markdown\n' +
      '# Twit\n\nThis is fun\n\nYay hybrid yay yay yay\n```';
    expect(withoutDocumentEcho(draft, TWIT).text).to.equal(
      '## Introduction\n\nA brief expression of enthusiasm.',
    );
  });

  it('keeps one block that matches a block in the middle of the document', () => {
    const source = '# Guide\n\n## Example\n\nOne.\n\n## Usage\n\nTwo.';
    const draft = '## Example\n\nThree.';
    expect(withoutDocumentEcho(draft, source)).to.deep.equal({ text: draft, removed: false });
    // A code fence of new Markdown is new text, not a copy.
    const fenced = 'Use it like this:\n\n```markdown\n## Example\n\nFour.\n```';
    expect(withoutDocumentEcho(fenced, source).removed).to.equal(false);
  });

  it('leaves nothing when the draft only repeats the document', () => {
    expect(withoutDocumentEcho(TWIT.trim(), TWIT)).to.deep.equal({ text: '', removed: true });
    // Apple's model copied the paragraphs with periods added and a hard break.
    expect(
      withoutDocumentEcho('# Twit\n\nThis is fun.  \n\nYay hybrid yay yay yay.', TWIT),
    ).to.deep.equal({ text: '', removed: true });
  });

  it('matches headings whatever their block annotation', () => {
    const source = '# Twit {[factCard]}\n\nThis is fun';
    expect(withoutDocumentEcho('# Twit\n\nNew text.', source).text).to.equal('New text.');
    expect(withoutDocumentEcho('# Twit {[factCard]}\n\nNew text.', '# Twit').text).to.equal(
      'New text.',
    );
  });

  it('removes copied frontmatter with the copy', () => {
    const source = '---\ntitle: Notes\n---\n\n# Notes\n\nBody.';
    expect(
      withoutDocumentEcho('---\ntitle: Notes\n---\n\n# Notes\n\nNew text.', source).text,
    ).to.equal('New text.');
  });

  it('removes a copied picture stand-in', () => {
    const source =
      '# Chart\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" aria-label="Sales"></svg>\n```\n\nBody.';
    const elided = elideSvgPictures(source);
    expect(elided).to.contain('[SVG picture');
    expect(withoutDocumentEcho(`${elided}\n\nNew text.`, source).text).to.equal('New text.');
  });

  it('keeps the end of an unfinished draft, where a continuation picks up', () => {
    const draft = 'New text.\n\nThis is fun\n\nYay hybrid yay yay yay';
    expect(withoutDocumentEcho(draft, TWIT, { trailing: false })).to.deep.equal({
      text: draft,
      removed: false,
    });
    // Its start is still removed, without trimming the join.
    expect(
      withoutDocumentEcho('# Twit\n\nThis is fun\n\nA para', TWIT, { trailing: false }).text,
    ).to.equal('A para');
    expect(withoutDocumentEcho('# Twit\n\nA para ', TWIT, { trailing: false }).text).to.equal(
      'A para ',
    );
  });

  it('changes nothing for an empty document or draft', () => {
    expect(withoutDocumentEcho('# Twit\n\nNew.', '').removed).to.equal(false);
    expect(withoutDocumentEcho('', TWIT)).to.deep.equal({ text: '', removed: false });
  });
});
