import { expect } from 'chai';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { isAllowedPreviewRequestAuthority, startPreviewServer } from '../src/commands/serve.js';

describe('CLI preview server Host authority', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-serve-authority-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('loopback binds treat loopback aliases as interchangeable', () => {
    it('accepts localhost, 127.0.0.0/8, and ::1 against a 127.0.0.1 bind', () => {
      for (const host of ['localhost:3000', '127.0.0.1:3000', '127.0.0.2:3000', '[::1]:3000']) {
        expect(isAllowedPreviewRequestAuthority(host, '127.0.0.1', 3000), host).to.equal(true);
      }
    });

    it('accepts loopback aliases against a localhost or ::1 bind', () => {
      expect(isAllowedPreviewRequestAuthority('127.0.0.1:3000', 'localhost', 3000)).to.equal(true);
      expect(isAllowedPreviewRequestAuthority('localhost:3000', '::1', 3000)).to.equal(true);
    });

    it('still refuses a rebindable name that merely resolves to loopback', () => {
      // The whole point of the check: a name an attacker controls in DNS must
      // never be answered to, however it happens to resolve today.
      for (const host of [
        'localtest.me:3000',
        'evil.example:3000',
        '127.0.0.1.attacker.invalid:3000',
        'localhost.attacker.invalid:3000',
      ]) {
        expect(isAllowedPreviewRequestAuthority(host, '127.0.0.1', 3000), host).to.equal(false);
      }
    });

    it('keeps enforcing the port', () => {
      expect(isAllowedPreviewRequestAuthority('localhost:3001', '127.0.0.1', 3000)).to.equal(false);
    });
  });

  describe('wildcard binds accept IP literals but never a bare name', () => {
    it('accepts either address family and loopback aliases', () => {
      for (const host of ['192.168.1.5:3000', '[2001:db8::1]:3000', 'localhost:3000']) {
        expect(isAllowedPreviewRequestAuthority(host, '0.0.0.0', 3000), host).to.equal(true);
      }
      expect(isAllowedPreviewRequestAuthority('127.0.0.1:3000', '::', 3000)).to.equal(true);
    });

    it('refuses DNS names, which are the only rebindable authority', () => {
      expect(isAllowedPreviewRequestAuthority('evil.example:3000', '0.0.0.0', 3000)).to.equal(
        false,
      );
      expect(isAllowedPreviewRequestAuthority('my-laptop.lan:3000', '::', 3000)).to.equal(false);
    });
  });

  describe('--allow-host grants a specific name', () => {
    it('accepts only the explicitly granted name', () => {
      const allowed = ['my-laptop.lan'];
      expect(
        isAllowedPreviewRequestAuthority('my-laptop.lan:3000', '0.0.0.0', 3000, allowed),
      ).to.equal(true);
      expect(
        isAllowedPreviewRequestAuthority('evil.example:3000', '0.0.0.0', 3000, allowed),
      ).to.equal(false);
      // A granted name does not become a wildcard for its subdomains.
      expect(
        isAllowedPreviewRequestAuthority('a.my-laptop.lan:3000', '0.0.0.0', 3000, allowed),
      ).to.equal(false);
    });

    it('still enforces the port for a granted name', () => {
      expect(
        isAllowedPreviewRequestAuthority('my-laptop.lan:3001', '0.0.0.0', 3000, ['my-laptop.lan']),
      ).to.equal(false);
    });
  });

  describe('a specific non-loopback bind answers only to itself', () => {
    it('accepts the configured host and refuses everything else', () => {
      expect(isAllowedPreviewRequestAuthority('192.168.1.5:3000', '192.168.1.5', 3000)).to.equal(
        true,
      );
      expect(isAllowedPreviewRequestAuthority('192.168.1.6:3000', '192.168.1.5', 3000)).to.equal(
        false,
      );
      expect(isAllowedPreviewRequestAuthority('evil.example:3000', '192.168.1.5', 3000)).to.equal(
        false,
      );
    });
  });

  it('serves a request that arrives as localhost against the default bind', async () => {
    await writeFile(path.join(tempRoot, 'index.md'), '# Preview', 'utf-8');
    const preview = await startPreviewServer({ dir: tempRoot, port: 0 });
    try {
      const port = Number(new URL(preview.url).port);
      const response = await requestPreview(
        `http://127.0.0.1:${port}/index.md`,
        'GET',
        `localhost:${port}`,
      );
      expect(response.status).to.equal(200);
      expect(response.body.toString('utf8')).to.contain('Preview');
    } finally {
      await closeServer(preview.server);
    }
  });

  it('validates --allow-host values and bounds their number', async () => {
    await mkdir(path.join(tempRoot, 'docs'), { recursive: true });
    const dir = path.join(tempRoot, 'docs');

    const invalid = await captureFailure(
      startPreviewServer({ dir, port: 0, allowedHosts: ['not a host'] }),
    );
    expect(invalid).to.be.instanceOf(Error);
    expect((invalid as Error).message).to.contain('Invalid host');

    const tooMany = await captureFailure(
      startPreviewServer({
        dir,
        port: 0,
        allowedHosts: Array.from({ length: 33 }, (_unused, index) => `host-${index}.lan`),
      }),
    );
    expect(tooMany).to.be.instanceOf(Error);
    expect((tooMany as Error).message).to.contain('--allow-host');
  });

  it('reports the cause of a failed preview request on stderr', async () => {
    // Malformed UTF-8 fails inside the render path, after the target resolves:
    // exactly the class of failure that previously produced a bare "Internal
    // server error" in the browser and nothing at all in the terminal.
    await writeFile(path.join(tempRoot, 'index.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0xff]));
    const failures: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      failures.push(args.map((arg) => String(arg)).join(' '));
    };

    let preview: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
    try {
      preview = await startPreviewServer({ dir: tempRoot, port: 0 });
      const response = await requestPreview(`${preview.url}index.md`);
      expect(response.status).to.equal(500);
      expect(response.body.toString('utf8')).to.contain('Internal server error');
    } finally {
      console.error = originalError;
      if (preview) await closeServer(preview.server);
    }

    const logged = failures.join('\n');
    expect(logged, 'the cause must reach stderr').to.contain('preview request failed');
    expect(logged).to.contain('GET /index.md');
    // Not just that something failed — the diagnosable cause itself.
    expect(logged).to.match(/UTF-8|Preview document/iu);
  });
});

function requestPreview(
  url: string,
  method = 'GET',
  hostHeader?: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method, headers: hostHeader ? { host: hostHeader } : undefined },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function closeServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error: unknown) {
    return error;
  }
}
