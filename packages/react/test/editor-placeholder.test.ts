import { expect } from 'chai';
import { EMPTY_DOCUMENT_PROMPTS, pickEmptyDocumentPrompt } from '../src/editor.js';

describe('empty document prompts', () => {
  it('owns the complete DocBlocks prompt catalog', () => {
    expect(EMPTY_DOCUMENT_PROMPTS).to.have.length(57);
    expect(new Set(EMPTY_DOCUMENT_PROMPTS).size).to.equal(EMPTY_DOCUMENT_PROMPTS.length);
  });

  it('selects across the full catalog', () => {
    expect(pickEmptyDocumentPrompt(() => 0)).to.equal(EMPTY_DOCUMENT_PROMPTS[0]);
    expect(pickEmptyDocumentPrompt(() => 0.999999)).to.equal(
      EMPTY_DOCUMENT_PROMPTS[EMPTY_DOCUMENT_PROMPTS.length - 1],
    );
  });

  it('falls back safely when a custom random source is out of range', () => {
    expect(pickEmptyDocumentPrompt(() => 1)).to.equal(EMPTY_DOCUMENT_PROMPTS[0]);
  });
});
