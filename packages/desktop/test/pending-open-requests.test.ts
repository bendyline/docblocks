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
});
