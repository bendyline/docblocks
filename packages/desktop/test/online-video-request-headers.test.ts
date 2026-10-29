import { expect } from 'chai';
import {
  DESKTOP_APP_REFERRER,
  onlineVideoRequestHeaders,
} from '../main/online-video-request-headers.js';

const EMBED = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0';

describe('online video request headers', () => {
  it('identifies the app on a YouTube player frame sent without a Referer', () => {
    const headers = onlineVideoRequestHeaders({
      url: EMBED,
      resourceType: 'subFrame',
      requestHeaders: { Accept: 'text/html' },
    });

    expect(headers).to.deep.equal({ Accept: 'text/html', Referer: DESKTOP_APP_REFERRER });
  });

  it('covers the youtube.com embed host too', () => {
    const headers = onlineVideoRequestHeaders({
      url: 'https://www.youtube.com/embed/videoseries?list=PL123',
      resourceType: 'subFrame',
      requestHeaders: {},
    });

    expect(headers?.Referer).to.equal(DESKTOP_APP_REFERRER);
  });

  it('keeps a Referer the renderer already sent', () => {
    expect(
      onlineVideoRequestHeaders({
        url: EMBED,
        resourceType: 'subFrame',
        requestHeaders: { referer: 'http://localhost:5221/' },
      }),
    ).to.equal(null);
  });

  it('leaves other requests alone', () => {
    const cases = [
      { url: EMBED, resourceType: 'script' },
      { url: 'https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ', resourceType: 'subFrame' },
      { url: 'https://player.vimeo.com/video/76979871', resourceType: 'subFrame' },
      { url: 'https://evil.example/embed/www.youtube.com', resourceType: 'subFrame' },
      { url: 'not a url', resourceType: 'subFrame' },
    ] as const;

    for (const { url, resourceType } of cases) {
      expect(onlineVideoRequestHeaders({ url, resourceType, requestHeaders: {} }), url).to.equal(
        null,
      );
    }
  });
});
