import { expect } from 'chai';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectedVsixReadmeBaseUrls,
  findVsixReadmeLinkProblems,
  relativeReadmeTargets,
  vscePackageBaseUrls,
} from '../../../scripts/check-vscode-package-contents.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  repository: unknown;
  scripts: Record<string, string>;
};
const readme = readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
const expected = {
  content: 'https://github.com/bendyline/docblocks/blob/HEAD/packages/vscode',
  images: 'https://github.com/bendyline/docblocks/raw/HEAD/packages/vscode',
};
const onDisk = (file: string) => {
  try {
    return statSync(path.join(packageRoot, ...file.split('/'))).isFile();
  } catch {
    return false;
  }
};

describe('VSIX readme links', () => {
  it('derives the base URLs from repository.url and repository.directory', () => {
    expect(expectedVsixReadmeBaseUrls(manifest.repository)).to.deep.equal(expected);
    expect(
      expectedVsixReadmeBaseUrls({
        url: 'git+https://github.com/owner/repo.git',
        directory: './packages/ext/',
      }),
    ).to.deep.equal({
      content: 'https://github.com/owner/repo/blob/HEAD/packages/ext',
      images: 'https://github.com/owner/repo/raw/HEAD/packages/ext',
    });
    expect(() => expectedVsixReadmeBaseUrls({ url: 'https://github.com/o/r.git' })).to.throw(
      /repository\.directory/,
    );
    expect(() =>
      expectedVsixReadmeBaseUrls({ url: 'https://github.com/o/r.git', directory: '../elsewhere' }),
    ).to.throw(/inside the repository/);
  });

  it('holds the real package:vsix script and README to the manifest', () => {
    expect(
      findVsixReadmeLinkProblems({
        readme,
        packageScript: manifest.scripts['package:vsix'],
        expected: expectedVsixReadmeBaseUrls(manifest.repository),
        fileExists: onDisk,
      }),
    ).to.deep.equal([]);
    // The screenshots are what 2.7.14 shipped broken; keep them covered.
    expect(relativeReadmeTargets(readme).filter((link) => link.image).length).to.be.greaterThan(0);
  });

  it('reports a vsce package command that leaves the base URLs to vsce (the 2.7.14 VSIX)', () => {
    const problems = findVsixReadmeLinkProblems({
      readme: '![Write](resources/marketplace/01-write.png)',
      packageScript:
        'npm run build && npm run check:package-contents && vsce package --no-dependencies',
      expected,
      fileExists: () => true,
    });
    expect(problems).to.have.length(2);
    expect(problems[0]).to.contain(`--baseContentUrl ${expected.content}`);
    expect(problems[1]).to.contain(`--baseImagesUrl ${expected.images}`);
  });

  it('reports base URLs that point at the repository root', () => {
    const problems = findVsixReadmeLinkProblems({
      readme: '',
      packageScript:
        'vsce package --baseContentUrl https://github.com/bendyline/docblocks/blob/HEAD ' +
        `--baseImagesUrl=${expected.images}`,
      expected,
      fileExists: () => true,
    });
    expect(problems).to.have.length(1);
    expect(problems[0]).to.contain('found https://github.com/bendyline/docblocks/blob/HEAD)');
  });

  it('reports a script that no longer packages with vsce', () => {
    expect(
      findVsixReadmeLinkProblems({
        readme: '',
        packageScript: 'npm run build',
        expected,
        fileExists: () => true,
      }),
    ).to.deep.equal(['package:vsix does not run `vsce package`.']);
  });

  it('reports relative targets that are missing or leave the package', () => {
    const problems = findVsixReadmeLinkProblems({
      readme: [
        '![Shot](resources/missing.png)',
        '[License](LICENSE.txt#mit "the license")',
        '[Outside](../../README.md)',
        '<img src="resources/also-missing.png" alt="">',
      ].join('\n'),
      packageScript: `vsce package --baseContentUrl ${expected.content} --baseImagesUrl "${expected.images}"`,
      expected,
      fileExists: (file) => file === 'LICENSE.txt',
    });
    expect(problems).to.deep.equal([
      'README.md image resources/missing.png is not a file in packages/vscode.',
      'README.md link ../../README.md leaves packages/vscode.',
      'README.md image resources/also-missing.png is not a file in packages/vscode.',
    ]);
  });

  it('finds the targets vsce rewrites and skips the ones it leaves alone', () => {
    const targets = relativeReadmeTargets(
      [
        '[![Badge](images/badge.svg)](docs/guide.md)',
        '![Remote](https://example.com/a.png)',
        '[Anchor](#settings) [Mail](mailto:support@example.com)',
        '<video src="media/demo.mp4"></video>',
      ].join('\n'),
    );
    expect(targets).to.deep.equal([
      { target: 'images/badge.svg', image: true },
      { target: 'docs/guide.md', image: false },
      { target: 'media/demo.mp4', image: true },
    ]);
  });

  it('reads both spellings of the vsce base URL options', () => {
    expect(
      vscePackageBaseUrls('vsce package --baseContentUrl a --baseImagesUrl=b 2.7.14'),
    ).to.deep.equal({ packageCommand: true, content: 'a', images: 'b' });
    expect(vscePackageBaseUrls('vsce ls --baseContentUrl a')).to.deep.equal({
      packageCommand: false,
    });
  });
});
