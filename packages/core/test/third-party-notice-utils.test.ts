import { expect } from 'chai';
import {
  normalizeNoticeText,
  noticeTextMatches,
  retainedLicenseFiles,
  repositoryUrl,
} from '../../../scripts/third-party-notice-utils.js';

describe('third-party notice utilities', () => {
  it('normalizes embedded license line endings to LF', () => {
    expect(normalizeNoticeText('alpha\r\nbeta\rgamma\ndelta')).to.equal(
      'alpha\nbeta\ngamma\ndelta',
    );
  });

  it('compares checked-in notices independently of checkout line endings', () => {
    expect(noticeTextMatches('alpha\r\nbeta\r\n', 'alpha\nbeta\n')).to.equal(true);
    expect(noticeTextMatches('alpha\r\nbeta\r\n', 'alpha\ngamma\n')).to.equal(false);
  });

  it('uses retained license material for optional platform packages', () => {
    expect(retainedLicenseFiles('fsevents')).to.deep.equal([
      'scripts/licenses/fsevents/LICENSE-MIT.txt',
    ]);
    expect(retainedLicenseFiles('portable-package')).to.deep.equal([]);
  });

  it('uses stable npm sources for platform-constrained packages', () => {
    const name = '@napi-rs/canvas-linux-x64-gnu';
    const installedManifest = {
      repository: {
        url: 'git+https://github.com/Brooooooklyn/canvas.git',
      },
    };

    expect(repositoryUrl(installedManifest, name, true)).to.equal(
      `https://www.npmjs.com/package/${name}`,
    );
    expect(repositoryUrl(null, name, true)).to.equal(`https://www.npmjs.com/package/${name}`);
  });

  it('retains repository metadata for packages without platform constraints', () => {
    expect(
      repositoryUrl({ repository: 'git+https://github.com/example/project.git' }, 'example', false),
    ).to.equal('https://github.com/example/project');
  });
});
