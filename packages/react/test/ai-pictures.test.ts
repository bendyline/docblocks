import { expect } from 'chai';

import {
  buildDraftRequest,
  buildReviewRequest,
  reviewDocumentCharacters,
  sanitizeGeneratedMarkdown,
  withoutPictureFindings,
  type AiReviewFinding,
} from '../src/Ai/ai-assistant.js';
import {
  elideSvgPictures,
  normalizeGeneratedPictures,
  svgPictureRanges,
} from '../src/Ai/ai-pictures.js';

const SVG =
  '<svg viewBox="0 0 120 60" aria-label="Two boxes">\n' +
  '  <rect x="5" y="5" width="50" height="50" fill="currentColor"/>\n' +
  '  <rect x="65" y="5" width="50" height="50" fill="none" stroke="currentColor"/>\n' +
  '</svg>';
const FENCE = `\`\`\`svg\n${SVG}\n\`\`\``;
const DOC = `# Report\n\nThe intro paragraph.\n\n${FENCE}\n\nThe closing paragraph.\n`;

function finding(quote: string, replacement: string | null = 'Better.'): AiReviewFinding {
  return {
    id: 'ai-review-1',
    category: 'Clarity',
    severity: 'suggestion',
    message: 'Tighten this.',
    rationale: null,
    originalText: quote,
    replacement,
  };
}

describe('AI pictures', () => {
  describe('svgPictureRanges', () => {
    it('finds ```svg fences at any depth, with their accessible names', () => {
      const nested = `- An item\n\n  \`\`\`svg\n  <svg viewBox="0 0 4 4"><title>Dot</title></svg>\n  \`\`\`\n`;
      const [top] = svgPictureRanges(DOC);
      expect(DOC.slice(top?.start, top?.end)).to.equal(FENCE);
      expect(top?.title).to.equal('Two boxes');
      expect(svgPictureRanges(nested).map((range) => range.title)).to.deep.equal(['Dot']);
    });

    it('ignores code that only shows SVG source', () => {
      expect(svgPictureRanges(`\`\`\`xml\n${SVG}\n\`\`\`\n`)).to.deep.equal([]);
      expect(svgPictureRanges('No pictures here.')).to.deep.equal([]);
    });
  });

  describe('elideSvgPictures', () => {
    it('replaces each picture with a one-line stand-in and keeps the prose', () => {
      const elided = elideSvgPictures(DOC);
      expect(elided).not.to.contain('<rect');
      expect(elided).to.contain('[SVG picture: Two boxes (source omitted)]');
      expect(elided).to.contain('The intro paragraph.').and.contain('The closing paragraph.');
      expect(elideSvgPictures('Plain text.')).to.equal('Plain text.');
    });

    it('keeps a nested stand-in on one line so the list item survives', () => {
      const nested = `- An item\n\n  \`\`\`svg\n  ${SVG.replace(/\n/gu, '\n  ')}\n  \`\`\`\n- Next item\n`;
      expect(elideSvgPictures(nested)).to.equal(
        '- An item\n\n  [SVG picture: Two boxes (source omitted)]\n- Next item\n',
      );
    });
  });

  describe('prompts', () => {
    it('sends compose and rewrite context without picture source', () => {
      const compose = buildDraftRequest({
        mode: 'compose',
        instructions: 'Add a summary.',
        documentSource: DOC,
        selectedText: '',
      });
      expect(compose.messages[1]?.content).not.to.contain('<rect');
      expect(compose.messages[1]?.content).to.contain('[SVG picture: Two boxes');
      expect(compose.messages[0]?.content).to.contain('stands for a picture');

      const rewrite = buildDraftRequest({
        mode: 'rewrite',
        instructions: 'Shorten.',
        documentSource: DOC,
        selectedText: 'The closing paragraph.',
      });
      expect(rewrite.messages[1]?.content).not.to.contain('<rect');
    });

    it('sends the selection itself as written, pictures included', () => {
      const rewrite = buildDraftRequest({
        mode: 'rewrite',
        instructions: 'Shorten.',
        documentSource: DOC,
        selectedText: FENCE,
      });
      expect(rewrite.messages[1]?.content).to.contain(`<selection>\n${FENCE}\n</selection>`);
    });

    it('leaves the prompt unchanged for a document with no pictures', () => {
      const request = buildDraftRequest({
        mode: 'compose',
        instructions: 'Add a summary.',
        documentSource: '# Notes\n\nText.',
        selectedText: '',
      });
      expect(request.messages[0]?.content).not.to.contain('stands for a picture');
    });

    it('reviews the document without picture source, and measures it that way', () => {
      const request = buildReviewRequest(DOC);
      expect(request.messages[1]?.content).not.to.contain('<rect');
      expect(request.messages[0]?.content).to.contain('stands for a picture');
      const heavy = `${DOC}\n\`\`\`svg\n<svg viewBox="0 0 1 1"><!--${'x'.repeat(5_000)}--></svg>\n\`\`\`\n`;
      expect(reviewDocumentCharacters(heavy)).to.be.lessThan(heavy.length - 5_000);
    });
  });

  describe('withoutPictureFindings', () => {
    it('drops findings that quote, reproduce, or land inside a picture', () => {
      const kept = finding('The intro paragraph.');
      const findings = [
        kept,
        finding('[SVG picture: Two boxes (source omitted)]'),
        finding('The closing paragraph.', 'Closing. [SVG picture: Two boxes (source omitted)]'),
        finding('fill="none" stroke="currentColor"'),
      ];
      expect(withoutPictureFindings(findings, DOC)).to.deep.equal([kept]);
    });

    it('keeps everything when the document has no pictures', () => {
      const findings = [finding('Text.')];
      expect(withoutPictureFindings(findings, '# Notes\n\nText.')).to.deep.equal(findings);
    });
  });

  describe('normalizeGeneratedPictures', () => {
    it('fences a raw <svg> block, blank lines and XML prolog included', () => {
      const raw = '<svg viewBox="0 0 10 10">\n\n<circle cx="5" cy="5" r="4"/>\n</svg>';
      const output = `Intro.\n\n<?xml version="1.0"?>\n${raw}\n\nAfter.`;
      expect(normalizeGeneratedPictures(output)).to.equal(
        `Intro.\n\n\`\`\`svg\n${raw}\n\`\`\`\n\nAfter.`,
      );
    });

    it('closes a nested <svg> at its own end tag', () => {
      const raw = '<svg viewBox="0 0 10 10"><svg x="1"><rect width="2" height="2"/></svg></svg>';
      expect(normalizeGeneratedPictures(raw)).to.equal(`\`\`\`svg\n${raw}\n\`\`\``);
    });

    it('retags an ```xml or ```html fence that holds one SVG document', () => {
      expect(normalizeGeneratedPictures(`\`\`\`xml\n${SVG}\n\`\`\``)).to.equal(FENCE);
      expect(normalizeGeneratedPictures(`\`\`\`HTML\n${SVG}\n\`\`\``)).to.equal(FENCE);
    });

    it('leaves SVG it cannot render, inline SVG, and other code alone', () => {
      const cases = [
        '<svg viewBox="0 0 10 10"><circle r="4"/>', // never closed
        'Inline <svg viewBox="0 0 1 1"></svg> in a sentence.',
        `\`\`\`xml\n<svg/>\n<p>not one document</p>\n\`\`\``,
        `\`\`\`xml\n<config><svg/></config>\n\`\`\``,
        `\`\`\`\n${SVG}\n\`\`\``,
        `\`\`\`html\n<div>${SVG}</div>\n\`\`\``,
        `- item\n\n  ${SVG.replace(/\n/gu, '\n  ')}\n`,
      ];
      for (const markdown of cases) expect(normalizeGeneratedPictures(markdown)).to.equal(markdown);
    });

    it('never changes a block copied from the existing document', () => {
      const shownAsCode = `\`\`\`xml\n${SVG}\n\`\`\``;
      const existing = `# Doc\n\nHow the logo is built:\n\n${shownAsCode}\n`;
      expect(normalizeGeneratedPictures(`Rewritten intro.\n\n${shownAsCode}`, existing)).to.equal(
        `Rewritten intro.\n\n${shownAsCode}`,
      );
      expect(normalizeGeneratedPictures(SVG, `Old raw block:\n\n${SVG}\n`)).to.equal(SVG);
    });

    it('uses a longer fence when the SVG holds a run of backticks', () => {
      const raw = '<svg viewBox="0 0 10 10"><text y="5">```</text></svg>';
      expect(normalizeGeneratedPictures(raw)).to.equal(`\`\`\`\`svg\n${raw}\n\`\`\`\``);
    });

    it('runs as part of sanitizing generated Markdown, and is idempotent', () => {
      const once = sanitizeGeneratedMarkdown(`\`\`\`\n${SVG}\n\`\`\``);
      expect(once).to.equal(FENCE);
      expect(sanitizeGeneratedMarkdown(once)).to.equal(FENCE);
    });
  });
});
