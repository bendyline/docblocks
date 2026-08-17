import { expect } from 'chai';
import { createCoverImageSaveOutput } from '../src/Export/cover-image-save.js';
import { createDashboardImageSaveOutput } from '../src/Export/dashboard-image-save.js';
import { createImageSaveOutput } from '../src/Export/image-save.js';

describe('rendered image host save output', () => {
  it('picks a fresh target and saves the rendered blob through the host adapter', async () => {
    const target = { grantId: 'cover-grant', displayPath: 'brief-cover.png' };
    const blob = new Blob(['cover'], { type: 'image/png' });
    const picked: Array<{ filename: string; currentTarget: typeof target | null | undefined }> = [];
    const saved: Array<{ blob: Blob; filename: string; target: typeof target | null | undefined }> =
      [];
    const saveOutput = createCoverImageSaveOutput({
      async pickTarget(filename, currentTarget) {
        picked.push({ filename, currentTarget });
        return target;
      },
      async saveBlob(value, filename, saveTarget) {
        saved.push({ blob: value, filename, target: saveTarget });
        return target;
      },
    });

    expect(await saveOutput(blob, 'brief-cover.png')).to.equal(true);
    expect(picked).to.deep.equal([{ filename: 'brief-cover.png', currentTarget: null }]);
    expect(saved).to.deep.equal([{ blob, filename: 'brief-cover.png', target }]);
  });

  it('reports picker and save cancellation without claiming success', async () => {
    const blob = new Blob(['cover'], { type: 'image/png' });
    let saves = 0;
    const pickerCancelled = createCoverImageSaveOutput({
      async pickTarget() {
        return null;
      },
      async saveBlob() {
        saves += 1;
        return { id: 'unexpected' };
      },
    });

    expect(await pickerCancelled(blob, 'cover.png')).to.equal(false);
    expect(saves).to.equal(0);

    const saveCancelled = createCoverImageSaveOutput({
      async pickTarget() {
        return { id: 'cover' };
      },
      async saveBlob() {
        return null;
      },
    });
    expect(await saveCancelled(blob, 'cover.png')).to.equal(false);
  });

  it('routes dashboard image exports through the same host destination flow', async () => {
    const target = { grantId: 'dashboard-grant', displayPath: 'brief-dashboard.png' };
    const blob = new Blob(['dashboard'], { type: 'image/png' });
    const saved: Array<{ filename: string; target: typeof target | null | undefined }> = [];
    const saveOutput = createDashboardImageSaveOutput({
      async pickTarget() {
        return target;
      },
      async saveBlob(_blob, filename, saveTarget) {
        saved.push({ filename, target: saveTarget });
        return target;
      },
    });

    expect(await saveOutput(blob, 'brief-dashboard.png')).to.equal(true);
    expect(saved).to.deep.equal([{ filename: 'brief-dashboard.png', target }]);
  });

  it('exposes cover and dashboard names for the one shared adapter', () => {
    expect(createCoverImageSaveOutput).to.equal(createImageSaveOutput);
    expect(createDashboardImageSaveOutput).to.equal(createImageSaveOutput);
  });
});
