import { performance } from 'node:perf_hooks';
import { expect } from 'chai';
import { computeBlockSourceRanges } from '../src/mcp/intelligence.js';

describe('MCP intelligence cancellation and scaling', function () {
  this.timeout(10_000);

  it('computes a large heading range set in linear time', async () => {
    const blockCount = 50_000;
    const blocks = headingBlocks(blockCount);
    const startedAt = performance.now();

    const ranges = await computeBlockSourceRanges(blocks, blockCount * 2);

    expect(performance.now() - startedAt).to.be.lessThan(5_000);
    expect(ranges).to.have.length(blockCount);
    expect(ranges[0]).to.deep.equal({ start: 0, end: 2 });
    expect(ranges[Math.floor(blockCount / 2)]).to.deep.equal({
      start: Math.floor(blockCount / 2) * 2,
      end: Math.floor(blockCount / 2) * 2 + 2,
    });
    expect(ranges[blockCount - 1]).to.deep.equal({
      start: (blockCount - 1) * 2,
      end: blockCount * 2,
    });
  });

  it('preserves the exact cancellation reason after a large range pass has started', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel intelligence range analysis');
    const pending = computeBlockSourceRanges(headingBlocks(50_000), 100_000, controller.signal);

    setImmediate(() => setImmediate(() => controller.abort(reason)));

    let caught: unknown;
    try {
      await pending;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.equal(reason);
  });
});

function headingBlocks(count: number): Parameters<typeof computeBlockSourceRanges>[0] {
  return Array.from({ length: count }, (_unused, index) => ({
    sourceHeading: {
      position: {
        start: { line: index + 1, column: 1, offset: index * 2 },
        end: { line: index + 1, column: 2, offset: index * 2 + 1 },
      },
    },
  })) as Parameters<typeof computeBlockSourceRanges>[0];
}
