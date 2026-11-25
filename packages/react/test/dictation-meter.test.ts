import { expect } from 'chai';
import {
  DICTATION_METER_BARS,
  meterLevel,
  pushMeterLevel,
  SILENT_METER,
} from '../src/Speech/dictation-meter.js';

describe('dictation meter', () => {
  it('scales speech-level RMS into 0–1 bars, clamped', () => {
    expect(meterLevel(0)).to.equal(0);
    expect(meterLevel(0.05)).to.be.closeTo(0.7, 1e-9);
    expect(meterLevel(0.5)).to.equal(1);
    expect(meterLevel(-0.1)).to.equal(0);
  });

  it('rolls: the newest level enters on the right and the oldest drops off', () => {
    expect(SILENT_METER).to.have.length(DICTATION_METER_BARS);
    let levels = SILENT_METER;
    for (let step = 1; step <= DICTATION_METER_BARS + 2; step += 1) {
      levels = pushMeterLevel(levels, step / 140);
    }
    expect(levels).to.have.length(DICTATION_METER_BARS);
    expect(levels[0]).to.be.closeTo(0.3, 1e-9);
    expect(levels.at(-1)).to.equal(1);
    expect(SILENT_METER.every((level) => level === 0)).to.equal(true);
  });
});
