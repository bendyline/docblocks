import { expect } from 'chai';
import {
  FsError,
  MemoryFileSystemProvider,
  moveFileBetweenWorkspaces,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';

function workspaces() {
  return {
    home: new MemoryFileSystemProvider('home', 'Home'),
    work: new MemoryFileSystemProvider('work', 'Work'),
  };
}

describe('moveFileBetweenWorkspaces', () => {
  it('moves a document and its companion folder into a folder of another workspace', async () => {
    const { home, work } = workspaces();
    await home.writeFile('Unfiled/Tides.md', '# Tides\n\n![Chart](Tides_files/chart.png)');
    await home.writeBinary('Unfiled/Tides_files/chart.png', new Uint8Array([1, 2, 3]));
    await home.writeBinary('Unfiled/Tides_files/versions/one.md', new Uint8Array([4]));
    await work.v2.createDirectory(parseWorkspacePath('Ocean'), { mode: 'ensure' });

    const landed = await moveFileBetweenWorkspaces(home, work, '/Unfiled/Tides.md', '/Ocean');

    expect(landed).to.equal('Ocean/Tides.md');
    expect(await work.readFile('Ocean/Tides.md')).to.equal(
      '# Tides\n\n![Chart](Tides_files/chart.png)',
    );
    expect([...new Uint8Array((await work.readBinary('Ocean/Tides_files/chart.png'))!)]).to.eql([
      1, 2, 3,
    ]);
    expect(await work.exists('Ocean/Tides_files/versions/one.md')).to.equal(true);
    expect(await home.exists('Unfiled/Tides.md')).to.equal(false);
    expect(await home.exists('Unfiled/Tides_files')).to.equal(false);
    expect(await home.exists('Unfiled')).to.equal(true);
  });

  it('numbers past a name already taken there and follows it in the references', async () => {
    const { home, work } = workspaces();
    await home.writeFile('Tides.md', '![Chart](Tides_files/chart.png)');
    await home.writeBinary('Tides_files/chart.png', new Uint8Array([1]));
    await work.writeFile('Tides.md', 'Already here');

    const landed = await moveFileBetweenWorkspaces(home, work, 'Tides.md', '');

    expect(landed).to.equal('Tides (2).md');
    expect(await work.readFile('Tides.md')).to.equal('Already here');
    const moved = await work.readFile('Tides (2).md');
    expect(moved).to.contain('Tides (2)_files/chart.png');
    expect(moved).not.to.contain('](Tides_files/');
    expect(await work.exists('Tides (2)_files/chart.png')).to.equal(true);
  });

  it('makes the folder when it is not there yet, and moves a file with no companion', async () => {
    const { home, work } = workspaces();
    await home.writeBinary('photo.gif', new Uint8Array([7]));

    const landed = await moveFileBetweenWorkspaces(home, work, 'photo.gif', 'Pictures/2026');

    expect(landed).to.equal('Pictures/2026/photo.gif');
    expect(await work.exists('Pictures/2026/photo.gif')).to.equal(true);
    expect(await home.exists('photo.gif')).to.equal(false);
  });

  it('changes nothing when the original cannot be removed', async () => {
    const { home, work } = workspaces();
    await home.writeFile('Tides.md', 'Kept');
    await home.writeBinary('Tides_files/chart.png', new Uint8Array([1]));
    const remove = home.v2.remove.bind(home.v2);
    home.v2.remove = (path, options) =>
      path === 'Tides.md'
        ? Promise.reject(new FsError('conflict', 'Changed meanwhile.'))
        : remove(path, options);

    let failure: unknown = null;
    try {
      await moveFileBetweenWorkspaces(home, work, 'Tides.md', 'Ocean');
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(FsError);
    expect(await home.readFile('Tides.md')).to.equal('Kept');
    expect(await home.exists('Tides_files/chart.png')).to.equal(true);
    expect(await work.exists('Ocean/Tides.md')).to.equal(false);
    expect(await work.exists('Ocean/Tides_files')).to.equal(false);
  });

  it('rejects a file that is not there', async () => {
    const { home, work } = workspaces();
    let failure: unknown = null;
    try {
      await moveFileBetweenWorkspaces(home, work, 'Missing.md', '');
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('not-found');
  });
});
