import { expect } from 'chai';
import { canonicalGateScripts } from '../../../scripts/canonical-gate.js';
import { gateStepEnvironment } from '../../../scripts/run-canonical-gate.js';

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
