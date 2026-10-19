import { expect } from 'chai';
import path from 'node:path';
import { browserCandidates } from '../../../scripts/run-new-profile.js';

describe('run-new-profile browser discovery', () => {
  it('prefers Chrome over Edge across every Windows install root', () => {
    const candidates = browserCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    });
    expect(candidates).to.deep.equal([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
    ]);
  });

  it('skips Windows install roots the environment does not define', () => {
    expect(browserCandidates('win32', { ProgramFiles: 'C:\\Program Files' })).to.have.length(2);
  });

  it('searches PATH for Chromium-family browsers on Linux', () => {
    const candidates = browserCandidates('linux', { PATH: ['/usr/bin', '/snap/bin'].join(':') });
    expect(candidates[0]).to.equal(path.posix.join('/usr/bin', 'google-chrome'));
    expect(candidates).to.include('/snap/bin/chromium');
    expect(browserCandidates('linux', {})).to.deep.equal([]);
  });
});
