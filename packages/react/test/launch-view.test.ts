import { expect } from 'chai';
import { loadLaunchView, saveLaunchView } from '../src/preferences/launch-view.js';

describe('launch view preference', () => {
  beforeEach(() => localStorage.clear());

  it('opens the last document unless Home was chosen', () => {
    expect(loadLaunchView()).to.equal('last-document');
    saveLaunchView('home');
    expect(loadLaunchView()).to.equal('home');
    saveLaunchView('last-document');
    expect(loadLaunchView()).to.equal('last-document');
    expect(localStorage.getItem('docblocks:launchView')).to.equal(null);
  });

  it('treats anything else stored as the default', () => {
    localStorage.setItem('docblocks:launchView', 'dashboard');
    expect(loadLaunchView()).to.equal('last-document');
  });
});
