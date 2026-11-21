import { expect } from 'chai';
import {
  CLOUD_HELPER_BINARY_NAME,
  CloudHelper,
  CloudHelperError,
  resolveCloudHelperBinary,
  type CloudHelperProcess,
} from '../main/cloud-helper.js';

/** A scripted helper process: the test decides what each request line gets back. */
class FakeProcess implements CloudHelperProcess {
  public readonly requests: Array<Record<string, unknown>> = [];
  public killed = false;
  private lineListener: (line: string) => void = () => undefined;
  private exitListener: () => void = () => undefined;

  public constructor(private readonly respond: (request: Record<string, unknown>) => unknown) {}

  public write(line: string): void {
    const request = JSON.parse(line) as Record<string, unknown>;
    this.requests.push(request);
    const reply = this.respond(request);
    if (reply !== undefined) {
      queueMicrotask(() => {
        if (!this.killed)
          this.lineListener(typeof reply === 'string' ? reply : JSON.stringify(reply));
      });
    }
  }
  public onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }
  public onExit(listener: () => void): void {
    this.exitListener = listener;
  }
  public kill(): void {
    this.killed = true;
  }
  public exit(): void {
    this.exitListener();
  }
}

function helperWith(...scripts: Array<(request: Record<string, unknown>) => unknown>) {
  const processes: FakeProcess[] = [];
  const helper = new CloudHelper(
    '/helper',
    () => {
      const script = scripts[Math.min(processes.length, scripts.length - 1)]!;
      const created = new FakeProcess(script);
      processes.push(created);
      return created;
    },
    50,
  );
  return { helper, processes };
}

async function failure(work: Promise<unknown>): Promise<CloudHelperError> {
  try {
    await work;
  } catch (error: unknown) {
    if (error instanceof CloudHelperError) return error;
    throw error;
  }
  throw new Error('Expected the request to fail.');
}

describe('CloudHelper client', () => {
  it('asks one question per line and returns typed answers', async () => {
    const { helper, processes } = helperWith((request) => {
      if (request.op === 'scan') {
        return {
          id: request.id,
          ok: true,
          value: { synced: true, conflicted: ['Notes/Unicorns.md'], truncated: false },
        };
      }
      if (request.op === 'harvest') {
        return { id: request.id, ok: true, value: { kept: 1, duplicates: 2, pending: 0 } };
      }
      return {
        id: request.id,
        ok: true,
        value: [
          { path: '/a', synced: false },
          {
            path: '/b',
            synced: true,
            uploaded: true,
            uploading: false,
            download: 'stale',
            conflicts: true,
          },
        ],
      };
    });

    expect(await helper.scan('/root')).to.deep.equal({
      synced: true,
      conflicted: ['Notes/Unicorns.md'],
      truncated: false,
    });
    expect(await helper.harvest('/root', 'Notes/Unicorns.md')).to.deep.equal({
      kept: 1,
      duplicates: 2,
      pending: 0,
    });
    expect((await helper.status(['/a', '/b'])).map((item) => item.synced)).to.deep.equal([
      false,
      true,
    ]);
    expect(processes).to.have.length(1);
    expect(processes[0]!.requests.map((request) => request.op)).to.deep.equal([
      'scan',
      'harvest',
      'status',
    ]);
    expect(processes[0]!.requests[1]).to.include({ root: '/root', path: 'Notes/Unicorns.md' });
    helper.dispose();
  });

  it('retries once with a fresh helper when the folder was granted after it started', async () => {
    const { helper, processes } = helperWith(
      (request) => ({ id: request.id, ok: false, code: 'permission-denied' }),
      (request) => ({
        id: request.id,
        ok: true,
        value: { synced: false, conflicted: [], truncated: false },
      }),
    );
    expect((await helper.scan('/root')).synced).to.equal(false);
    expect(processes).to.have.length(2);
    expect(processes[0]!.killed).to.equal(true);
    helper.dispose();
  });

  it('reports a denial that a fresh helper does not cure', async () => {
    const { helper, processes } = helperWith((request) => ({
      id: request.id,
      ok: false,
      code: 'permission-denied',
    }));
    expect((await failure(helper.scan('/root'))).code).to.equal('permission-denied');
    expect(processes).to.have.length(2);
    helper.dispose();
  });

  it('passes other failures through without restarting', async () => {
    const { helper, processes } = helperWith((request) => ({
      id: request.id,
      ok: false,
      code: 'not-found',
    }));
    expect((await failure(helper.harvest('/root', 'gone.md'))).code).to.equal('not-found');
    expect(processes).to.have.length(1);
    expect(processes[0]!.killed).to.equal(false);
    helper.dispose();
  });

  it('gives up on a helper that never answers and starts another for the next request', async () => {
    const { helper, processes } = helperWith(
      () => undefined,
      (request) => ({ id: request.id, ok: true, value: { kept: 0, duplicates: 0, pending: 0 } }),
    );
    expect((await failure(helper.scan('/root'))).code).to.equal('timeout');
    expect(processes[0]!.killed).to.equal(true);
    expect((await helper.harvest('/root', 'a.md')).kept).to.equal(0);
    expect(processes).to.have.length(2);
    helper.dispose();
  });

  it('fails every waiting request when the helper exits', async () => {
    const { helper, processes } = helperWith(() => undefined);
    const waiting = failure(helper.scan('/root'));
    processes[0]!.exit();
    expect((await waiting).code).to.equal('unavailable');
    helper.dispose();
  });

  it('refuses answers that are not what it asked for', async () => {
    const { helper } = helperWith((request) => ({
      id: request.id,
      ok: true,
      value: { synced: 'yes', conflicted: [], truncated: false },
    }));
    expect((await failure(helper.scan('/root'))).code).to.equal('corrupt');

    const garbled = helperWith(() => 'not json');
    expect((await failure(garbled.helper.scan('/root'))).code).to.equal('corrupt');
    expect(garbled.processes[0]!.killed).to.equal(true);
    helper.dispose();
    garbled.helper.dispose();
  });

  it('reports a helper that cannot be started, and stays closed once disposed', async () => {
    const missing = new CloudHelper('/missing', () => {
      throw new Error('ENOENT');
    });
    expect((await failure(missing.scan('/root'))).code).to.equal('unavailable');

    const { helper, processes } = helperWith(() => undefined);
    helper.dispose();
    expect((await failure(helper.scan('/root'))).code).to.equal('closed');
    expect(processes).to.have.length(0);
  });
});

describe('resolveCloudHelperBinary', () => {
  const base = { resourcesPath: '/App.app/Contents/Resources', appPath: '/repo/packages/desktop' };

  it('finds the helper beside the app’s other nested programs when packaged', () => {
    const seen: string[] = [];
    const found = resolveCloudHelperBinary({
      ...base,
      platform: 'darwin',
      packaged: true,
      exists: (candidate) => {
        seen.push(candidate);
        return true;
      },
    });
    expect(found).to.equal(`/App.app/Contents/Helpers/${CLOUD_HELPER_BINARY_NAME}`);
    expect(seen).to.deep.equal([found]);
  });

  it('uses the staged copy in a source checkout', () => {
    expect(
      resolveCloudHelperBinary({
        ...base,
        platform: 'darwin',
        packaged: false,
        exists: () => true,
      }),
    ).to.equal(`/repo/packages/desktop/dist/cloud-helper/${CLOUD_HELPER_BINARY_NAME}`);
  });

  it('is absent on a macOS older than the helper supports', () => {
    const on = (systemVersion: string) =>
      resolveCloudHelperBinary({
        ...base,
        platform: 'darwin',
        packaged: true,
        systemVersion,
        exists: () => true,
      });
    expect(on('12.7.6')).to.equal(null);
    expect(on('unknown')).to.equal(null);
    expect(on('13.0')).to.be.a('string');
    expect(on('27.2')).to.be.a('string');
  });

  it('is absent off macOS and when nothing was staged', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(
        resolveCloudHelperBinary({ ...base, platform, packaged: true, exists: () => true }),
      ).to.equal(null);
    }
    expect(
      resolveCloudHelperBinary({
        ...base,
        platform: 'darwin',
        packaged: false,
        exists: () => false,
      }),
    ).to.equal(null);
  });
});
