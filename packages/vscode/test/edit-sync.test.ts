import { expect } from 'chai';
import { withApplyingEditFlag } from '../src/editSync.js';
import {
  createDebouncedEditPoster,
  type WebviewPostMessage,
} from '../webview/src/debouncedEditPoster.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VS Code edit sync', () => {
  it('flushes the latest pending webview edit on dispose', () => {
    const messages: Parameters<WebviewPostMessage>[0][] = [];
    const poster = createDebouncedEditPoster((message) => messages.push(message), 1_000);

    poster.schedule('first edit');
    poster.schedule('latest edit');
    poster.dispose();

    expect(messages).to.deep.equal([{ type: 'edit', content: 'latest edit' }]);
  });

  it('does not duplicate an edit flushed by the debounce timer', async () => {
    const messages: Parameters<WebviewPostMessage>[0][] = [];
    const poster = createDebouncedEditPoster((message) => messages.push(message), 5);

    poster.schedule('saved by timer');
    await wait(20);
    poster.dispose();

    expect(messages).to.deep.equal([{ type: 'edit', content: 'saved by timer' }]);
  });

  it('resets the host applying-edit guard after applyEdit fails', async () => {
    const flagTransitions: boolean[] = [];
    let thrown: unknown;

    try {
      await withApplyingEditFlag(
        (isApplying) => flagTransitions.push(isApplying),
        async () => {
          throw new Error('apply failed');
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(flagTransitions).to.deep.equal([true, false]);
  });
});
