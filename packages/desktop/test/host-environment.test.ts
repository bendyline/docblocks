import { expect } from 'chai';

import {
  hostEnvironmentArguments,
  parseHostEnvironmentArguments,
} from '../shared/host-environment.js';
import { isDevelopmentRuntime } from '../main/development-runtime.js';

describe('Host environment argv transport', () => {
  it('round-trips the main-owned version and dev flag', () => {
    for (const values of [
      { appVersion: '1.0.2', isDev: false },
      { appVersion: '2.4.0-beta.1+build.7', isDev: true },
    ]) {
      expect(parseHostEnvironmentArguments(hostEnvironmentArguments(values))).to.deep.equal(values);
    }
  });

  it('decodes values appended to a realistic renderer argv', () => {
    const argv = [
      'C:\\Program Files\\DocBlocks\\DocBlocks.exe',
      '--type=renderer',
      '--lang=en-US',
      ...hostEnvironmentArguments({ appVersion: '1.0.2', isDev: false }),
    ];
    expect(parseHostEnvironmentArguments(argv)).to.deep.equal({
      appVersion: '1.0.2',
      isDev: false,
    });
  });

  it('reports an unknown version rather than inventing a plausible 0.0.0', () => {
    // This string reaches users via the About surface and issue-report URLs,
    // so an absent version must look absent instead of like a real release.
    expect(parseHostEnvironmentArguments([]).appVersion).to.equal('unknown');
    expect(parseHostEnvironmentArguments(['--docblocks-app-version=']).appVersion).to.equal(
      'unknown',
    );
  });

  it('treats a missing, empty, or malformed dev switch as production', () => {
    // Fail safe: a packaged build must never be talked into development mode.
    for (const argv of [
      [],
      ['--docblocks-is-dev='],
      ['--docblocks-is-dev=0'],
      ['--docblocks-is-dev=true'],
      ['--docblocks-is-dev=yes'],
      ['--docblocks-is-dev=1x'],
    ]) {
      expect(parseHostEnvironmentArguments(argv).isDev, JSON.stringify(argv)).to.equal(false);
    }
    expect(parseHostEnvironmentArguments(['--docblocks-is-dev=1']).isDev).to.equal(true);
  });

  it('lets the appended switch win over an earlier look-alike', () => {
    // Electron appends additionalArguments, so main's stamp is always last and
    // must not be shadowed by anything inherited from the command line.
    const argv = [
      '--docblocks-app-version=99.99.99',
      '--docblocks-is-dev=1',
      ...hostEnvironmentArguments({ appVersion: '1.0.2', isDev: false }),
    ];
    expect(parseHostEnvironmentArguments(argv)).to.deep.equal({
      appVersion: '1.0.2',
      isDev: false,
    });
  });

  it('ignores unrelated argv entries that merely mention the switch names', () => {
    const argv = [
      '--docblocks-app-version-extra=7.7.7',
      '--not--docblocks-is-dev=1',
      ...hostEnvironmentArguments({ appVersion: '1.0.2', isDev: false }),
    ];
    expect(parseHostEnvironmentArguments(argv)).to.deep.equal({
      appVersion: '1.0.2',
      isDev: false,
    });
  });

  it('carries the packaged-build truth that process.env could not', () => {
    // A packaged app defines neither npm_package_version nor NODE_ENV, which
    // is precisely why these values are stamped by main instead of read from
    // the environment. isDev must follow app.isPackaged, not NODE_ENV.
    const packaged = {
      appVersion: '1.0.2',
      isDev: isDevelopmentRuntime(true, undefined),
    };
    expect(packaged.isDev).to.equal(false);
    expect(parseHostEnvironmentArguments(hostEnvironmentArguments(packaged))).to.deep.equal({
      appVersion: '1.0.2',
      isDev: false,
    });

    const sourceRun = { appVersion: '1.0.2', isDev: isDevelopmentRuntime(false, undefined) };
    expect(sourceRun.isDev).to.equal(true);
    expect(parseHostEnvironmentArguments(hostEnvironmentArguments(sourceRun)).isDev).to.equal(true);
  });
});
