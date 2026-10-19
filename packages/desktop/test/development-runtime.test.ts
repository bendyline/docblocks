import { expect } from 'chai';
import path from 'node:path';

import {
  DEVELOPMENT_PROFILE_ENV,
  developmentProfileOverride,
  developmentUserDataPath,
  developmentWorkspacePath,
  isDevelopmentRuntime,
} from '../main/development-runtime.js';

describe('Electron development runtime isolation', () => {
  it('recognizes only unpackaged non-production launches as development', () => {
    expect(isDevelopmentRuntime(false, undefined)).to.equal(true);
    expect(isDevelopmentRuntime(false, 'development')).to.equal(true);
    expect(isDevelopmentRuntime(false, 'production')).to.equal(false);
    expect(isDevelopmentRuntime(true, 'development')).to.equal(false);
  });

  it('uses separate DocBlocks-dev profile and workspace directories', () => {
    expect(developmentUserDataPath(path.join('home', 'app-data'))).to.equal(
      path.join('home', 'app-data', 'DocBlocks-dev'),
    );
    expect(developmentWorkspacePath(path.join('home', 'Documents'))).to.equal(
      path.join('home', 'Documents', 'DocBlocks-dev'),
    );
  });

  it('keeps the everyday profile unless a throwaway profile root is named', () => {
    expect(developmentProfileOverride({})).to.equal(null);
    expect(developmentProfileOverride({ [DEVELOPMENT_PROFILE_ENV]: '  ' })).to.equal(null);
  });

  it('moves userData and Documents under an absolute throwaway profile root', () => {
    const root = path.join('tmp', 'docblocks-new', 'app-1');
    expect(developmentProfileOverride({ [DEVELOPMENT_PROFILE_ENV]: root })).to.deep.equal({
      userData: path.resolve(root, 'userData'),
      documents: path.resolve(root, 'Documents'),
    });
  });
});
