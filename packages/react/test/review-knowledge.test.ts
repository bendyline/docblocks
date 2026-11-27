import { expect } from 'chai';

import {
  buildReviewFollowUp,
  buildReviewRequest,
  buildReviewRequests,
} from '../src/Ai/ai-assistant.js';
import { REVIEW_QUERY_CHARACTERS, reviewKnowledgeQuery } from '../src/Ai/review-knowledge.js';
import { AI_REVIEW_STYLES } from '../src/Ai/review-styles.js';

describe('review knowledge search', () => {
  it('searches for the title and headings, not the document text', () => {
    const source =
      '---\ntitle: "Feeding a sourdough starter"\n# not a heading\n---\n\n' +
      '# Feeding a sourdough starter\n\nFlour and water, every day, by weight.\n\n' +
      '## Choosing a *flour* {#flour}\n\nRye works.\n\n' +
      '```bash\n# Not a heading either\n```\n\n' +
      '### Hydration ###\n\nAbout 100%.\n';
    expect(reviewKnowledgeQuery(source, source)).to.equal(
      'Feeding a sourdough starter\nChoosing a flour\nHydration',
    );
  });

  it('falls back to the opening text when there are no headings of its own', () => {
    expect(
      reviewKnowledgeQuery(
        '# Panama Hotel\n\n![A photo](hotel.jpg)\n\n> The hotel opened in 1910 in Nihonmachi.\n',
        '# Panama Hotel\n\n![A photo](hotel.jpg)\n\n> The hotel opened in 1910 in Nihonmachi.\n',
      ),
    ).to.equal('Panama Hotel\nThe hotel opened in 1910 in Nihonmachi.');
    const untitled = '- Bring the [ferry](https://example.com) schedule.\n- Pack lunch.';
    expect(reviewKnowledgeQuery(untitled, untitled)).to.equal(
      'Bring the ferry schedule. Pack lunch.',
    );
  });

  it("searches a part for the document's title and that part's own headings", () => {
    const source = '# Garden\n\n## Tomatoes\n\nStake them.\n\n## Aphids\n\nSoap spray.';
    expect(reviewKnowledgeQuery(source, '## Aphids\n\nSoap spray.')).to.equal('Garden\nAphids');
    expect(reviewKnowledgeQuery(source, 'Stake them early.')).to.equal('Garden\nStake them early.');
  });

  it('stays the length of a search', () => {
    const headings = Array.from({ length: 200 }, (_, index) => `## Section ${index}`).join('\n\n');
    const query = reviewKnowledgeQuery(`# Long\n\n${headings}`, `# Long\n\n${headings}`);
    expect(query.length).to.be.at.most(REVIEW_QUERY_CHARACTERS);
    expect(query.startsWith('Long\nSection 0\nSection 1\n')).to.equal(true);
  });

  it('sends every review style with that search, and follow-ups with the same one', () => {
    const source = '# Panama Hotel\n\n## History\n\nIt opened in 1910.';
    for (const style of AI_REVIEW_STYLES) {
      const request = buildReviewRequest(source, style);
      expect(request.knowledgeQuery, style).to.equal('Panama Hotel\nHistory');
      expect(request, style).not.to.have.property('searchKnowledge');
    }
    const request = buildReviewRequest(source);
    expect(buildReviewFollowUp(request, ['It opened in 1910.']).knowledgeQuery).to.equal(
      'Panama Hotel\nHistory',
    );
  });

  it('gives each part of a long document its own search', () => {
    const source =
      '# Field guide\n\n' +
      ['Birds', 'Trees', 'Mosses']
        .map((name) => `## ${name}\n\n${`${name} are common here. `.repeat(400)}`)
        .join('\n\n');
    const parts = buildReviewRequests(source, 'general', 4_096);
    expect(parts.length).to.be.greaterThan(1);
    for (const part of parts) expect(part.knowledgeQuery).to.match(/^Field guide\n/u);
    expect(new Set(parts.map((part) => part.knowledgeQuery)).size).to.be.greaterThan(1);
  });

  it('searches nothing when the document names no subject', () => {
    const request = buildReviewRequest('```js\nconst a = 1;\n```');
    expect(request.searchKnowledge).to.equal(false);
    expect(request).not.to.have.property('knowledgeQuery');
  });

  it('tells the reviewer to ignore unrelated passages and quote only the document', () => {
    for (const style of AI_REVIEW_STYLES) {
      expect(buildReviewRequest('# Title\n\nText.', style).messages[0]?.content, style)
        .to.contain('ignore any passage about something else')
        .and.contain('every quote comes from the document');
    }
  });
});
