import { expect } from 'chai';
import { desktopContentSecurityPolicy } from '../main/content-security-policy.js';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/u);
        return [name, sources];
      }),
  );
}

describe('desktop renderer content security policy', () => {
  it('allows object URLs only in resource directives that need them', () => {
    for (const isDevelopment of [false, true]) {
      const policy = directives(desktopContentSecurityPolicy(isDevelopment));

      expect(policy.get('media-src')).to.include.members(["'self'", 'app:', 'blob:', 'data:']);
      expect(policy.get('img-src')).to.include('blob:');
      expect(policy.get('worker-src')).to.include('blob:');
      expect(policy.get('connect-src')).to.include('blob:');
      expect(policy.get('script-src')).not.to.include('blob:');
      expect(policy.get('object-src')).to.deep.equal(["'none'"]);
      expect(policy.get('frame-src')).to.deep.equal(["'none'"]);
    }
  });

  it('limits the development media exception to the trusted Vite origin', () => {
    const production = directives(desktopContentSecurityPolicy(false));
    const development = directives(desktopContentSecurityPolicy(true));

    expect(production.get('media-src')).to.deep.equal(["'self'", 'app:', 'blob:', 'data:']);
    expect(development.get('media-src')).to.deep.equal([
      "'self'",
      'app:',
      'http://localhost:5221',
      'blob:',
      'data:',
    ]);
  });
});
