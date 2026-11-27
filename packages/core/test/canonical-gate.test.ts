import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGateScripts } from '../../../scripts/canonical-gate.js';
import {
  E2E_SERVER_PORTS,
  describeBusyE2EPorts,
  gateStepEnvironment,
  isPortListening,
} from '../../../scripts/run-canonical-gate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('canonical gate E2E server ports', () => {
  it('covers every server the root E2E configs reuse off CI', () => {
    const reused = new Set<number>();
    for (const config of [
      'playwright.config.ts',
      'playwright.cross-browser.config.ts',
      'playwright.offline.config.ts',
    ]) {
      const source = readFileSync(path.join(repoRoot, config), 'utf8');
      expect(source, config).to.include('reuseExistingServer: !process.env.CI');
      for (const match of source.matchAll(/url: 'http:\/\/localhost:(\d+)'/gu)) {
        reused.add(Number(match[1]));
      }
    }
    expect([...reused].sort()).to.deep.equal(E2E_SERVER_PORTS.map(({ port }) => port).sort());
  });

  it('sees a listening server and not a closed port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      expect(await isPortListening(address.port)).to.equal(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await isPortListening(address.port)).to.equal(false);
  });

  it('names the step, each busy port, and what holds it', () => {
    const message = describeBusyE2EPorts(
      [
        {
          port: 5220,
          purpose: 'site dev server',
          listener: 'pid 38006, started Tue Nov 24 12:07:16 2026: node vite',
        },
        { port: 5230, purpose: 'offline preview server', listener: null },
      ],
      'npm run test:e2e:burn-in',
    );
    expect(message).to.include('stopped before npm run test:e2e:burn-in');
    expect(message).to.include(
      'port 5220 (site dev server): pid 38006, started Tue Nov 24 12:07:16 2026: node vite',
    );
    expect(message).to.include('port 5230 (offline preview server): something is listening');
    expect(message).to.include('Stop it, then run the gate again.');
  });
});

describe('canonical gate step environment', () => {
  it('leaves steps before the build without the prebuilt flag', () => {
    const environment = gateStepEnvironment(false, { PATH: 'bin' });
    expect(environment).to.deep.equal({ PATH: 'bin' });
  });

  it('marks steps after the build as prebuilt without touching the source', () => {
    const source = { PATH: 'bin', npm_config_global_ignore_file: 'x' };
    const environment = gateStepEnvironment(true, source);
    expect(environment).to.deep.equal({ PATH: 'bin', DOCBLOCKS_E2E_PREBUILT: '1' });
    expect(source).to.deep.equal({ PATH: 'bin', npm_config_global_ignore_file: 'x' });
  });

  it('builds before every E2E step, so each one skips its local rebuild', () => {
    const build = canonicalGateScripts.indexOf('build');
    const e2eSteps = canonicalGateScripts.filter((script) => script.startsWith('test:e2e'));
    expect(build).to.be.at.least(0);
    expect(e2eSteps).to.have.length.greaterThan(0);
    for (const step of e2eSteps) {
      expect(canonicalGateScripts.indexOf(step), step).to.be.greaterThan(build);
    }
  });
});
