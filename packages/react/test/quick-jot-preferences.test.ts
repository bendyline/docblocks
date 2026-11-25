import { expect } from 'chai';
import { loadQuickJotVisible, saveQuickJotVisible } from '../src/preferences/quick-jot.js';

const STORAGE_KEY = 'docblocks:quickJot';

describe('Quick Jot preference', () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('shows Quick Jot until it is turned off', () => {
    expect(loadQuickJotVisible()).to.equal(true);
    saveQuickJotVisible(false);
    expect(localStorage.getItem(STORAGE_KEY)).to.equal('hidden');
    expect(loadQuickJotVisible()).to.equal(false);
  });

  it('stores nothing once it is back on', () => {
    saveQuickJotVisible(false);
    saveQuickJotVisible(true);
    expect(localStorage.getItem(STORAGE_KEY)).to.equal(null);
    expect(loadQuickJotVisible()).to.equal(true);
  });

  it('treats an unknown stored value as on', () => {
    localStorage.setItem(STORAGE_KEY, 'something else');
    expect(loadQuickJotVisible()).to.equal(true);
  });
});
