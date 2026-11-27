import { expect } from 'chai';
import { findRequestForSearchOpen } from '../src/WorkspaceSearch/search-find-request.js';

describe('findRequestForSearchOpen', () => {
  const match = {
    line: 12,
    kind: 'text' as const,
    snippet: 'A Zebracorn lantern',
    ranges: [[2, 11]] as const,
    occurrence: 3,
  };

  it("selects the chosen line's first match with the search's options", () => {
    expect(
      findRequestForSearchOpen({
        path: 'notes/a.md',
        match,
        query: 'zebracorn',
        matchCase: false,
        wholeWord: true,
      }),
    ).to.deep.equal({ query: 'zebracorn', matchCase: false, wholeWord: true, occurrence: 3 });
  });

  it('lands on the first match when the document row is opened', () => {
    expect(
      findRequestForSearchOpen({
        path: 'notes/a.md',
        match: null,
        query: 'Zebracorn',
        matchCase: true,
        wholeWord: false,
      }),
    ).to.deep.equal({ query: 'Zebracorn', matchCase: true, wholeWord: false, occurrence: 0 });
  });

  it('keeps the query exactly as searched, spaces included', () => {
    expect(
      findRequestForSearchOpen({
        path: 'a.md',
        match,
        query: ' lantern ',
        matchCase: false,
        wholeWord: false,
      })?.query,
    ).to.equal(' lantern ');
  });

  it('asks for nothing without a query', () => {
    expect(
      findRequestForSearchOpen({
        path: 'a.md',
        match: null,
        query: '   ',
        matchCase: false,
        wholeWord: false,
      }),
    ).to.equal(null);
  });
});
