import { expect } from 'chai';
import { guessMediaMimeType, mediaSidecarFolder, parseMediaRef } from '../src/mediaPaths.js';

describe('VS Code media paths', () => {
  it('uses the markdown basename to derive the sidecar folder', () => {
    expect(mediaSidecarFolder('mikehome.md')).to.equal('mikehome_files');
  });

  it('keeps already-qualified sidecar paths intact', () => {
    expect(parseMediaRef('mikehome_files/mikerv.jpg', 'mikehome.md')).to.deep.equal({
      key: 'mikehome_files/mikerv.jpg',
      suffix: '',
    });
  });

  it('maps bare media names into the document sidecar folder', () => {
    expect(parseMediaRef('mikerv.jpg', 'mikehome.md')).to.deep.equal({
      key: 'mikehome_files/mikerv.jpg',
      suffix: '',
    });
  });

  it('preserves URL suffixes outside the filesystem path', () => {
    expect(parseMediaRef('mikehome_files/photo%201.png#hero', 'mikehome.md')).to.deep.equal({
      key: 'mikehome_files/photo 1.png',
      suffix: '#hero',
    });
  });

  it('rejects traversal out of the sidecar folder', () => {
    expect(parseMediaRef('../secret.png', 'mikehome.md')).to.equal(null);
    expect(parseMediaRef('mikehome_files/../secret.png', 'mikehome.md')).to.equal(null);
  });

  it('guesses common media MIME types', () => {
    expect(guessMediaMimeType('mikehome_files/mikerv.jpg')).to.equal('image/jpeg');
    expect(guessMediaMimeType('mikehome_files/audio.webm')).to.equal('video/webm');
  });
});
