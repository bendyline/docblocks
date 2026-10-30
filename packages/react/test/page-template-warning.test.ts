import { expect } from 'chai';
import { OutsideInTemplateError } from '../src/DocBlocksShell/outside-in.js';
import {
  clearRegeneratedPageTemplateWarning,
  isPageTemplateWarningFor,
  nextPageTemplateWarning,
  pageTemplateWarningFor,
} from '../src/DocBlocksShell/page-template-warning.js';

const missing = new OutsideInTemplateError(
  '_templates/post.html',
  'The page template "_templates/post.html" was not found.',
);
const broken = new OutsideInTemplateError(
  '_templates/post.html',
  'The page template "_templates/post.html" can\'t be used. It has no unnamed <slot>.',
);

describe('Page template warning', () => {
  it('shows a blocked render for its page only, whatever the path spelling', () => {
    const warning = nextPageTemplateWarning(null, '/posts/a.html', missing);
    expect(warning).to.deep.equal({
      targetPath: 'posts/a.html',
      message: missing.message,
      dismissed: false,
    });
    expect(isPageTemplateWarningFor(warning, 'posts/a.html')).to.equal(true);
    expect(isPageTemplateWarningFor(warning, '/posts/a.html')).to.equal(true);
    expect(isPageTemplateWarningFor(warning, 'posts/b.html')).to.equal(false);
    expect(isPageTemplateWarningFor(warning, null)).to.equal(false);
  });

  it('keeps a Dismiss through repeated autosaves until the problem changes', () => {
    const dismissed = {
      ...nextPageTemplateWarning(null, 'posts/a.html', missing)!,
      dismissed: true,
    };
    const again = nextPageTemplateWarning(dismissed, 'posts/a.html', missing);
    expect(again).to.equal(dismissed);
    expect(isPageTemplateWarningFor(again, 'posts/a.html')).to.equal(false);

    const changed = nextPageTemplateWarning(again, 'posts/a.html', broken);
    expect(changed?.message).to.equal(broken.message);
    expect(isPageTemplateWarningFor(changed, 'posts/a.html')).to.equal(true);
  });

  it('clears when its own page renders, not when another page does', () => {
    const warning = nextPageTemplateWarning(null, 'posts/a.html', missing);
    expect(nextPageTemplateWarning(warning, 'posts/b.html', null)).to.equal(warning);
    expect(nextPageTemplateWarning(warning, '/posts/a.html', null)).to.equal(null);
  });

  it('clears when a template pass regenerates its page', () => {
    const warning = pageTemplateWarningFor('posts/a.html', missing);
    expect(clearRegeneratedPageTemplateWarning(warning, ['posts/b.html'])).to.equal(warning);
    expect(clearRegeneratedPageTemplateWarning(warning, ['/posts/a.html'])).to.equal(null);
    expect(clearRegeneratedPageTemplateWarning(null, ['posts/a.html'])).to.equal(null);
  });

  it('has nothing to show for a page that opened cleanly', () => {
    expect(pageTemplateWarningFor('posts/a.html', undefined)).to.equal(null);
    expect(pageTemplateWarningFor('posts/a.html', null)).to.equal(null);
  });
});
