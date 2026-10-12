import { expect } from 'chai';
import { desktopRendererResponseHeaders } from '../main/renderer-response-headers.js';

const CSP = "default-src 'self'; frame-src https://www.youtube-nocookie.com";
const DEVELOPMENT_ORIGIN = 'http://localhost:5221';

describe('desktop renderer response headers', () => {
  it('applies CSP and same-origin CORP to the packaged renderer document', () => {
    const headers = desktopRendererResponseHeaders(
      {
        url: 'app://docblocks/index.html',
        resourceType: 'mainFrame',
        responseHeaders: { 'Content-Type': ['text/html'] },
      },
      CSP,
    );

    expect(headers).to.deep.equal({
      'Content-Type': ['text/html'],
      'Cross-Origin-Resource-Policy': ['same-origin'],
      'Content-Security-Policy': [CSP],
    });
  });

  it('applies those headers to the trusted development renderer document', () => {
    const headers = desktopRendererResponseHeaders(
      {
        url: `${DEVELOPMENT_ORIGIN}/`,
        resourceType: 'mainFrame',
      },
      CSP,
      DEVELOPMENT_ORIGIN,
    );

    expect(headers?.['Content-Security-Policy']).to.deep.equal([CSP]);
    expect(headers?.['Cross-Origin-Resource-Policy']).to.deep.equal(['same-origin']);
  });

  it('replaces owned headers without enabling cross-origin isolation', () => {
    const headers = desktopRendererResponseHeaders(
      {
        url: 'app://docblocks/index.html',
        resourceType: 'mainFrame',
        responseHeaders: {
          'content-security-policy': ["default-src 'none'; frame-src 'none'"],
          'cross-origin-resource-policy': ['cross-origin'],
          'cross-origin-opener-policy': ['same-origin'],
          'Cross-Origin-Embedder-Policy': ['credentialless'],
        },
      },
      CSP,
    );

    expect(headers).not.to.have.property('cross-origin-opener-policy');
    expect(headers).not.to.have.property('Cross-Origin-Opener-Policy');
    expect(headers).not.to.have.property('Cross-Origin-Embedder-Policy');
    expect(headers).not.to.have.property('content-security-policy');
    expect(headers).not.to.have.property('cross-origin-resource-policy');
    expect(headers?.['Content-Security-Policy']).to.deep.equal([CSP]);
    expect(headers?.['Cross-Origin-Resource-Policy']).to.deep.equal(['same-origin']);
  });

  it('leaves hosted-video frame responses untouched', () => {
    const headers = desktopRendererResponseHeaders(
      {
        url: 'https://www.youtube-nocookie.com/embed/gus8wVPU5lo',
        resourceType: 'subFrame',
        responseHeaders: { 'Content-Type': ['text/html'] },
      },
      CSP,
      DEVELOPMENT_ORIGIN,
    );

    expect(headers).to.equal(null);
  });

  it('leaves untrusted top-level responses untouched', () => {
    const headers = desktopRendererResponseHeaders(
      {
        url: 'https://www.youtube-nocookie.com/embed/gus8wVPU5lo',
        resourceType: 'mainFrame',
      },
      CSP,
      DEVELOPMENT_ORIGIN,
    );

    expect(headers).to.equal(null);
  });
});
