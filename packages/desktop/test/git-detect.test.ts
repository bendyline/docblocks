import { expect } from 'chai';

import { detectDarwinGit, type DarwinGitDetectionDependencies } from '../main/git/detect.js';

interface ProbeCall {
  readonly bin: string;
  readonly args: readonly string[];
}

function dependencies(
  resolvedPaths: Readonly<Record<string, string | null>>,
  probe: (bin: string, args: readonly string[]) => string | null,
  pathEnvironment = '/usr/bin:/bin',
): { value: DarwinGitDetectionDependencies; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  return {
    calls,
    value: {
      pathEnvironment,
      resolveExecutable: (candidate) => Promise.resolve(resolvedPaths[candidate] ?? null),
      probeFirstLine: (bin, args) => {
        calls.push({ bin, args });
        return Promise.resolve(probe(bin, args));
      },
    },
  };
}

describe('macOS Git detection', () => {
  it('does not execute the Apple Git shim when developer tools are absent', async () => {
    const { value, calls } = dependencies(
      {
        '/usr/bin/git': '/usr/bin/git',
      },
      (bin) => {
        expect(bin).to.equal('/usr/bin/xcode-select');
        return null;
      },
    );

    expect(await detectDarwinGit(value)).to.equal(null);
    expect(calls).to.deep.equal([{ bin: '/usr/bin/xcode-select', args: ['--print-path'] }]);
  });

  it('probes Git inside an active Command Line Tools directory, not the shim', async () => {
    const developerGit = '/Library/Developer/CommandLineTools/usr/bin/git';
    const { value, calls } = dependencies(
      {
        '/usr/bin/git': '/usr/bin/git',
        [developerGit]: developerGit,
      },
      (bin) => {
        if (bin === '/usr/bin/xcode-select') {
          return '/Library/Developer/CommandLineTools';
        }
        if (bin === developerGit) return 'git version 2.39.5 (Apple Git-154)';
        throw new Error(`Unexpected executable probe: ${bin}`);
      },
    );

    expect(await detectDarwinGit(value)).to.deep.equal({
      path: developerGit,
      version: '2.39.5',
    });
    expect(calls.map(({ bin }) => bin)).to.deep.equal(['/usr/bin/xcode-select', developerGit]);
    expect(calls.some(({ bin }) => bin === '/usr/bin/git')).to.equal(false);
  });

  it('uses a third-party Git found on PATH without consulting Apple developer tools', async () => {
    const thirdPartyGit = '/opt/local/bin/git';
    const { value, calls } = dependencies(
      {
        [thirdPartyGit]: thirdPartyGit,
      },
      (bin) => {
        if (bin === thirdPartyGit) return 'git version 2.47.1';
        throw new Error(`Unexpected executable probe: ${bin}`);
      },
      '/opt/local/bin:/usr/bin',
    );

    expect(await detectDarwinGit(value)).to.deep.equal({
      path: thirdPartyGit,
      version: '2.47.1',
    });
    expect(calls).to.deep.equal([{ bin: thirdPartyGit, args: ['--version'] }]);
  });
});
