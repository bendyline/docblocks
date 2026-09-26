import { expect } from 'chai';
import {
  AI_WIRE_LIMITS,
  parseAiChatEvent,
  parseAiChatRequest,
  parseAiError,
  parseAiModelInfoList,
  parseAiPreferences,
  parseAiPreferencesPatch,
  parseAiProgress,
  parseAiStatus,
} from '../src/host/ai-wire-policy.js';

const VALID_REQUEST = Object.freeze({
  messages: [{ role: 'user', content: 'Draft an intro.' }],
  purpose: 'write',
});

describe('parseAiChatRequest', () => {
  it('accepts a minimal request and drops nothing', () => {
    expect(parseAiChatRequest({ ...VALID_REQUEST })).to.deep.equal({
      messages: [{ role: 'user', content: 'Draft an intro.' }],
      purpose: 'write',
    });
  });

  it('accepts the optional tuning fields', () => {
    expect(
      parseAiChatRequest({
        ...VALID_REQUEST,
        model: 'provider:small',
        temperature: 0.2,
        maxTokens: 512,
      }),
    ).to.deep.equal({
      messages: [{ role: 'user', content: 'Draft an intro.' }],
      purpose: 'write',
      model: 'provider:small',
      temperature: 0.2,
      maxTokens: 512,
    });
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(parseAiChatRequest({ ...VALID_REQUEST, systemPrompt: 'x' })).to.equal(null);
  });

  it('rejects an unknown role or purpose', () => {
    expect(
      parseAiChatRequest({ ...VALID_REQUEST, messages: [{ role: 'tool', content: 'x' }] }),
    ).to.equal(null);
    expect(parseAiChatRequest({ ...VALID_REQUEST, purpose: 'summarise' })).to.equal(null);
  });

  it('rejects an empty or oversized message list', () => {
    expect(parseAiChatRequest({ ...VALID_REQUEST, messages: [] })).to.equal(null);
    const many = Array.from({ length: AI_WIRE_LIMITS.messageEntries + 1 }, () => ({
      role: 'user',
      content: 'x',
    }));
    expect(parseAiChatRequest({ ...VALID_REQUEST, messages: many })).to.equal(null);
  });

  it('bounds the summed prompt, not only each message', () => {
    // Several messages each just under the per-message cap would be a multiple
    // of the budget. The total is what protects the provider.
    const chunk = 'a'.repeat(AI_WIRE_LIMITS.promptCharacters - 1);
    expect(
      parseAiChatRequest({
        ...VALID_REQUEST,
        messages: [
          { role: 'user', content: chunk },
          { role: 'user', content: 'bb' },
        ],
      }),
    ).to.equal(null);
  });

  it('rejects a NUL byte smuggled into content', () => {
    const smuggled = 'a' + String.fromCharCode(0) + 'b';
    expect(
      parseAiChatRequest({ ...VALID_REQUEST, messages: [{ role: 'user', content: smuggled }] }),
    ).to.equal(null);
  });

  it('rejects out-of-range or non-finite tuning values', () => {
    expect(parseAiChatRequest({ ...VALID_REQUEST, temperature: -0.1 })).to.equal(null);
    expect(
      parseAiChatRequest({ ...VALID_REQUEST, temperature: AI_WIRE_LIMITS.temperatureCeiling + 1 }),
    ).to.equal(null);
    expect(parseAiChatRequest({ ...VALID_REQUEST, temperature: Number.NaN })).to.equal(null);
    expect(parseAiChatRequest({ ...VALID_REQUEST, maxTokens: 1.5 })).to.equal(null);
    expect(
      parseAiChatRequest({ ...VALID_REQUEST, maxTokens: AI_WIRE_LIMITS.maxTokensCeiling + 1 }),
    ).to.equal(null);
  });

  it('rejects non-objects and arrays', () => {
    expect(parseAiChatRequest(null)).to.equal(null);
    expect(parseAiChatRequest('draft')).to.equal(null);
    expect(parseAiChatRequest([VALID_REQUEST])).to.equal(null);
  });
});

describe('parseAiChatEvent', () => {
  it('accepts a delta', () => {
    expect(parseAiChatEvent({ kind: 'delta', text: 'Once' })).to.deep.equal({
      kind: 'delta',
      text: 'Once',
    });
  });

  it('rejects an oversized delta', () => {
    const text = 'a'.repeat(AI_WIRE_LIMITS.deltaCharacters + 1);
    expect(parseAiChatEvent({ kind: 'delta', text })).to.equal(null);
  });

  it('accepts a completion with and without usage', () => {
    const base = { text: 'done', model: 'm', finishReason: 'stop' };
    expect(parseAiChatEvent({ kind: 'done', completion: { ...base, usage: null } })).to.deep.equal({
      kind: 'done',
      completion: { ...base, usage: null },
    });
    expect(
      parseAiChatEvent({
        kind: 'done',
        completion: { ...base, usage: { promptTokens: 10, completionTokens: 4 } },
      }),
    ).to.deep.equal({
      kind: 'done',
      completion: { ...base, usage: { promptTokens: 10, completionTokens: 4 } },
    });
  });

  it('rejects an unknown finish reason or a partial usage record', () => {
    expect(
      parseAiChatEvent({
        kind: 'done',
        completion: { text: 'x', model: 'm', finishReason: 'filtered', usage: null },
      }),
    ).to.equal(null);
    expect(
      parseAiChatEvent({
        kind: 'done',
        completion: { text: 'x', model: 'm', finishReason: 'stop', usage: { promptTokens: 1 } },
      }),
    ).to.equal(null);
  });

  it('accepts an error event and rejects an unknown code', () => {
    expect(
      parseAiChatEvent({ kind: 'error', error: { code: 'timeout', message: 'slow' } }),
    ).to.deep.equal({ kind: 'error', error: { code: 'timeout', message: 'slow' } });
    expect(parseAiChatEvent({ kind: 'error', error: { code: 'teapot', message: 'x' } })).to.equal(
      null,
    );
  });

  it('rejects an unknown event kind', () => {
    expect(parseAiChatEvent({ kind: 'progress', percent: 10 })).to.equal(null);
  });
});

describe('parseAiStatus', () => {
  it('accepts each unavailable reason', () => {
    const reasons = [
      'opt-out',
      'platform-unsupported',
      'not-installed',
      'not-running',
      'disconnected',
    ];
    for (const reason of reasons) {
      expect(parseAiStatus({ kind: 'unavailable', reason })).to.deep.equal({
        kind: 'unavailable',
        reason,
      });
    }
    expect(parseAiStatus({ kind: 'unavailable', reason: 'bored' })).to.equal(null);
  });

  it('accepts connecting with a verification code and with progress', () => {
    expect(
      parseAiStatus({
        kind: 'connecting',
        step: 'awaiting-approval',
        verificationCode: 'AB12CD',
        progress: null,
      }),
    ).to.deep.equal({
      kind: 'connecting',
      step: 'awaiting-approval',
      verificationCode: 'AB12CD',
      progress: null,
    });
    expect(
      parseAiStatus({
        kind: 'connecting',
        step: 'preparing-model',
        verificationCode: null,
        progress: { phase: 'weights', message: 'Downloading', percent: 42 },
      }),
    ).to.not.equal(null);
  });

  it('rejects an oversized verification code', () => {
    expect(
      parseAiStatus({
        kind: 'connecting',
        step: 'awaiting-approval',
        verificationCode: 'x'.repeat(AI_WIRE_LIMITS.verificationCodeCharacters + 1),
        progress: null,
      }),
    ).to.equal(null);
  });

  it('accepts ready and rejects a malformed provider', () => {
    expect(
      parseAiStatus({
        kind: 'ready',
        provider: { name: 'Local', version: null, mode: 'hosted' },
        model: null,
        activeRequests: 0,
      }),
    ).to.deep.equal({
      kind: 'ready',
      provider: { name: 'Local', version: null, mode: 'hosted' },
      model: null,
      activeRequests: 0,
    });
    expect(
      parseAiStatus({
        kind: 'ready',
        provider: { name: 'Local', version: null, mode: 'telepathy' },
        model: null,
        activeRequests: 0,
      }),
    ).to.equal(null);
  });

  it('rejects a missing or extra key', () => {
    expect(parseAiStatus({ kind: 'unavailable' })).to.equal(null);
    expect(parseAiStatus({ kind: 'unavailable', reason: 'opt-out', extra: 1 })).to.equal(null);
  });
});

describe('parseAiProgress', () => {
  it('accepts a measured and an unmeasured phase', () => {
    expect(parseAiProgress({ phase: 'weights', message: 'x', percent: 0 })).to.not.equal(null);
    expect(parseAiProgress({ phase: 'engine', message: 'x', percent: null })).to.not.equal(null);
  });

  it('rejects an out-of-range percentage and an empty phase', () => {
    expect(parseAiProgress({ phase: 'weights', message: 'x', percent: 101 })).to.equal(null);
    expect(parseAiProgress({ phase: '', message: 'x', percent: null })).to.equal(null);
  });
});

describe('parseAiModelInfoList', () => {
  const model = { id: 'm', label: 'Small', local: true, contextWindow: 4096, isDefault: true };

  it('accepts a list and a null context window', () => {
    expect(parseAiModelInfoList([model])).to.deep.equal([model]);
    expect(parseAiModelInfoList([{ ...model, contextWindow: null }])).to.not.equal(null);
  });

  it('rejects the whole list when one entry is malformed', () => {
    // Partial acceptance would hide a contract break behind a shorter picker
    // rather than surfacing it.
    expect(parseAiModelInfoList([model, { ...model, local: 'yes' }])).to.equal(null);
  });

  it('rejects a list past the cap and a non-array', () => {
    const many = Array.from({ length: AI_WIRE_LIMITS.modelEntries + 1 }, () => model);
    expect(parseAiModelInfoList(many)).to.equal(null);
    expect(parseAiModelInfoList('models')).to.equal(null);
  });
});

describe('parseAiPreferences', () => {
  it('round-trips a full record', () => {
    const value = { enabled: true, model: 'm', reviewMode: 'implicit' };
    expect(parseAiPreferences(value)).to.deep.equal(value);
  });

  it('rejects an unknown review mode or a missing key', () => {
    expect(parseAiPreferences({ enabled: true, model: null, reviewMode: 'always' })).to.equal(null);
    expect(parseAiPreferences({ enabled: true, model: null })).to.equal(null);
  });
});

describe('parseAiPreferencesPatch', () => {
  it('accepts an empty patch as "change nothing"', () => {
    expect(parseAiPreferencesPatch({})).to.deep.equal({});
  });

  it('accepts a single field and preserves an explicit null model', () => {
    expect(parseAiPreferencesPatch({ enabled: false })).to.deep.equal({ enabled: false });
    expect(parseAiPreferencesPatch({ model: null })).to.deep.equal({ model: null });
  });

  it('rejects an unknown key or a wrongly typed field', () => {
    expect(parseAiPreferencesPatch({ enable: true })).to.equal(null);
    expect(parseAiPreferencesPatch({ enabled: 'yes' })).to.equal(null);
  });
});

describe('parseAiError', () => {
  it('keeps an optional detail out of the result when absent', () => {
    expect(parseAiError({ code: 'unknown', message: 'x' })).to.deep.equal({
      code: 'unknown',
      message: 'x',
    });
  });

  it('rejects an unknown code', () => {
    expect(parseAiError({ code: 'nope', message: 'x' })).to.equal(null);
  });
});
