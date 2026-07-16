import { expect } from 'chai';
import {
  VscodeWebviewRecovery,
  type VscodeWebviewStateApi,
} from '../webview/src/webviewRecovery.js';

class MemoryWebviewState implements VscodeWebviewStateApi {
  public state: unknown;

  public getState(): unknown {
    return this.state;
  }

  public setState(state: unknown): void {
    this.state = state;
  }
}

describe('VS Code webview crash recovery', () => {
  it('restores an unacknowledged complete snapshot only onto its exact durable baseline', () => {
    const state = new MemoryWebviewState();
    const firstRenderer = new VscodeWebviewRecovery(state);
    expect(firstRenderer.beginSession('durable', true)).to.deep.equal({ kind: 'clean' });
    expect(firstRenderer.recordEdit(1, 'recover me')).to.equal(true);

    const replacementRenderer = new VscodeWebviewRecovery(state);
    expect(replacementRenderer.beginSession('durable', true)).to.deep.equal({
      kind: 'restore',
      content: 'recover me',
    });
  });

  it('surfaces a changed durable baseline as a conflict instead of overwriting it', () => {
    const state = new MemoryWebviewState();
    const firstRenderer = new VscodeWebviewRecovery(state);
    firstRenderer.beginSession('old durable', true);
    firstRenderer.recordEdit(1, 'recover me');

    const replacementRenderer = new VscodeWebviewRecovery(state);
    expect(replacementRenderer.beginSession('externally changed', true)).to.deep.equal({
      kind: 'conflict',
      content: 'recover me',
    });
  });

  it('keeps the snapshot through host acceptance and removes it only after persistence', () => {
    const state = new MemoryWebviewState();
    const renderer = new VscodeWebviewRecovery(state);
    renderer.beginSession('durable', true);
    renderer.recordEdit(1, 'pending');
    renderer.acknowledgeEdit(1, 4);
    expect(renderer.acknowledgePersisted(3)).to.equal(false);

    const beforeSave = new VscodeWebviewRecovery(state);
    expect(beforeSave.beginSession('durable', true).kind).to.equal('restore');

    // Recreate the active renderer state and acknowledge the matching commit.
    renderer.beginSession('durable', true);
    renderer.recordEdit(1, 'pending');
    renderer.acknowledgeEdit(1, 4);
    expect(renderer.acknowledgePersisted(4)).to.equal(true);

    const afterSave = new VscodeWebviewRecovery(state);
    expect(afterSave.beginSession('pending', true)).to.deep.equal({ kind: 'clean' });
  });

  it('drops stale recovery when a newer snapshot exceeds its bounded state budget', () => {
    const state = new MemoryWebviewState();
    const renderer = new VscodeWebviewRecovery(state, {
      maxRecordBytes: 1_024,
      maxStorageBytes: 2_048,
    });
    renderer.beginSession('base', true);
    expect(renderer.recordEdit(1, 'small')).to.equal(true);
    expect(renderer.recordEdit(2, 'x'.repeat(10_000))).to.equal(false);

    const replacement = new VscodeWebviewRecovery(state);
    expect(replacement.beginSession('base', true)).to.deep.equal({ kind: 'clean' });
  });
});
