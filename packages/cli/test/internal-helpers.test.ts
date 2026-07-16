import { expect } from 'chai';
import path from 'node:path';
import { throwIfAborted, cancellationError } from '../src/internal/cancellation.js';
import { positiveLimit } from '../src/internal/limits.js';
import { isNodeErrorCode } from '../src/internal/node-error.js';
import { isPathInside } from '../src/internal/paths.js';

describe('shared CLI internals', () => {
  describe('isPathInside', () => {
    const root = process.platform === 'win32' ? 'D:\\work\\docs' : '/work/docs';
    const inside = path.join(root, 'nested', 'page.md');
    const siblingPrefix = `${root}-escape`;

    it('accepts the root itself and anything below it', () => {
      expect(isPathInside(root, root)).to.equal(true);
      expect(isPathInside(root, inside)).to.equal(true);
      expect(isPathInside(root, path.join(root, '.'))).to.equal(true);
    });

    it('rejects parents, siblings, and traversal escapes', () => {
      expect(isPathInside(root, path.dirname(root))).to.equal(false);
      expect(isPathInside(root, path.join(siblingPrefix, 'secret.md'))).to.equal(false);
      expect(isPathInside(root, path.join(root, '..'))).to.equal(false);
      expect(isPathInside(root, path.join(root, '..', 'secret.md'))).to.equal(false);
    });

    it('is a path-relationship check rather than a string-prefix check', () => {
      // The single behavior every copy of this predicate had to get right.
      expect(siblingPrefix.startsWith(root)).to.equal(true);
      expect(isPathInside(root, siblingPrefix)).to.equal(false);
    });
  });

  describe('positiveLimit', () => {
    it('prefers a caller value and falls back to the default', () => {
      expect(positiveLimit(5, 100, 'build entry')).to.equal(5);
      expect(positiveLimit(undefined, 100, 'build entry')).to.equal(100);
    });

    it('rejects every non-positive-integer budget and names the limit', () => {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expect(() => positiveLimit(value, 100, 'build entry'), String(value)).to.throw(
          'Invalid build entry limit.',
        );
      }
    });
  });

  describe('isNodeErrorCode', () => {
    it('narrows on a single code or a list of codes', () => {
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
      expect(isNodeErrorCode(error, 'ENOENT')).to.equal(true);
      expect(isNodeErrorCode(error, 'EEXIST')).to.equal(false);
      expect(isNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])).to.equal(true);
      expect(isNodeErrorCode(error, ['EACCES', 'EPERM'])).to.equal(false);
    });

    it('rejects non-errors and errors without a code', () => {
      expect(isNodeErrorCode(new Error('plain'), 'ENOENT')).to.equal(false);
      expect(isNodeErrorCode({ code: 'ENOENT' }, 'ENOENT')).to.equal(false);
      expect(isNodeErrorCode(null, 'ENOENT')).to.equal(false);
      expect(isNodeErrorCode('ENOENT', 'ENOENT')).to.equal(false);
    });
  });

  describe('throwIfAborted', () => {
    it('does nothing without a signal or before an abort', () => {
      expect(() => throwIfAborted(undefined, 'cancelled')).not.to.throw();
      expect(() => throwIfAborted(new AbortController().signal, 'cancelled')).not.to.throw();
    });

    it('preserves the caller abort reason so cancellation stays attributable', () => {
      const controller = new AbortController();
      const reason = new Error('cancelled by the caller');
      controller.abort(reason);

      let caught: unknown;
      try {
        throwIfAborted(controller.signal, 'operation was cancelled');
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).to.equal(reason);
    });

    it('synthesizes a named AbortError when a signal aborts without a usable reason', () => {
      // Every caller must receive an Error, never a bare null.
      const signal = { aborted: true, reason: null } as unknown as AbortSignal;
      let caught: unknown;
      try {
        throwIfAborted(signal, 'video rendering was cancelled');
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).name).to.equal('AbortError');
      expect((caught as Error).message).to.equal('video rendering was cancelled');
    });

    it('builds a labelled AbortError', () => {
      const error = cancellationError('MCP artifact I/O was cancelled');
      expect(error.name).to.equal('AbortError');
      expect(error.message).to.equal('MCP artifact I/O was cancelled');
    });
  });
});
