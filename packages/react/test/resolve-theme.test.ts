/**
 * Tests for resolveShellTheme (SF-13).
 *
 * The shipped bug: `<DocBlocksShell theme="dark">` was destructured into
 * `_themeProp` and never read, so a host asking for dark silently got
 * whatever the OS wanted — while the props doc and the site README both
 * advertised the override. These pin the precedence chain:
 *
 *     user's Settings choice  >  host's `theme` prop  >  OS
 */
import { expect } from 'chai';
import { resolveShellTheme } from '../src/DocBlocksShell/resolve-theme.js';

describe('resolveShellTheme', () => {
  describe('the host prop is honoured', () => {
    it('uses an explicit host theme over the OS', () => {
      // The actual SF-13 regression: this returned 'light' (the OS) before.
      expect(
        resolveShellTheme({ preference: 'auto', hostTheme: 'dark', osTheme: 'light' }),
      ).to.equal('dark');
      expect(
        resolveShellTheme({ preference: 'auto', hostTheme: 'light', osTheme: 'dark' }),
      ).to.equal('light');
    });
  });

  describe("the user's choice outranks the host", () => {
    it('prefers the Settings choice over an opposing host theme', () => {
      expect(
        resolveShellTheme({ preference: 'light', hostTheme: 'dark', osTheme: 'dark' }),
      ).to.equal('light');
      expect(
        resolveShellTheme({ preference: 'dark', hostTheme: 'light', osTheme: 'light' }),
      ).to.equal('dark');
    });

    it('prefers the Settings choice over the OS when there is no host theme', () => {
      expect(resolveShellTheme({ preference: 'dark', osTheme: 'light' })).to.equal('dark');
      expect(resolveShellTheme({ preference: 'light', osTheme: 'dark' })).to.equal('light');
    });
  });

  describe('falls through to the OS', () => {
    it('follows the OS when nobody else has an opinion', () => {
      expect(
        resolveShellTheme({ preference: 'auto', hostTheme: 'auto', osTheme: 'dark' }),
      ).to.equal('dark');
      expect(
        resolveShellTheme({ preference: 'auto', hostTheme: 'auto', osTheme: 'light' }),
      ).to.equal('light');
    });

    it('follows the OS when the host prop is omitted entirely', () => {
      expect(resolveShellTheme({ preference: 'auto', osTheme: 'dark' })).to.equal('dark');
    });

    it("treats the host's 'auto' the same as omitting it", () => {
      expect(
        resolveShellTheme({ preference: 'auto', hostTheme: 'auto', osTheme: 'dark' }),
      ).to.equal(resolveShellTheme({ preference: 'auto', osTheme: 'dark' }));
    });
  });
});
