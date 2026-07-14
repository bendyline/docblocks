import { expect } from 'chai';
import { BufferedEventChannel } from '../preload/buffered-event-channel.js';

describe('BufferedEventChannel', () => {
  it('delivers events published before the first renderer subscription in order', () => {
    const channel = new BufferedEventChannel<number>();
    channel.publish(1);
    channel.publish(2);

    const received: number[] = [];
    channel.subscribe((value) => received.push(value));
    channel.publish(3);

    expect(received).to.deep.equal([1, 2, 3]);
  });

  it('bounds an unsubscribed queue and retains the newest navigation requests', () => {
    const evicted: number[] = [];
    const channel = new BufferedEventChannel<number>(2, undefined, (value) => evicted.push(value));
    channel.publish(1);
    channel.publish(2);
    channel.publish(3);

    const received: number[] = [];
    const unsubscribe = channel.subscribe((value) => received.push(value));
    unsubscribe();
    channel.publish(4);
    channel.subscribe((value) => received.push(value));

    expect(received).to.deep.equal([2, 3, 4]);
    expect(evicted).to.deep.equal([1]);
  });

  it('does not let eviction cleanup failure break queue delivery', () => {
    const channel = new BufferedEventChannel<number>(1, undefined, () => {
      throw new Error('cleanup failed');
    });
    channel.publish(1);
    channel.publish(2);

    const received: number[] = [];
    channel.subscribe((value) => received.push(value));
    expect(received).to.deep.equal([2]);
  });

  it('preserves FIFO order when a listener publishes during backlog delivery', () => {
    const channel = new BufferedEventChannel<number>();
    channel.publish(1);
    channel.publish(2);

    const received: number[] = [];
    channel.subscribe((value) => {
      received.push(value);
      if (value === 1) channel.publish(3);
    });

    expect(received).to.deep.equal([1, 2, 3]);
  });

  it('isolates listener exceptions so later requests and listeners still run', () => {
    const errors: unknown[] = [];
    const channel = new BufferedEventChannel<number>(32, (error) => errors.push(error));
    const received: number[] = [];
    channel.subscribe(() => {
      throw new Error('broken renderer listener');
    });
    channel.subscribe((value) => received.push(value));

    channel.publish(1);
    channel.publish(2);

    expect(received).to.deep.equal([1, 2]);
    expect(errors).to.have.length(2);
  });

  it('rejects an invalid pending-event budget', () => {
    expect(() => new BufferedEventChannel(0)).to.throw(RangeError);
  });
});
