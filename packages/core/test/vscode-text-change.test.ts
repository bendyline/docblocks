import { expect } from 'chai';
import { hasSubstantiveTextChange } from '../src/vscode/text-change.js';

describe('VS Code substantive text change detection', () => {
  it('ignores whitespace-only snapshot differences', () => {
    expect(
      hasSubstantiveTextChange('# Heading\nBody text', '\n# Heading\n\nBody   text\n'),
    ).to.equal(false);
    expect(hasSubstantiveTextChange('alpha beta', 'alpha\u00a0\n beta')).to.equal(false);
  });

  it('detects non-whitespace serializer and authored changes', () => {
    expect(hasSubstantiveTextChange('**bold**', '\\*\\*bold\\*\\*')).to.equal(true);
    expect(hasSubstantiveTextChange('alpha', 'alpha!')).to.equal(true);
    expect(hasSubstantiveTextChange('alpha', '')).to.equal(true);
  });
});
