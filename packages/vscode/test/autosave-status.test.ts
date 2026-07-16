import { expect } from 'chai';
import { isAutoSavePending } from '../webview/src/autosaveStatus.js';

describe('VS Code autosave status', () => {
  it('shows only while an enabled autosave is waiting', () => {
    expect(isAutoSavePending(true, 'dirty')).to.equal(true);
    expect(isAutoSavePending(false, 'dirty')).to.equal(false);
    expect(isAutoSavePending(true, 'saving')).to.equal(false);
    expect(isAutoSavePending(true, 'saved')).to.equal(false);
    expect(isAutoSavePending(true, 'error')).to.equal(false);
    expect(isAutoSavePending(true, 'conflict')).to.equal(false);
  });
});
