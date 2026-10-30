import { expect } from 'chai';
import { resolveTheme } from '@bendyline/squisq/schemas';
import {
  SOCIAL_IMAGE_HEIGHT,
  layoutSocialImage,
  type MeasureText,
} from '../src/DocBlocksShell/social-image.js';

/** Every character is half the font size wide. */
const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 0);
  return [...text].length * size * 0.5;
};

describe('social preview picture layout', () => {
  const theme = resolveTheme('warm-earth');

  it('sets a short title large, in the theme fonts and colors', () => {
    const layout = layoutSocialImage(
      { title: 'Gezel and Knowledge', description: 'Notes', site: 'example.com', theme },
      measure,
    );
    expect(layout.title.lines).to.deep.equal(['Gezel and Knowledge']);
    expect(layout.title.font).to.match(/^700 80px /);
    expect(layout.title.color).to.equal(theme.colors.text);
    expect(layout.description?.lines).to.deep.equal(['Notes']);
    expect(layout.description?.color).to.equal(theme.colors.textMuted);
    expect(layout.site?.lines).to.deep.equal(['example.com']);
    expect(layout.site?.color).to.equal(theme.colors.highlight);
    // The description follows the title, and the site sits below both.
    expect(layout.description!.top).to.be.greaterThan(layout.title.top);
    expect(layout.site!.top).to.be.greaterThan(layout.description!.top);
    expect(layout.site!.top + layout.site!.lineHeight).to.be.lessThan(SOCIAL_IMAGE_HEIGHT);
  });

  it('shrinks a long title to fit, then ends it in an ellipsis', () => {
    const medium = layoutSocialImage({ title: 'word '.repeat(30), theme }, measure);
    expect(medium.title.lines.length).to.be.at.most(3);
    expect(medium.title.font).not.to.match(/ 80px /);

    const long = layoutSocialImage({ title: 'word '.repeat(200), theme }, measure);
    expect(long.title.lines).to.have.length(3);
    expect(long.title.lines[2].endsWith('…')).to.equal(true);
    expect(long.title.lines[2]).not.to.match(/\s…$/);
  });

  it('breaks a word wider than the card', () => {
    const layout = layoutSocialImage({ title: 'x'.repeat(60), theme }, measure);
    expect(layout.title.lines.join('')).to.equal('x'.repeat(60));
    expect(layout.title.lines.length).to.be.greaterThan(1);
  });

  it('gives the description only the room the title leaves', () => {
    const layout = layoutSocialImage(
      { title: 'word '.repeat(200), description: 'more '.repeat(200), theme },
      measure,
    );
    expect(layout.description?.lines.length ?? 0).to.be.at.most(2);
    const bottom = layout.description
      ? layout.description.top + layout.description.lines.length * layout.description.lineHeight
      : layout.title.top + layout.title.lines.length * layout.title.lineHeight;
    expect(bottom).to.be.at.most(layout.site?.top ?? SOCIAL_IMAGE_HEIGHT);
  });

  it('leaves out an empty description and site', () => {
    const layout = layoutSocialImage({ title: 'Hi', description: '  ', theme }, measure);
    expect(layout.description).to.equal(null);
    expect(layout.site).to.equal(null);
  });
});
