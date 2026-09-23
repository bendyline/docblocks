import { expect } from 'chai';
import {
  COOLDOWN_EXCLUSIONS,
  validateDependencyToolchain,
  validateInstallScriptPolicy,
} from '../../../scripts/check-dependency-governance.js';

describe('dependency governance', () => {
  it('requires exact approval coverage for every lockfile install script', () => {
    const result = validateInstallScriptPolicy(
      {
        allowScripts: {
          '@scope/native@1.2.3': true,
          'builder@2.0.0 || 2.1.0': true,
        },
      },
      {
        packages: {
          'node_modules/@scope/native': { hasInstallScript: true, version: '1.2.3' },
          'node_modules/builder': { hasInstallScript: true, version: '2.0.0' },
          'node_modules/tool/node_modules/builder': {
            hasInstallScript: true,
            version: '2.1.0',
          },
          'node_modules/no-script': { version: '3.0.0' },
        },
      },
    );

    expect(result.lockedSpecs).to.deep.equal([
      '@scope/native@1.2.3',
      'builder@2.0.0',
      'builder@2.1.0',
    ]);
    expect(result.approvedSpecs).to.deep.equal(result.lockedSpecs);
  });

  it('rejects unpinned, missing, and stale approvals', () => {
    const packageLock = {
      packages: {
        'node_modules/native': { hasInstallScript: true, version: '1.0.0' },
      },
    } as const;

    expect(() =>
      validateInstallScriptPolicy({ allowScripts: { native: true } }, packageLock),
    ).to.throw('must use exact versions');
    expect(() =>
      validateInstallScriptPolicy({ allowScripts: { 'other@1.0.0': true } }, packageLock),
    ).to.throw('is stale or absent');
    expect(() =>
      validateInstallScriptPolicy({ allowScripts: { 'native@2.0.0': true } }, packageLock),
    ).to.throw('is stale or absent');
  });

  it('pins the npm feature floor and the first-party cooldown exceptions', () => {
    const manifest = {
      devDependencies: { npm: '11.19.1' },
      engines: { npm: '>=11.19.1' },
      packageManager: 'npm@11.19.1',
    } as const;
    const exclusions = COOLDOWN_EXCLUSIONS.map((pattern) => `min-release-age-exclude[]=${pattern}`);
    const npmrc = [
      'workspaces-update=false',
      'save-exact=true',
      'strict-allow-scripts=true',
      'min-release-age=7',
      ...exclusions,
      '',
    ].join('\n');

    expect(COOLDOWN_EXCLUSIONS).to.deep.equal([
      '@bendyline/squisq*',
      '@bendyline/gezel*',
      '@bendyline/gezk',
    ]);
    expect(() => validateDependencyToolchain(manifest, npmrc)).not.to.throw();

    // A further family is a policy change, not a config edit: it must fail
    // until the checker, AGENTS.md and the governance doc move together.
    expect(() =>
      validateDependencyToolchain(
        manifest,
        `${npmrc}min-release-age-exclude[]=@bendyline/docblocks*\n`,
      ),
    ).to.throw(
      'min-release-age-exclude[] must be @bendyline/squisq*, @bendyline/gezel*, @bendyline/gezk',
    );

    // Dropping gezk looks harmless because the Gezel pattern reads as if it
    // covers the family, but it does not match gezk, which the client needs.
    const withoutGezk = npmrc.replace('min-release-age-exclude[]=@bendyline/gezk\n', '');
    expect(() => validateDependencyToolchain(manifest, withoutGezk)).to.throw(
      'min-release-age-exclude[] must be',
    );

    expect(() =>
      validateDependencyToolchain({ ...manifest, devDependencies: { npm: '11.18.0' } }, npmrc),
    ).to.throw('devDependencies.npm must pin npm@11.19.1');
  });
});
