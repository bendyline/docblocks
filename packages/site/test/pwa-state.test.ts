import { expect } from 'chai';
import { PwaStateStore } from '../src/pwa-state.js';

describe('site PWA lifecycle state', () => {
  it('keeps a failed first install distinct from offline readiness', () => {
    const store = new PwaStateStore();
    store.markInstallFailed();
    expect(store.getSnapshot().offlineReady).to.equal(false);
    expect(store.getSnapshot().installFailed).to.equal(true);

    store.markOfflineReady();
    expect(store.getSnapshot()).to.deep.equal({
      updateAvailable: false,
      offlineReady: true,
      installFailed: false,
    });
  });

  it('publishes a promptable update without changing offline readiness', () => {
    const store = new PwaStateStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.markOfflineReady();
    store.markUpdateAvailable();
    store.markUpdateAvailable();
    unsubscribe();

    expect(store.getSnapshot()).to.deep.equal({
      updateAvailable: true,
      offlineReady: true,
      installFailed: false,
    });
    expect(notifications).to.equal(2);
  });
});
