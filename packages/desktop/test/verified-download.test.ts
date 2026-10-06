import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  VerifiedDownloadError,
  verifiedDownload,
  verifyFile,
} from '../main/speech/verified-download.js';

const PAYLOAD = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251));
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

interface FakeCall {
  readonly range: string | null;
}

/**
 * A fetch double that serves PAYLOAD, honours or ignores Range, and errors its
 * body on abort the way a real fetch does.
 */
function fakeFetch(
  options: {
    honourRange?: boolean;
    body?: Uint8Array;
    status?: number;
    stallAfter?: number;
  } = {},
): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get('range');
    calls.push({ range });
    const body = options.body ?? PAYLOAD;
    let start = 0;
    let status = options.status ?? 200;
    const responseHeaders = new Headers();
    if (range && options.honourRange) {
      start = Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
      status = 206;
      responseHeaders.set('content-range', `bytes ${start}-${body.length - 1}/${body.length}`);
    }
    const slice = body.subarray(start);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
        if (options.stallAfter !== undefined) {
          controller.enqueue(slice.subarray(0, options.stallAfter));
          return; // never closes
        }
        controller.enqueue(slice.subarray(0, 1000));
        controller.enqueue(slice.subarray(1000));
        controller.close();
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function failure(promise: Promise<unknown>): Promise<VerifiedDownloadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VerifiedDownloadError) return error;
    throw error;
  }
  throw new Error('expected the download to fail');
}

describe('verifiedDownload', () => {
  let root: string;
  let destination: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-download-'));
    destination = path.join(root, 'model.bin');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = () => ({
    url: 'https://models.test/model.bin',
    destination,
    sha256: SHA,
    size: PAYLOAD.length,
  });

  it('writes verified bytes under the final name and reports progress', async () => {
    const progress: number[] = [];
    await verifiedDownload({
      ...base(),
      fetchImpl: fakeFetch().fetchImpl,
      onProgress: (received) => progress.push(received),
    });
    expect(new Uint8Array(await readFile(destination))).to.deep.equal(PAYLOAD);
    expect(progress.at(-1)).to.equal(PAYLOAD.length);
    expect(progress[0]).to.equal(0);
  });

  it('resumes a partial when the server honours the range', async () => {
    await writeFile(`${destination}.partial`, PAYLOAD.subarray(0, 1500));
    const fake = fakeFetch({ honourRange: true });
    await verifiedDownload({ ...base(), fetchImpl: fake.fetchImpl });
    expect(fake.calls[0]?.range).to.equal('bytes=1500-');
    expect(new Uint8Array(await readFile(destination))).to.deep.equal(PAYLOAD);
  });

  it('starts over when the server ignores the range', async () => {
    await writeFile(`${destination}.partial`, new Uint8Array(1500).fill(9));
    await verifiedDownload({ ...base(), fetchImpl: fakeFetch({ honourRange: false }).fetchImpl });
    expect(new Uint8Array(await readFile(destination))).to.deep.equal(PAYLOAD);
  });

  it('verifies a complete partial without fetching again', async () => {
    await writeFile(`${destination}.partial`, PAYLOAD);
    const fake = fakeFetch();
    await verifiedDownload({ ...base(), fetchImpl: fake.fetchImpl });
    expect(fake.calls).to.have.length(0);
    expect(new Uint8Array(await readFile(destination))).to.deep.equal(PAYLOAD);
  });

  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    const tampered = PAYLOAD.slice();
    tampered[10] = 0xff;
    const error = await failure(
      verifiedDownload({ ...base(), fetchImpl: fakeFetch({ body: tampered }).fetchImpl }),
    );
    expect(error.failure).to.equal('checksum');
    expect(await verifyFile(destination, SHA, PAYLOAD.length)).to.equal(false);
    let partialExists = true;
    await stat(`${destination}.partial`).catch(() => {
      partialExists = false;
    });
    expect(partialExists).to.equal(false);
  });

  it('refuses a body larger than the pinned size', async () => {
    const larger = new Uint8Array(PAYLOAD.length + 10);
    const error = await failure(
      verifiedDownload({ ...base(), fetchImpl: fakeFetch({ body: larger }).fetchImpl }),
    );
    expect(error.failure).to.equal('size');
  });

  it('reports HTTP errors', async () => {
    const error = await failure(
      verifiedDownload({ ...base(), fetchImpl: fakeFetch({ status: 404 }).fetchImpl }),
    );
    expect(error.failure).to.equal('http');
  });

  it('times out a stalled transfer and keeps the partial for resume', async () => {
    const error = await failure(
      verifiedDownload({
        ...base(),
        idleTimeoutMs: 40,
        fetchImpl: fakeFetch({ stallAfter: 700 }).fetchImpl,
      }),
    );
    expect(error.failure).to.equal('timeout');
    expect((await stat(`${destination}.partial`)).size).to.equal(700);
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    const pending = verifiedDownload({
      ...base(),
      signal: controller.signal,
      fetchImpl: fakeFetch({ stallAfter: 100 }).fetchImpl,
    });
    setTimeout(() => controller.abort(), 10);
    expect((await failure(pending)).failure).to.equal('aborted');
    controller.abort();
    expect(
      (
        await failure(
          verifiedDownload({
            ...base(),
            signal: controller.signal,
            fetchImpl: fakeFetch().fetchImpl,
          }),
        )
      ).failure,
    ).to.equal('aborted');
  });
});

describe('verifyFile', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-verify-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts exact bytes and rejects size, content and symlink mismatches', async () => {
    const file = path.join(root, 'weights.bin');
    await writeFile(file, PAYLOAD);
    expect(await verifyFile(file, SHA, PAYLOAD.length)).to.equal(true);
    expect(await verifyFile(file, SHA, PAYLOAD.length + 1)).to.equal(false);
    expect(await verifyFile(file, '0'.repeat(64), PAYLOAD.length)).to.equal(false);
    expect(await verifyFile(path.join(root, 'missing'), SHA, PAYLOAD.length)).to.equal(false);
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link.bin');
      await symlink(file, link);
      expect(await verifyFile(link, SHA, PAYLOAD.length)).to.equal(false);
    }
  });
});
