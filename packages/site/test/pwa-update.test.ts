import { expect } from 'chai';
import {
  reloadOnServiceWorkerActivation,
  type ServiceWorkerActivationSource,
} from '../src/pwa-update.js';

class FakeServiceWorker implements ServiceWorkerActivationSource {
  public state: ServiceWorkerState = 'installed';
  private readonly listeners = new Set<EventListener>();

  public addEventListener(type: 'statechange', listener: EventListener): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  public removeEventListener(type: 'statechange', listener: EventListener): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  public transitionTo(state: ServiceWorkerState): void {
    this.state = state;
    const event = new Event('statechange');
    for (const listener of this.listeners) listener(event);
  }
}

describe('PWA update activation', () => {
  it('reloads exactly once when a waiting worker activates', () => {
    const worker = new FakeServiceWorker();
    let reloads = 0;

    reloadOnServiceWorkerActivation(worker, () => {
      reloads += 1;
    });

    worker.transitionTo('activating');
    expect(reloads).to.equal(0);
    worker.transitionTo('activated');
    worker.transitionTo('redundant');
    expect(reloads).to.equal(1);
  });

  it('reloads immediately if activation won the prompt-click race', () => {
    const worker = new FakeServiceWorker();
    worker.transitionTo('activated');
    let reloads = 0;

    reloadOnServiceWorkerActivation(worker, () => {
      reloads += 1;
    });

    expect(reloads).to.equal(1);
  });

  it('can stop waiting for a worker that never activates', () => {
    const worker = new FakeServiceWorker();
    let reloads = 0;
    const stopListening = reloadOnServiceWorkerActivation(worker, () => {
      reloads += 1;
    });

    stopListening();
    worker.transitionTo('activated');
    expect(reloads).to.equal(0);
  });
});
