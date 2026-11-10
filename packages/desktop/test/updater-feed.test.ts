import { expect } from 'chai';

import {
  COMBINED_WINDOWS_FEED_CHANNEL,
  isMissingFeedError,
  windowsFeedChannel,
  windowsUpdateChannel,
} from '../main/updater-feed.js';

describe('Windows update feeds', () => {
  // Installed apps ask each release for these names, so they can never change.
  it('pins the manifest names published with every release', () => {
    expect(windowsFeedChannel('x64')).to.equal('latest-win-x64');
    expect(windowsFeedChannel('arm64')).to.equal('latest-win-arm64');
    expect(COMBINED_WINDOWS_FEED_CHANNEL).to.equal('latest');
  });

  it('follows the feed for the architecture the app was built for', () => {
    expect(windowsUpdateChannel('x64', false)).to.equal('latest-win-x64');
    expect(windowsUpdateChannel('arm64', false)).to.equal('latest-win-arm64');
  });

  it('moves an emulated x64 build to the arm64 feed', () => {
    expect(windowsUpdateChannel('x64', true)).to.equal('latest-win-arm64');
  });

  it('stays on the combined feed for an architecture with no feed of its own', () => {
    expect(windowsUpdateChannel('ia32', false)).to.equal(null);
  });

  it('recognizes only a missing manifest as a missing feed', () => {
    const missing = Object.assign(new Error('Cannot find latest-win-arm64.yml'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    const offline = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {
      code: 'ERR_INTERNET_DISCONNECTED',
    });

    expect(isMissingFeedError(missing)).to.equal(true);
    expect(isMissingFeedError(offline)).to.equal(false);
    expect(isMissingFeedError(new Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).to.equal(false);
    expect(isMissingFeedError(null)).to.equal(false);
  });
});
