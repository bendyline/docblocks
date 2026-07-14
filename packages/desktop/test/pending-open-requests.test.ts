import { expect } from 'chai';
import { PendingOpenRequests, type PendingOpenRequest } from '../main/pending-open-requests.js';

describe('PendingOpenRequests', () => {
  it('retains pre-window second-instance argv with other OS events in arrival order', () => {
    const pending = new PendingOpenRequests();
    const argv = ['electron.exe', 'docblocks', 'first.dbk'];
    pending.enqueueArgv(argv);
    argv[2] = 'mutated.dbk';
    pending.enqueueFile('second.md');
    pending.enqueueUrl('docblocks://open?path=third.md');

    const received: PendingOpenRequest[] = [];
    pending.drain((request) => received.push(request));

    expect(received).to.deep.equal([
      { kind: 'argv', argv: ['electron.exe', 'docblocks', 'first.dbk'] },
      { kind: 'file', path: 'second.md' },
      { kind: 'url', url: 'docblocks://open?path=third.md' },
    ]);
  });

  it('delivers each queued request only once', () => {
    const pending = new PendingOpenRequests();
    pending.enqueueArgv(['notes.md']);
    let deliveries = 0;
    pending.drain(() => deliveries++);
    pending.drain(() => deliveries++);
    expect(deliveries).to.equal(1);
  });

  it('continues FIFO delivery after one request dispatcher throws', () => {
    const pending = new PendingOpenRequests();
    pending.enqueueFile('stale.md');
    pending.enqueueFile('current.md');
    const received: string[] = [];

    const failures = pending.drain((request) => {
      if (request.kind !== 'file') throw new Error('unexpected request kind');
      received.push(request.path);
      if (request.path === 'stale.md') throw new Error('file disappeared');
    });

    expect(received).to.deep.equal(['stale.md', 'current.md']);
    expect(failures).to.have.length(1);
    expect(failures[0]).to.be.instanceOf(Error);
  });

  it('delivers a request queued after an earlier startup drain', () => {
    const pending = new PendingOpenRequests();
    const received: string[] = [];
    const dispatch = (request: PendingOpenRequest) => {
      if (request.kind === 'file') received.push(request.path);
    };

    pending.enqueueFile('before-ready.md');
    pending.drain(dispatch);
    pending.enqueueFile('before-window-assignment.md');
    pending.drain(dispatch);

    expect(received).to.deep.equal(['before-ready.md', 'before-window-assignment.md']);
  });
});
