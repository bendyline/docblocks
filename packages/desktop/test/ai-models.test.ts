import { expect } from 'chai';
import { AI_WIRE_LIMITS, parseAiModelInfoList } from '@bendyline/docblocks/host';

import { selectModel, toAiModelList } from '../main/ai/ai-models.js';
import { aiError, AiHostError, toAiError } from '../main/ai/ai-errors.js';

describe('desktop AI model listing', () => {
  it('labels gezels and provider models, and marks the fallback as default', () => {
    const models = toAiModelList([
      { id: 'gezel:router', owned_by: 'gezel', name: 'Meester', role: 'router' },
      { id: 'gezel:writer', owned_by: 'gezel', name: 'Writer', role: 'writer', is_fallback: true },
      { id: 'llama-cpp:qwen3-4b', owned_by: 'llama-cpp', context_window: 32_768 },
      { id: 'anthropic:claude-sonnet-5', owned_by: 'anthropic', context_window: 200_000 },
    ]);
    expect(models).to.deep.equal([
      {
        id: 'gezel:router',
        label: 'Meester (router)',
        local: false,
        contextWindow: null,
        isDefault: false,
      },
      { id: 'gezel:writer', label: 'Writer', local: false, contextWindow: null, isDefault: true },
      {
        id: 'llama-cpp:qwen3-4b',
        label: 'qwen3-4b · llama-cpp',
        local: true,
        contextWindow: 32_768,
        isDefault: false,
      },
      {
        id: 'anthropic:claude-sonnet-5',
        label: 'claude-sonnet-5 · anthropic',
        local: false,
        contextWindow: 200_000,
        isDefault: false,
      },
    ]);
    // Whatever the provider sends, the result must cross the wire.
    expect(parseAiModelInfoList(models)).to.deep.equal(models);
  });

  it('claims on-device only for engines that run locally', () => {
    const local = toAiModelList([
      { id: 'mlx:gemma4-e4b', owned_by: 'mlx' },
      { id: 'ollama:llama3.1:8b', owned_by: 'ollama' },
      { id: 'copilot:gpt-5', owned_by: 'copilot' },
    ]).map((model) => [model.id, model.local]);
    expect(local).to.deep.equal([
      ['mlx:gemma4-e4b', true],
      ['ollama:llama3.1:8b', true],
      ['copilot:gpt-5', false],
    ]);
  });

  it('defaults to the first entry when the provider names no fallback', () => {
    const models = toAiModelList([{ id: 'llama-cpp:a' }, { id: 'llama-cpp:b' }]);
    expect(models.map((model) => model.isDefault)).to.deep.equal([true, false]);
  });

  it('drops entries that cannot cross the wire, duplicates, and anything past the cap', () => {
    const models = toAiModelList([
      { id: '' },
      { id: 'x'.repeat(300) },
      { id: 'bad\0id' },
      { id: 'llama-cpp:a', context_window: -1 },
      { id: 'llama-cpp:a' },
      ...Array.from({ length: AI_WIRE_LIMITS.modelEntries + 5 }, (_, index) => ({
        id: `llama-cpp:m${index}`,
      })),
    ]);
    expect(models).to.have.length(AI_WIRE_LIMITS.modelEntries);
    expect(models[0]).to.deep.include({ id: 'llama-cpp:a', contextWindow: null });
    expect(parseAiModelInfoList(models)).to.not.equal(null);
  });

  it('selects the preference when offered, else the default', () => {
    const models = toAiModelList([
      { id: 'gezel:writer', owned_by: 'gezel', name: 'Writer', is_fallback: true },
      { id: 'llama-cpp:a' },
    ]);
    expect(selectModel(models, 'llama-cpp:a')?.id).to.equal('llama-cpp:a');
    expect(selectModel(models, 'llama-cpp:gone')?.id).to.equal('gezel:writer');
    expect(selectModel(models, null)?.id).to.equal('gezel:writer');
    expect(selectModel([], 'llama-cpp:a')).to.equal(null);
  });
});

describe('desktop AI error mapping', () => {
  const codeOf = (error: unknown) => toAiError(error).code;
  const sdk = (code: string, status?: number) =>
    Object.assign(new Error(`provider: ${code}`), { code, ...(status ? { status } : {}) });

  it('maps provider codes onto the host vocabulary', () => {
    expect(codeOf(sdk('daemon_not_running'))).to.equal('provider-unavailable');
    expect(codeOf(sdk('user_denied'))).to.equal('approval-denied');
    expect(codeOf(sdk('approval_timeout'))).to.equal('approval-timeout');
    expect(codeOf(sdk('grant_expired'))).to.equal('approval-expired');
    expect(codeOf(sdk('verification_code_handler_required'))).to.equal('approval-required');
    expect(codeOf(sdk('missing_scope:openai', 403))).to.equal('approval-required');
    expect(codeOf(sdk('already_connected', 409))).to.equal('already-connected');
    expect(codeOf(sdk('openai_endpoints_disabled', 403))).to.equal('inference-disabled');
    expect(codeOf(sdk('model_not_found', 404))).to.equal('model-unavailable');
    expect(codeOf(sdk('ERR_MODULE_NOT_FOUND'))).to.equal('runtime-missing');
  });

  it('falls back to HTTP status, network failures, and aborts', () => {
    expect(codeOf(Object.assign(new Error('HTTP 429'), { status: 429 }))).to.equal('rate-limited');
    expect(codeOf(Object.assign(new Error('HTTP 401'), { status: 401 }))).to.equal(
      'approval-required',
    );
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(codeOf(refused)).to.equal('provider-unavailable');
    expect(codeOf(Object.assign(new Error('aborted'), { name: 'AbortError' }))).to.equal(
      'cancelled',
    );
    expect(codeOf(new Error('something else'))).to.equal('unknown');
    expect(codeOf('not even an error')).to.equal('unknown');
  });

  it('shows the user a written sentence and keeps the provider text as detail', () => {
    const error = toAiError(sdk('user_denied'));
    expect(error.message).to.equal('The connection was declined in Gezel.');
    expect(error.detail).to.equal('provider: user_denied');
    expect(toAiError(new AiHostError('timeout', 'Gezel stopped responding.'))).to.deep.equal({
      code: 'timeout',
      message: 'Gezel stopped responding.',
    });
  });

  it('bounds and cleans text so the error always crosses the wire', () => {
    const error = aiError('unknown', 'a\0b', 'd'.repeat(5_000));
    expect(error.message).to.equal('ab');
    expect(error.detail).to.have.length(2_000);
  });
});
