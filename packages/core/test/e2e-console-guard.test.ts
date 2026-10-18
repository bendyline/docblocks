import { expect } from 'chai';
import {
  isAllowedRuntimeError,
  unexpectedRuntimeErrors,
  formatRuntimeErrors,
  SHARED_ALLOWED_RUNTIME_ERRORS,
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

  describe('shared allowances', () => {
    const releases = 'https://api.github.com/repos/bendyline/docblocks/releases?per_page=100:0:0';

    it('allow only a GitHub rate limit on the download page release lookup', () => {
      // Exact CI text: Chromium leaves the status text empty there.
      const allowed = (text: string, location = releases) =>
        isAllowedRuntimeError(consoleError(text, location), SHARED_ALLOWED_RUNTIME_ERRORS);
      const status = (code: string) =>
        `Failed to load resource: the server responded with a status of ${code}`;
      expect(allowed(status('403 ()'))).to.equal(true);
      expect(allowed(status('429 (Too Many Requests)'))).to.equal(true);
      expect(allowed(status('404 ()'))).to.equal(false);
      // The same rate limit on any other resource is still a failure.
      expect(
        allowed(status('403 ()'), 'https://api.github.com/repos/bendyline/docblocks/issues:0:0'),
      ).to.equal(false);
    });

    it("allow only harper's page-side WASM start trap on WebKit", () => {
      // Shape of WebKit's report as Playwright relays it: message, then frames.
      const trap = (variable: string, frames: readonly string[]) =>
        [
          'Unhandled Promise Rejection: RuntimeError: Unreachable code should not be executed ' +
            `(evaluating '${variable}.__wbindgen_start()')`,
          ...frames.map((frame) => `    at ${frame}`),
        ].join('\n');
      const deps = 'http://localhost:5220/node_modules/.vite/deps';
      const allowed = (text: string) =>
        isAllowedRuntimeError(
          { kind: 'pageerror', text, location: '(uncaught)' },
          SHARED_ALLOWED_RUNTIME_ERRORS,
        );

      expect(
        allowed(
          trap('wasm', [
            `wasm-function[4941] (${deps}/harper__js.js?v=1a2b3c4d:2805:24)`,
            `__wbg_finalize_init (${deps}/harper__js.js?v=1a2b3c4d:2805:24)`,
          ]),
        ),
      ).to.equal(true);
      expect(
        allowed(
          trap('wasm$1', [`__wbg_finalize_init$1 (${deps}/harper__js.js?v=1a2b3c4d:1366:26)`]),
        ),
      ).to.equal(true);
      // IronCalc's glue reports the identical text; only the frame tells them apart.
      expect(
        allowed(
          trap('wasm', [`__wbg_finalize_init (${deps}/@ironcalc_wasm.js?v=1a2b3c4d:1940:5)`]),
        ),
      ).to.equal(false);
      // Without a stack there is nothing to say whose start function trapped.
      expect(allowed(trap('wasm', []))).to.equal(false);
      // A trap while linting is not the setup failure, even inside harper.
      expect(
        allowed(
          'Unhandled Promise Rejection: RuntimeError: Unreachable code should not be executed\n' +
            `    at lint (${deps}/harper__js.js?v=1a2b3c4d:900:3)`,
        ),
      ).to.equal(false);
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
