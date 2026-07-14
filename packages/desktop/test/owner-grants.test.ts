import { expect } from 'chai';

import { OwnerGrantStore } from '../main/owner-grants.js';

describe('owner-scoped grants', () => {
  it('mints opaque grants that resolve only for their owner', () => {
    const store = new OwnerGrantStore<{ path: string }>('test');
    const grant = store.mint(1, { path: '/private/document.md' });

    expect(grant).to.match(/^test_[0-9a-f-]{36}$/);
    expect(grant).not.to.include('document.md');
    expect(store.require(1, grant)).to.deep.equal({ path: '/private/document.md' });
    expect(() => store.require(2, grant)).to.throw('invalid, expired');
  });

  it('revokes one grant or every grant owned by a renderer', () => {
    const store = new OwnerGrantStore<string>('test');
    const first = store.mint(1, 'first');
    const second = store.mint(1, 'second');
    const other = store.mint(2, 'other');

    expect(store.get(1, second)).to.equal('second');
    expect(store.get(2, second)).to.equal(null);
    expect(store.entries(1).map(({ grantId }) => grantId)).to.have.members([first, second]);

    expect(store.revoke(1, first)).to.equal(true);
    expect(store.revoke(2, second)).to.equal(false);
    expect(store.has(1, first)).to.equal(false);
    expect(store.has(1, second)).to.equal(true);

    expect(store.revokeOwner(1)).to.deep.equal([second]);
    expect(store.has(1, second)).to.equal(false);
    expect(store.has(2, other)).to.equal(true);
  });
});
