import { expect } from 'chai';

import { parseFfmpegRenderRequest } from '../main/ffmpeg-request.js';

describe('FFmpeg authority request parsing', () => {
  it('accepts one bounded workspace-relative Markdown request', () => {
    expect(
      parseFfmpegRenderRequest('workspace-1', '/notes/demo.md', { fps: 30, quality: 'high' }),
    ).to.deep.equal({
      workspaceId: 'workspace-1',
      markdownPath: 'notes/demo.md',
      outputPath: 'notes/demo.mp4',
      options: { fps: 30, quality: 'high' },
    });
  });

  it('rejects traversal, absolute drive paths, unknown options, and excessive FPS', () => {
    expect(() => parseFfmpegRenderRequest('/workspace', '../secret.md', {})).to.throw();
    expect(() => parseFfmpegRenderRequest('/workspace', 'C:\\secret.md', {})).to.throw();
    expect(() => parseFfmpegRenderRequest('/workspace', 'demo.md', { output: '/tmp' })).to.throw(
      'Unknown',
    );
    expect(() => parseFfmpegRenderRequest('/workspace', 'demo.md', { fps: 121 })).to.throw(
      '1 to 120',
    );
  });
});
