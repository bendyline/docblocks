import { expect } from 'chai';

import { assembleSummary, compileSummaryBody } from '../src/Ai/study-compile.js';
import {
  readStudyAidProvenance,
  studyAidBody,
  type StudyAidProvenance,
} from '../src/Ai/study-aids.js';

function provenance(kind: StudyAidProvenance['kind']): StudyAidProvenance {
  return {
    kind,
    source: 'plants.md',
    sourceSha256: 'a'.repeat(64),
    generatedAt: '2026-10-17T18:04:00.000Z',
    model: 'Small Model',
  };
}

describe('study aid compiler', () => {
  it('cleans a summary reply and gives it the compiler’s own title', () => {
    const body = compileSummaryBody(
      '<think>planning</think>\n```markdown\n# Summary\n\nPlants make food.\n\n## Key points\n\n- Light\n```',
    );
    expect(body).to.equal('Plants make food.\n\n### Key points\n\n- Light');
    const markdown = assembleSummary(body, 'Plants', provenance('summary'));
    expect(markdown).to.match(/^---\n/u);
    expect(markdown).not.to.contain('display-mode');
    expect(studyAidBody(markdown)).to.equal(`# Summary: Plants\n\n${body}\n`);
    expect(readStudyAidProvenance(markdown)).to.deep.equal(provenance('summary'));
  });

  it('leaves headings inside a code fence alone', () => {
    expect(compileSummaryBody('Intro.\n\n```\n# comment\n```')).to.equal(
      'Intro.\n\n```\n# comment\n```',
    );
  });
});
