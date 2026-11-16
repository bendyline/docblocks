import assert from 'node:assert/strict';
import { IPHONE_MIN_LAYOUT_WIDTH, IPHONE_SCALE, iphoneViewportScale } from '../src/viewport-scale';

describe('iPhone viewport scale', () => {
  it('gives the large iPhones the full zoom', () => {
    // 14/15 Pro Max and Plus, 16 Pro Max.
    for (const [width, height] of [
      [430, 932],
      [440, 956],
    ]) {
      assert.equal(iphoneViewportScale(width, height), IPHONE_SCALE);
    }
  });

  it('zooms narrower iPhones only as far as the minimum layout width', () => {
    assert.equal(iphoneViewportScale(393, 852), 1.228);
    assert.equal(iphoneViewportScale(390, 844), 1.218);
    assert.equal(iphoneViewportScale(375, 667), 1.171);
  });

  it('never lays out below the minimum width', () => {
    for (let width = 320; width <= 460; width += 1) {
      const scale = iphoneViewportScale(width, 900);
      assert.ok(width / scale >= IPHONE_MIN_LAYOUT_WIDTH, `${width}pt at ${scale}`);
      assert.ok(scale >= 1 && scale <= IPHONE_SCALE);
    }
  });

  it('uses the short edge, so rotation does not change it', () => {
    assert.equal(iphoneViewportScale(932, 430), iphoneViewportScale(430, 932));
  });

  it('falls back to no zoom when the screen reports nothing', () => {
    assert.equal(iphoneViewportScale(0, 0), 1);
    assert.equal(iphoneViewportScale(Number.NaN, 932), 1);
  });
});
