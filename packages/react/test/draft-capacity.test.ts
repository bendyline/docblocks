import { expect } from 'chai';
import { AI_WIRE_LIMITS, type AiChatRequest, type AiModelInfo } from '@bendyline/docblocks/host';
import { draftCapacityNotice } from '../src/Ai/draft-capacity.js';

const model: AiModelInfo = {
  id: 'mlx:writer',
  label: 'Writer',
  local: true,
  isDefault: true,
  contextWindow: 65536,
};
const request = (content: string): AiChatRequest => ({
  purpose: 'write',
  messages: [{ role: 'user', content }],
});

describe('draft capacity guidance', () => {
  it('uses the selected model capacity and reserves room for the rewrite, not just the input', () => {
    const input = request('x'.repeat(6000));
    expect(draftCapacityNotice(input, model, 'x'.repeat(6000))).to.equal(null);
    const warning = draftCapacityNotice(input, { ...model, contextWindow: 4096 }, 'x'.repeat(6000));
    expect(warning?.blocked).to.equal(false);
    expect(warning?.message).to.contain('4,096-token').and.contain('estimate');
  });

  it('does not invent a context size for an unknown model', () => {
    expect(draftCapacityNotice(request('x'.repeat(120000)), null)).to.equal(null);
    expect(
      draftCapacityNotice(request('x'.repeat(120000)), { ...model, contextWindow: null }),
    ).to.equal(null);
  });

  it('accounts for non-ASCII text without claiming an exact tokenizer result', () => {
    expect(
      draftCapacityNotice(request('界'.repeat(4000)), { ...model, contextWindow: 4096 })?.message,
    ).to.contain('not an exact token count');
  });

  it('blocks only the actual transport limit, preserving recovery instructions', () => {
    const notice = draftCapacityNotice(
      request('x'.repeat(AI_WIRE_LIMITS.promptCharacters + 1)),
      model,
    );
    expect(notice?.blocked).to.equal(true);
    expect(notice?.message).to.contain('Your draft is preserved');
  });
});
