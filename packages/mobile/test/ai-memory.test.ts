import assert from 'node:assert/strict';
import { aiError } from '../src/ai/errors';
import { downloadFit } from '../src/ai/models';

// Errors as the Gezel transport hands them over: the native code and message.
function nativeError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe('mobile AI memory handling', () => {
  it('explains a reply the runtime stopped for memory, keeping its words as detail', () => {
    for (const message of [
      'The device ran low on memory, so the reply stopped early. Try again, or choose a smaller model if this keeps happening.',
      // Runtimes before the fix stopped on every memory warning with this.
      'The device is low on memory. The current model has been released.',
    ]) {
      const error = aiError(nativeError('RESOURCE_LIMIT', message));
      assert.equal(error.code, 'provider-unavailable');
      assert.match(error.message, /needed its memory back/u);
      assert.match(error.message, /Settings → AI assistance/u);
      assert.equal(error.detail, message);
    }
  });

  it('keeps an admission refusal, which already names its numbers', () => {
    const message =
      'There is not enough available memory for this model: it needs about 2.1 GB, and 1.4 GB is free. Choose a smaller model or close other apps.';
    assert.deepEqual(aiError(nativeError('RESOURCE_LIMIT', message)), {
      code: 'provider-unavailable',
      message,
    });
  });

  it('labels downloads with Gezel’s rating and offers none for a model too big to load', () => {
    const tight = { tier: 'tight' as const, label: 'tight on memory', detail: 'Fits, but…' };
    assert.deepEqual(downloadFit({ fit: tight }), tight);
    assert.equal(downloadFit({ fit: { ...tight, tier: 'too-big' } }), null);
    assert.equal(downloadFit({}), null);
  });
});
