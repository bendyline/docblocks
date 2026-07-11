import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';

import { bindOwnerGrantRevocation } from '../main/owner-revocation.js';

class FakeWebContents extends EventEmitter {}

function ownerFrom(fake: FakeWebContents): WebContents {
  return fake as unknown as WebContents;
}

describe('renderer capability owner revocation', () => {
  it('preserves grants across same-document main-frame navigation', () => {
    const fake = new FakeWebContents();
    let revocations = 0;
    bindOwnerGrantRevocation(ownerFrom(fake), () => {
      revocations += 1;
    });

    fake.emit('did-start-navigation', {}, 'app://docblocks/index.html#workspace/file.md', true, true);

    expect(revocations).to.equal(0);
  });

  it('revokes grants on cross-document main-frame navigation only', () => {
    const fake = new FakeWebContents();
    let revocations = 0;
    bindOwnerGrantRevocation(ownerFrom(fake), () => {
      revocations += 1;
    });

    fake.emit('did-start-navigation', {}, 'app://docblocks/worker.html', false, false);
    expect(revocations).to.equal(0);

    fake.emit('did-start-navigation', {}, 'app://docblocks/index.html', false, true);
    expect(revocations).to.equal(1);
  });

  it('revokes grants when the renderer process is lost', () => {
    const fake = new FakeWebContents();
    let revocations = 0;
    bindOwnerGrantRevocation(ownerFrom(fake), () => {
      revocations += 1;
    });

    fake.emit('render-process-gone');

    expect(revocations).to.equal(1);
  });
});
