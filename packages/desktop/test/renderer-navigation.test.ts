import { expect } from 'chai';
import { blocksRendererRedirect } from '../main/renderer-navigation.js';

describe('renderer redirect guard', () => {
  it('keeps the main frame on the DocBlocks renderer', () => {
    expect(blocksRendererRedirect({ url: 'https://evil.example/', isMainFrame: true })).to.equal(
      true,
    );
    expect(
      blocksRendererRedirect({ url: 'app://docblocks/index.html', isMainFrame: true }),
    ).to.equal(false);
  });

  it('allows the trusted development origin only when one is given', () => {
    const url = 'http://localhost:5221/';
    expect(blocksRendererRedirect({ url, isMainFrame: true }, 'http://localhost:5221')).to.equal(
      false,
    );
    expect(blocksRendererRedirect({ url, isMainFrame: true })).to.equal(true);
  });

  it("lets a hosted player's frame follow its own redirect", () => {
    expect(
      blocksRendererRedirect({
        url: 'https://player.vimeo.com/video/76979871',
        isMainFrame: false,
      }),
    ).to.equal(false);
  });
});
