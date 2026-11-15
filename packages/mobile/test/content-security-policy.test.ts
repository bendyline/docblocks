import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';

const ONLINE_VIDEO_FRAME_SOURCES = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.loom.com',
  'https://fast.wistia.net',
];

function parseContentSecurityPolicy(html: string): Map<string, string[]> {
  const policy = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u,
  )?.[1];
  expect(policy, 'Content-Security-Policy meta content').to.be.a('string');
  return new Map(
    (policy ?? '')
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/u);
        return [name, sources];
      }),
  );
}

describe('mobile content security policy', () => {
  it('allows supported online video players without removing Blob frames', async () => {
    const html = await readFile(path.join(process.cwd(), 'packages/mobile/index.html'), 'utf8');
    const directives = parseContentSecurityPolicy(html);

    expect(directives.get('frame-src')).to.deep.equal(['blob:', ...ONLINE_VIDEO_FRAME_SOURCES]);
  });

  // Attached and recorded media reach the WebView as object URLs, and video,
  // audio, and media-edit exports read those URLs back with fetch(). WebKit
  // rejects a fetch the policy does not cover with a bare "Load failed".
  it('lets fetch() read back Blob and data URLs', async () => {
    const html = await readFile(path.join(process.cwd(), 'packages/mobile/index.html'), 'utf8');
    const directives = parseContentSecurityPolicy(html);

    expect(directives.get('connect-src')).to.include.members(['blob:', 'data:']);
  });
});
