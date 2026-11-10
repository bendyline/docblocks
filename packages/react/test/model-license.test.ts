import { expect } from 'chai';
import { isMitOrApacheLicense, shownModelLicense } from '../src/Settings/model-license.js';

describe('model license display', () => {
  it('leaves MIT and Apache 2.0 unsaid however a catalog spells them', () => {
    for (const license of [
      'MIT',
      'mit',
      'MIT License',
      'The MIT License',
      'Apache-2.0',
      'Apache 2.0',
      'apache_2.0',
      'Apache License 2.0',
      'Apache License, Version 2.0',
      ' Apache-2.0 ',
    ]) {
      expect(isMitOrApacheLicense(license), license).to.equal(true);
      expect(shownModelLicense(license), license).to.equal(null);
    }
  });

  it('names every other license, including near misses', () => {
    // Each of these appears in a real model catalog.
    for (const license of [
      'MIT-Modified',
      'Creative Commons Attribution 4.0; MIT License',
      'CreativeML Open RAIL-M',
      'OpenRAIL++',
      'Krea 2 Community License',
      'Stability AI Non-Commercial Research',
      'Llama 3.2 Community License',
      'qwen-community-1.0',
      'Apache-2.0 with LLVM exception',
    ]) {
      expect(isMitOrApacheLicense(license), license).to.equal(false);
      expect(shownModelLicense(license), license).to.equal(license);
    }
  });

  it('has nothing to name when the catalog gives no license', () => {
    expect(shownModelLicense(null)).to.equal(null);
    expect(shownModelLicense(undefined)).to.equal(null);
    expect(shownModelLicense('')).to.equal(null);
  });
});
