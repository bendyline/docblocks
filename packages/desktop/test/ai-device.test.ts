import { expect } from 'chai';

import {
  automationDeviceFit,
  createAiDeviceProbe,
  type DeviceMemoryProfile,
} from '../main/ai/ai-device.js';

const GIB = 1024 ** 3;

function profile(overrides: Partial<DeviceMemoryProfile>): DeviceMemoryProfile {
  return { totalRamBytes: 32 * GIB, gpuVramBytes: null, gpuMemoryKind: 'none', ...overrides };
}

describe('AI device probe', () => {
  it("reads an Apple-silicon Mac's unified memory without asking Gezel", async () => {
    let asked = 0;
    const probe = createAiDeviceProbe({
      platform: 'darwin',
      arch: 'arm64',
      totalMemoryBytes: () => 16 * GIB,
      detectMemoryProfile: async () => {
        asked += 1;
        return profile({});
      },
    });
    expect(await probe()).to.deep.equal({ memory: 'unified', bytes: 16 * GIB, suggestAi: true });
    expect(asked).to.equal(0);
  });

  it('never suggests AI on an Intel Mac', async () => {
    const probe = createAiDeviceProbe({
      platform: 'darwin',
      arch: 'x64',
      totalMemoryBytes: () => 64 * GIB,
    });
    expect((await probe()).suggestAi).to.equal(false);
  });

  it("judges a PC by its graphics card's memory, not its system memory", async () => {
    const card = createAiDeviceProbe({
      platform: 'win32',
      detectMemoryProfile: async () =>
        profile({ gpuVramBytes: 8 * GIB, gpuMemoryKind: 'discrete' }),
    });
    expect(await card()).to.deep.equal({ memory: 'gpu', bytes: 8 * GIB, suggestAi: true });

    const small = createAiDeviceProbe({
      platform: 'win32',
      detectMemoryProfile: async () =>
        profile({ totalRamBytes: 64 * GIB, gpuVramBytes: 4 * GIB, gpuMemoryKind: 'discrete' }),
    });
    expect((await small()).suggestAi).to.equal(false);
  });

  it('counts a shared pool reported through the card as unified memory', async () => {
    const probe = createAiDeviceProbe({
      platform: 'linux',
      detectMemoryProfile: async () =>
        profile({ gpuVramBytes: 120 * GIB, gpuMemoryKind: 'unified' }),
    });
    expect(await probe()).to.deep.equal({ memory: 'unified', bytes: 120 * GIB, suggestAi: true });
  });

  it('never suggests AI on integrated graphics or system memory alone', async () => {
    for (const measured of [
      profile({ gpuVramBytes: 16 * GIB, gpuMemoryKind: 'integrated' }),
      profile({ totalRamBytes: 128 * GIB }),
    ]) {
      const probe = createAiDeviceProbe({
        platform: 'win32',
        detectMemoryProfile: async () => measured,
      });
      expect((await probe()).suggestAi, measured.gpuMemoryKind).to.equal(false);
    }
  });

  it('measures once and leaves an unmeasurable machine alone', async () => {
    let asked = 0;
    const probe = createAiDeviceProbe({
      platform: 'win32',
      detectMemoryProfile: async () => {
        asked += 1;
        throw new Error('nvidia-smi timed out');
      },
    });
    const [first, second] = await Promise.all([probe(), probe()]);
    expect(first).to.deep.equal({ memory: 'system', bytes: null, suggestAi: false });
    expect(second).to.equal(first);
    expect(await probe()).to.equal(first);
    expect(asked).to.equal(1);
  });
});

describe('AI device fit in automated runs', () => {
  it('answers what the run names, so a suite does not depend on its machine', () => {
    expect(automationDeviceFit('unified:32')).to.deep.equal({
      memory: 'unified',
      bytes: 32 * GIB,
      suggestAi: true,
    });
    expect(automationDeviceFit('gpu:6').suggestAi).to.equal(false);
  });

  it('is a machine AI is not suggested on unless the run says otherwise', () => {
    for (const value of [undefined, '', 'unified', 'tpu:64', 'gpu:-8', 'gpu:8GB']) {
      expect(automationDeviceFit(value), String(value)).to.deep.equal({
        memory: 'system',
        bytes: null,
        suggestAi: false,
      });
    }
  });
});
