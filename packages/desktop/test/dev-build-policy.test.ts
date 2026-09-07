import { expect } from 'chai';
import { createDevBuildPolicy } from '../scripts/dev-build-policy.js';

describe('desktop rebuild session preservation', () => {
  for (const first of ['main', 'preload'] as const) {
    it(`waits for both builds, then preserves the launched app (${first} first)`, () => {
      let launches = 0;
      let notices = 0;
      const buildCompleted = createDevBuildPolicy(
        () => {
          launches += 1;
        },
        () => {
          notices += 1;
        },
      );
      buildCompleted(first);
      buildCompleted(first);
      expect(launches).to.equal(0);
      const second = first === 'main' ? 'preload' : 'main';
      // No cleanup callback is returned for tsup to invoke on the next build.
      expect(buildCompleted(second)).to.equal(undefined);
      expect(launches).to.equal(1);
      for (const target of ['main', 'preload', 'main'] as const) {
        expect(buildCompleted(target)).to.equal(undefined);
      }
      expect(launches).to.equal(1);
      expect(notices).to.equal(3);
    });
  }
});
