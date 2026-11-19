import { expect } from 'chai';
import { installNativePrint, printJobName, standalonePage, type NativePrinter } from '../src/print';

const POLICY = "default-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data:";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('mobile print', () => {
  const originalPrint = window.print;
  let policy: HTMLMetaElement;
  beforeEach(() => {
    policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = POLICY;
    document.head.append(policy);
  });
  afterEach(() => {
    window.print = originalPrint;
    policy.remove();
    document.body.replaceChildren();
    document.title = '';
  });

  describe('printJobName', () => {
    it('keeps a document title that can name a staged file', () => {
      expect(printJobName('  Trip   notes ')).to.equal('Trip notes');
      expect(printJobName('Q3: plan/review\u0007')).to.equal('Q3 plan review');
    });

    it('falls back when nothing usable is left', () => {
      expect(printJobName('')).to.equal('DocBlocks');
      expect(printJobName(' / : ')).to.equal('DocBlocks');
      expect(printJobName('..')).to.equal('DocBlocks');
      expect(printJobName('x'.repeat(300))).to.have.length(120);
    });
  });

  describe('standalonePage', () => {
    it("inlines blob: pictures and leads with the app's policy", async () => {
      const page = parse(
        '<!DOCTYPE html><html><head><title>Doc</title></head><body>' +
          '<img src="blob:capacitor://localhost/one">' +
          '<img srcset="blob:capacitor://localhost/one 1x, blob:capacitor://localhost/two 2x">' +
          '<div style="background-image: url(&quot;blob:capacitor://localhost/two&quot;)"></div>' +
          '<img src="https://example.invalid/kept.png">' +
          '</body></html>',
      );
      const read: string[] = [];
      const html = await standalonePage(page, document, async (url) => {
        read.push(url);
        return `data:image/png;base64,${url.endsWith('one') ? 'T05F' : 'VFdP'}`;
      });

      expect(read).to.have.members([
        'blob:capacitor://localhost/one',
        'blob:capacitor://localhost/two',
      ]);
      // The copied policy names blob: as a source; no picture URL is left.
      expect(html).not.to.contain('blob:capacitor:');
      expect(
        html.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"'),
      ).to.equal(true);

      const printed = parse(html);
      expect(printed.querySelector('meta')?.getAttribute('content')).to.equal(POLICY);
      const images = printed.querySelectorAll('img');
      expect(images[0].getAttribute('src')).to.equal('data:image/png;base64,T05F');
      expect(images[1].getAttribute('srcset')).to.equal(
        'data:image/png;base64,T05F 1x, data:image/png;base64,VFdP 2x',
      );
      expect(images[2].getAttribute('src')).to.equal('https://example.invalid/kept.png');
      expect(printed.querySelector('div')?.getAttribute('style')).to.contain(
        'data:image/png;base64,VFdP',
      );
    });

    it('keeps a picture it cannot read rather than failing the print', async () => {
      const page = parse(
        '<html><head></head><body><img src="blob:capacitor://localhost/gone"></body></html>',
      );
      const html = await standalonePage(page, document, async () => {
        throw new Error('revoked');
      });
      expect(parse(html).querySelector('img')?.getAttribute('src')).to.equal(
        'blob:capacitor://localhost/gone',
      );
    });
  });

  describe('installNativePrint', () => {
    function recorder() {
      const calls: string[] = [];
      const page = deferred();
      const printer: NativePrinter = {
        printPage: async (jobName) => {
          calls.push(`page:${jobName}`);
          await page.promise;
        },
        printDocument: async (jobName, html) => {
          calls.push(`document:${jobName}:${html.includes('Frame body')}`);
        },
      };
      return { calls, page, printer };
    }

    it('prints the page through native, inside beforeprint and afterprint', async () => {
      const { calls, page, printer } = recorder();
      const reported: unknown[] = [];
      installNativePrint(printer, (error) => reported.push(error));
      const before = () => calls.push('beforeprint');
      const after = () => calls.push('afterprint');
      window.addEventListener('beforeprint', before);
      window.addEventListener('afterprint', after);
      try {
        document.title = 'Slides';
        window.print();
        // The dialog is modal: printing again while it is up does nothing.
        window.print();
        await settle();
        expect(calls).to.deep.equal(['beforeprint', 'page:Slides']);

        page.resolve();
        await settle();
        expect(calls).to.deep.equal(['beforeprint', 'page:Slides', 'afterprint']);
        expect(reported).to.deep.equal([]);
      } finally {
        window.removeEventListener('beforeprint', before);
        window.removeEventListener('afterprint', after);
      }
    });

    it('reports a failed print and still ends it', async () => {
      const failure = new Error('The print dialog could not be opened.');
      const reported: unknown[] = [];
      let ended = 0;
      const after = () => ended++;
      installNativePrint(
        {
          printPage: async () => {
            throw failure;
          },
          printDocument: async () => undefined,
        },
        (error) => reported.push(error),
      );
      window.addEventListener('afterprint', after);
      try {
        window.print();
        await settle();
        expect(reported).to.deep.equal([failure]);
        expect(ended).to.equal(1);
      } finally {
        window.removeEventListener('afterprint', after);
      }
    });

    it("prints a same-origin frame's document as a page of its own", async () => {
      const { calls, printer } = recorder();
      installNativePrint(printer, () => undefined);
      const frame = document.createElement('iframe');
      frame.srcdoc =
        '<!DOCTYPE html><html><head><title>Trip notes</title></head><body>Frame body</body></html>';
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve));
      document.body.append(frame);
      await loaded;

      frame.contentWindow!.print();
      await settle();
      expect(calls).to.deep.equal(['document:Trip notes:true']);
    });
  });
});
