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

  it('treats an exact-version denial as reviewed, and pins it like an approval', () => {
    const packageLock = {
      packages: {
        'node_modules/runtime': { hasInstallScript: true, version: '1.24.3' },
      },
    } as const;
    expect(
      validateInstallScriptPolicy({ allowScripts: { 'runtime@1.24.3': false } }, packageLock)
        .approvedSpecs,
    ).to.deep.equal(['runtime@1.24.3']);
    expect(() =>
      validateInstallScriptPolicy({ allowScripts: { 'runtime@1.24.2': false } }, packageLock),
    ).to.throw('is stale or absent');
    expect(() =>
      validateInstallScriptPolicy(
        { allowScripts: { 'runtime@1.24.3': 'no' as unknown as boolean } },
        packageLock,
      ),
    ).to.throw('must be true, false, or be removed');
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

    expect(COOLDOWN_EXCLUSIONS).to.deep.equal(['@bendyline/*']);
    expect(() => validateDependencyToolchain(manifest, npmrc)).not.to.throw();

    // Exempting a third-party package is a policy change, not a config edit:
    // it must fail until the checker, AGENTS.md and the governance doc move
    // together.
    expect(() =>
      validateDependencyToolchain(manifest, `${npmrc}min-release-age-exclude[]=undici\n`),
    ).to.throw('min-release-age-exclude[] must be @bendyline/*');

    // Dropping the exemption is equally a policy change.
    const withoutExemption = npmrc.replace('min-release-age-exclude[]=@bendyline/*\n', '');
    expect(() => validateDependencyToolchain(manifest, withoutExemption)).to.throw(
      'min-release-age-exclude[] must be',
    );

    expect(() =>
      validateDependencyToolchain({ ...manifest, devDependencies: { npm: '11.18.0' } }, npmrc),
    ).to.throw('devDependencies.npm must pin npm@11.19.1');
  });
});
