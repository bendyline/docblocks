import { expect } from 'chai';
import {
  isAllowedRuntimeError,
  unexpectedRuntimeErrors,
  formatRuntimeErrors,
  type AllowedRuntimeError,
  type RuntimeError,
} from '../../../e2e/helpers/console-guard.js';

/**
 * The E2E runtime-error guard decides which console errors fail a browser test,
 * so its matching rules are the part of the suite most able to hide a defect by
 * accident. They are pure, and tested here rather than by observing a browser.
 *
 * The rule that matters: an allowance narrows as it gains patterns. A resource
 * failure reports a generic text and names the resource only in its location,
 * so a text-only allowance for "Failed to load resource" would wave through
 * every missing asset on the page.
 */

function consoleError(text: string, location = 'https://example.test/app.js:1:1'): RuntimeError {
  return { kind: 'console.error', text, location };
}

describe('E2E runtime-error guard', () => {
  describe('matching an allowance', () => {
    it('allows a message whose text matches', () => {
      const allowed: AllowedRuntimeError[] = [{ reason: 'known', match: /deliberate failure/u }];
      expect(isAllowedRuntimeError(consoleError('a deliberate failure'), allowed)).to.equal(true);
      expect(isAllowedRuntimeError(consoleError('an unrelated failure'), allowed)).to.equal(false);
    });

    it('allows a message whose location matches', () => {
      const allowed: AllowedRuntimeError[] = [
        { reason: 'third party', location: /third-party\.example/u },
      ];
      expect(
        isAllowedRuntimeError(
          consoleError('boom', 'https://third-party.example/x.js:1:1'),
          allowed,
        ),
      ).to.equal(true);
      expect(
        isAllowedRuntimeError(consoleError('boom', 'https://docblocks.test/x.js:1:1'), allowed),
      ).to.equal(false);
    });

    it('requires every declared pattern to match, so a pair narrows', () => {
      const allowed: AllowedRuntimeError[] = [
        {
          reason: 'the harness probes for a bundle we do not ship',
          match: /Failed to load resource/u,
          location: /package\.nls\.json/u,
        },
      ];
      expect(
        isAllowedRuntimeError(
          consoleError('Failed to load resource: 404', 'https://host/package.nls.json:0:0'),
          allowed,
        ),
      ).to.equal(true);
      // Same generic text, a different resource: this is the regression the
      // location pattern exists to prevent.
      expect(
        isAllowedRuntimeError(
          consoleError('Failed to load resource: 404', 'https://host/assets/editor.js:0:0'),
          allowed,
        ),
      ).to.equal(false);
    });

    it('treats an allowance with no pattern as matching nothing', () => {
      const allowed = [{ reason: 'malformed' }] as unknown as AllowedRuntimeError[];
      expect(isAllowedRuntimeError(consoleError('anything at all'), allowed)).to.equal(false);
    });
  });

  describe('filtering a run', () => {
    it('returns only the errors no allowance covers', () => {
      const errors = [
        consoleError('Failed to load resource: 404', 'https://host/package.nls.json:0:0'),
        consoleError('TypeError: undefined is not a function'),
      ];
      const unexpected = unexpectedRuntimeErrors(errors, [
        { reason: 'harness', match: /Failed to load resource/u, location: /package\.nls\.json/u },
      ]);
      expect(unexpected).to.have.lengthOf(1);
      expect(unexpected[0]?.text).to.contain('TypeError');
    });

    it('reports nothing when every error is allowed', () => {
      expect(
        unexpectedRuntimeErrors([consoleError('known noise')], [{ reason: 'x', match: /known/u }]),
      ).to.deep.equal([]);
    });
  });

  describe('the failure message', () => {
    it('names each error, its kind, and where it came from', () => {
      const message = formatRuntimeErrors([
        consoleError('TypeError: x is not a function', 'https://host/a.js:3:4'),
      ]);
      expect(message).to.contain('1 runtime error');
      expect(message).to.contain('[console.error]');
      expect(message).to.contain('TypeError: x is not a function');
      expect(message).to.contain('https://host/a.js:3:4');
      // The message has to say what to do next, since the reader is looking at
      // a test that failed without an assertion of its own.
      expect(message).to.contain('console-guard.ts');
    });

    it('keeps a multi-line stack to one line per error', () => {
      const message = formatRuntimeErrors([
        { kind: 'pageerror', text: 'Error: boom\n  at a()\n  at b()', location: '(uncaught)' },
      ]);
      expect(message).to.contain('Error: boom');
      expect(message).to.not.contain('at a()');
    });
  });
});
