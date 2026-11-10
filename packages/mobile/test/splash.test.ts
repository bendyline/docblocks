import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';
import { dismissSplash, SPLASH_ID } from '../src/splash.js';

const INDEX_HTML = path.join(process.cwd(), 'packages/mobile/index.html');

/** The splash markup exactly as index.html ships it. */
async function mountShippedSplash(): Promise<HTMLElement> {
  const html = await readFile(INDEX_HTML, 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/u)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gu, '');
  const splash = document.getElementById(SPLASH_ID);
  expect(splash, 'index.html splash').to.not.equal(null);
  return splash!;
}

function stubReducedMotion(reduce: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe('mobile launch splash', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('paints before the app root and announces that DocBlocks is opening', async () => {
    const html = await readFile(INDEX_HTML, 'utf8');
    expect(html.indexOf(`id="${SPLASH_ID}"`)).to.be.greaterThan(-1);
    expect(html.indexOf(`id="${SPLASH_ID}"`)).to.be.lessThan(html.indexOf('id="root"'));

    const splash = await mountShippedSplash();
    expect(splash.querySelector('[role="status"]')?.textContent).to.equal('Opening DocBlocks…');
    expect(splash.querySelector('svg')?.getAttribute('aria-hidden')).to.equal('true');
  });

  it('fades out, then leaves the document', async () => {
    const restore = stubReducedMotion(false);
    try {
      const splash = await mountShippedSplash();
      dismissSplash();
      expect(splash.classList.contains('db-splash--leaving')).to.equal(true);
      expect(splash.isConnected).to.equal(true);

      splash.dispatchEvent(new Event('transitionend'));
      expect(splash.isConnected).to.equal(false);
    } finally {
      restore();
    }
  });

  it('leaves at once when the user asks for reduced motion', async () => {
    const restore = stubReducedMotion(true);
    try {
      const splash = await mountShippedSplash();
      dismissSplash();
      expect(splash.isConnected).to.equal(false);
    } finally {
      restore();
    }
  });

  it('ignores repeat calls and pages without a splash', async () => {
    const restore = stubReducedMotion(false);
    try {
      const splash = await mountShippedSplash();
      dismissSplash();
      dismissSplash();
      expect(splash.classList.contains('db-splash--leaving')).to.equal(true);

      document.body.innerHTML = '';
      expect(() => dismissSplash()).to.not.throw();
    } finally {
      restore();
    }
  });
});
