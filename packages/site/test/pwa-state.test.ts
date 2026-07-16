import { expect } from 'chai';
import { PwaStateStore } from '../src/pwa-state.js';

describe('site PWA lifecycle state', () => {
  it('keeps a failed first install distinct from offline readiness', () => {
    const store = new PwaStateStore();
    store.markInstallFailed();
    expect(store.getSnapshot().offlineReady).to.equal(false);
    expect(store.getSnapshot().installError).to.contain('could not finish caching');

    store.markOfflineReady();
    expect(store.getSnapshot()).to.deep.equal({
      updateAvailable: false,
      offlineReady: true,
      installError: null,
    });
  });

  it('lets the user dismiss the install alert without claiming offline support', () => {
    const store = new PwaStateStore();
    store.markInstallFailed();
    store.dismissInstallError();

    expect(store.getSnapshot()).to.deep.equal({
      updateAvailable: false,
      offlineReady: false,
      installError: null,
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
      installError: null,
    });
    expect(notifications).to.equal(2);
  });
});
