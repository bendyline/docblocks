import { expect } from 'chai';
import { createServer } from 'node:net';
import { assertVscodeWebPortAvailable } from '../e2e/global-setup.js';
import { createVscodeWebE2EConfig } from '../e2e/playwright.config.js';
import { vscodeWebUrl } from '../e2e/web-test-settings.js';

describe('VS Code web E2E configuration', () => {
  it("owns the server lifecycle without Playwright's hanging webServer plugin", () => {
    const config = createVscodeWebE2EConfig(false);

    expect(config.globalSetup).to.match(/global-setup\.ts$/);
    expect(config.webServer).to.equal(undefined);
    expect(config.use?.baseURL).to.equal(vscodeWebUrl);
  });

  it('fails fast when the test server port is already occupied', async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '::1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') {
      listener.close();
      throw new Error('Expected the test listener to use a TCP port.');
    }

    let failure: unknown;
    try {
      await assertVscodeWebPortAvailable(address.port);
    } catch (error) {
      failure = error;
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.contain(
      `http://localhost:${address.port} is already used`,
    );
  });

  it('shows test progress locally while retaining the HTML report', () => {
    expect(createVscodeWebE2EConfig(false).reporter).to.deep.equal([
      ['list'],
      ['html', { open: 'never' }],
    ]);
    expect(createVscodeWebE2EConfig(true).reporter).to.equal('github');
  });
});
