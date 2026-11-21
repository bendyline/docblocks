import { expect } from 'chai';
import {
  CloudConflictCoordinator,
  createCloudConflicts,
  type CloudConflictClient,
} from '../main/cloud-conflicts.js';
import type { CloudScan } from '../main/cloud-helper.js';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';

class FakeClient implements CloudConflictClient {
  public readonly calls: string[] = [];
  public scans: Record<string, CloudScan | Error> = {};
  public disposed = false;

  public async scan(root: string): Promise<CloudScan> {
    this.calls.push(`scan ${root}`);
    const result = this.scans[root] ?? { synced: true, conflicted: [], truncated: false };
    if (result instanceof Error) throw result;
    return result;
  }
  public async harvest(root: string, relativePath: string) {
    this.calls.push(`harvest ${root} ${relativePath}`);
    if (relativePath === 'broken.md') throw new Error('helper failed');
    return { kept: 1, duplicates: 0, pending: 0 };
  }
  public dispose(): void {
    this.disposed = true;
  }
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function coordinatorFor(client: FakeClient, now: () => number = Date.now) {
  return new CloudConflictCoordinator(client, { harvestDelayMs: 5, scanIntervalMs: 1_000, now });
}

describe('CloudConflictCoordinator', () => {
  it('looks through a folder once when it opens and collects what iCloud set aside', async () => {
    const client = new FakeClient();
    client.scans['/cloud'] = { synced: true, conflicted: ['Notes/Unicorns.md'], truncated: false };
    const coordinator = coordinatorFor(client);
    coordinator.workspaceOpened('/cloud');
    coordinator.workspaceOpened('/cloud');
    await coordinator.idle();
    expect(client.calls).to.deep.equal(['scan /cloud', 'harvest /cloud Notes/Unicorns.md']);
    coordinator.dispose();
  });

  it('leaves a folder iCloud does not sync alone', async () => {
    const client = new FakeClient();
    client.scans['/plain'] = { synced: false, conflicted: [], truncated: false };
    const coordinator = coordinatorFor(client);
    coordinator.workspaceOpened('/plain');
    await coordinator.idle();
    coordinator.documentTouched('/plain', 'note.md');
    coordinator.refresh();
    await settle();
    await coordinator.idle();
    expect(client.calls).to.deep.equal(['scan /plain']);
    coordinator.dispose();
  });

  it('collects for a document once its changes settle', async () => {
    const client = new FakeClient();
    const coordinator = coordinatorFor(client);
    coordinator.workspaceOpened('/cloud');
    for (let index = 0; index < 5; index += 1) coordinator.documentTouched('/cloud', '/note.md');
    coordinator.documentTouched('/cloud', 'other.md');
    await settle();
    await coordinator.idle();
    expect(client.calls).to.deep.equal([
      'scan /cloud',
      'harvest /cloud note.md',
      'harvest /cloud other.md',
    ]);
    coordinator.dispose();
  });

  it('never collects for the copies themselves or for hidden files', async () => {
    const client = new FakeClient();
    const coordinator = coordinatorFor(client);
    coordinator.workspaceOpened('/cloud');
    coordinator.documentTouched(
      '/cloud',
      'note_files/conflicts/20261120T103612Z-sync-0123456789abcdef.md',
    );
    coordinator.documentTouched('/cloud', 'note_files/conflicts/other/photo.png');
    coordinator.documentTouched('/cloud', '.git/index');
    coordinator.documentTouched('/cloud', 'note_files/.versions/1.md');
    coordinator.documentTouched('/elsewhere', 'note.md');
    coordinator.documentTouched('/cloud', 'note_files/photo.png');
    await settle();
    await coordinator.idle();
    expect(client.calls).to.deep.equal(['scan /cloud', 'harvest /cloud note_files/photo.png']);
    coordinator.dispose();
  });

  it('looks again when the app comes forward, but not more often than its interval', async () => {
    const client = new FakeClient();
    let clock = 0;
    const coordinator = coordinatorFor(client, () => clock);
    coordinator.workspaceOpened('/cloud');
    await coordinator.idle();
    clock = 500;
    coordinator.refresh();
    await coordinator.idle();
    expect(client.calls).to.deep.equal(['scan /cloud']);
    clock = 1_500;
    coordinator.refresh();
    coordinator.refresh();
    await coordinator.idle();
    expect(client.calls).to.deep.equal(['scan /cloud', 'scan /cloud']);
    coordinator.dispose();
  });

  it('carries on after a failure and tries the folder again later', async () => {
    const client = new FakeClient();
    client.scans['/cloud'] = new Error('helper unavailable');
    let clock = 0;
    const coordinator = coordinatorFor(client, () => clock);
    coordinator.workspaceOpened('/cloud');
    await coordinator.idle();
    client.scans['/cloud'] = {
      synced: true,
      conflicted: ['broken.md', 'fine.md'],
      truncated: false,
    };
    clock = 2_000;
    coordinator.refresh();
    await coordinator.idle();
    expect(client.calls).to.deep.equal([
      'scan /cloud',
      'scan /cloud',
      'harvest /cloud broken.md',
      'harvest /cloud fine.md',
    ]);
    coordinator.dispose();
  });

  it('stops when the last window closes the folder, and when disposed', async () => {
    const client = new FakeClient();
    const coordinator = coordinatorFor(client);
    coordinator.workspaceOpened('/cloud');
    coordinator.workspaceOpened('/cloud');
    await coordinator.idle();
    coordinator.workspaceClosed('/cloud');
    coordinator.documentTouched('/cloud', 'still-open.md');
    await settle();
    await coordinator.idle();
    coordinator.workspaceClosed('/cloud');
    coordinator.documentTouched('/cloud', 'closed.md');
    await settle();
    await coordinator.idle();
    expect(client.calls).to.deep.equal(['scan /cloud', 'harvest /cloud still-open.md']);

    coordinator.dispose();
    coordinator.workspaceOpened('/cloud');
    await coordinator.idle();
    expect(client.calls).to.have.length(2);
    expect(client.disposed).to.equal(true);
  });
});

describe('createCloudConflicts', () => {
  const location = {
    platform: 'darwin' as const,
    packaged: true,
    resourcesPath: '/App.app/Contents/Resources',
    appPath: '/App.app/Contents/Resources/app.asar',
  };

  it('is off where the build has no helper', () => {
    expect(createCloudConflicts({ ...location, exists: () => false })).to.equal(null);
    expect(createCloudConflicts({ ...location, platform: 'win32', exists: () => true })).to.equal(
      null,
    );
  });

  it('turns folder activity into work for the helper', async () => {
    const client = new FakeClient();
    let binary = '';
    const cloud = createCloudConflicts({ ...location, exists: () => true }, (path) => {
      binary = path;
      return client;
    })!;
    expect(binary).to.equal('/App.app/Contents/Helpers/docblocks-cloud-helper');
    cloud.observer.opened?.('/cloud');
    cloud.observer.touched?.('/cloud', parseWorkspacePath('Notes/Unicorns.md'));
    await settle(900);
    cloud.observer.closed?.('/cloud');
    expect(client.calls).to.deep.equal(['scan /cloud', 'harvest /cloud Notes/Unicorns.md']);
    cloud.dispose();
    expect(client.disposed).to.equal(true);
  });
});
