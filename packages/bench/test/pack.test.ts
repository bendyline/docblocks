import { expect } from 'chai';
import type { BenchCaseOutcome } from '../src/contract.js';
import type { EndpointOptions } from '../src/endpoint.js';
import { endpointContextWindow } from '../src/endpoint.js';
import { describePack, findTask } from '../src/pack.js';
import { runCase } from '../src/run.js';

interface SentBody {
  readonly model: string;
  readonly messages: readonly { role: string; content: string }[];
  readonly reasoning_effort?: string;
  readonly seed?: number;
  readonly response_format?: { json_schema?: { name?: string } };
}

/** A streamed reply: these text deltas, then a finish reason and usage. */
interface Streamed {
  readonly chunks: readonly string[];
  readonly finish?: 'stop' | 'length';
  /** End the stream as Gezel ends a failed one, with `{ error }` and no finish reason. */
  readonly error?: { readonly code: string; readonly message: string };
}

type Responder = (body: SentBody, index: number) => string | Streamed | { status: number } | Error;

/** Server-sent events for `reply`, delivered in awkward 7-byte pieces. */
function eventStream(reply: Streamed): Response {
  const events = [
    ...reply.chunks.map((content) => ({ choices: [{ delta: { content } }] })),
    ...(reply.error
      ? [{ error: { ...reply.error, type: 'server_error' } }]
      : [
          { choices: [{ delta: {}, finish_reason: reply.finish ?? 'stop' }] },
          {
            choices: [],
            usage: { prompt_tokens: 120, completion_tokens: 60 },
            gezel_max_tokens: 4096,
          },
        ]),
  ];
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A fetch that answers chat completions from `respond` and records what was sent. */
function fakeEndpoint(respond: Responder, contextWindow: number | null = 32_768) {
  const sent: SentBody[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as SentBody;
    sent.push(body);
    const reply = respond(body, sent.length - 1);
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'object' && 'chunks' in reply) return eventStream(reply);
    if (typeof reply !== 'string') {
      return new Response('engine unavailable', { status: reply.status });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const endpoint: Omit<EndpointOptions, 'seed'> = {
    baseUrl: 'http://bench.test/v1',
    model: 'llama-cpp:test-model',
    contextWindow,
    requestTimeoutMs: 5_000,
    fetch: fetchImpl,
    AbortController,
  };
  return { endpoint, sent };
}

const NOW = new Date(2026, 10, 10);

async function run(
  taskId: string,
  caseId: string,
  respond: Responder,
  contextWindow?: number | null,
): Promise<{ outcome: BenchCaseOutcome; sent: SentBody[] }> {
  const task = findTask(taskId);
  if (!task) throw new Error(`no task ${taskId}`);
  const { endpoint, sent } = fakeEndpoint(respond, contextWindow);
  const outcome = await runCase(task, caseId, { endpoint, seed: 7, trial: 0, now: NOW });
  return { outcome, sent };
}

function finding(quote: string, message: string, replacement: string | null): unknown {
  return {
    quote,
    replacement,
    category: 'Impact',
    severity: 'suggestion',
    message,
    rationale: null,
  };
}

describe('docbench pack', () => {
  it('describes every task with cases, a judge and scoring that sums to one', () => {
    const manifest = describePack();
    expect(manifest.schemaVersion).to.equal(1);
    const weights = manifest.families.reduce((sum, family) => sum + family.weight, 0);
    expect(weights).to.be.closeTo(1, 1e-9);
    for (const task of manifest.tasks) {
      expect(task.cases.length, task.id).to.be.greaterThan(0);
      expect(task.scoring.checks + task.scoring.judge, task.id).to.be.closeTo(1, 1e-9);
      expect(manifest.families.map((family) => family.id)).to.include(task.family);
      expect(new Set(task.cases.map((item) => item.id)).size, task.id).to.equal(task.cases.length);
    }
  });

  describe('review-resume', () => {
    it('sends the product request: no reasoning, the pinned date, a seed', async () => {
      const { sent } = await run('review-resume', 'junior-developer', () => '[]');
      expect(sent).to.have.length(1);
      expect(sent[0]?.reasoning_effort).to.equal('none');
      expect(sent[0]?.seed).to.equal(7);
      expect(sent[0]?.model).to.equal('llama-cpp:test-model');
      expect(sent[0]?.messages[0]?.content).to.include('Current local date: 2026-11-10');
      expect(sent[0]?.messages[0]?.content).to.include('Review this document as a resume');
    });

    it('scores a real review on its checks and hands its findings to the matcher', async () => {
      const { outcome } = await run('review-resume', 'junior-developer', () =>
        JSON.stringify([
          finding(
            'Responsible for maintaining the internal reporting dashboard.',
            'Lead with what you achieved, not the duty.',
            'Maintained the internal reporting dashboard used by the sales team.',
          ),
          finding('References available upon request.', 'Remove this dated line.', ''),
        ]),
      );
      expect(outcome.usable).to.equal(true);
      expect(outcome.error).to.equal(null);
      expect(outcome.checks.every((item) => item.score === 1)).to.equal(true);
      expect(outcome.judgeInput?.answerKey).to.have.length(9);
      expect(outcome.judgeInput?.items).to.have.length(2);
      expect(outcome.judgeInput?.context).to.include('<document>');
      expect(outcome.calls).to.have.length(1);
      expect(outcome.calls[0]?.completionTokens).to.equal(50);
    });

    it('lets a useless but well-formed review through for the judge to mark trivial', async () => {
      const { outcome } = await run('review-resume', 'data-analyst-strong', () =>
        JSON.stringify([
          finding('Strong team player.', 'This is a correct sentence.', 'Strong team player.'),
        ]),
      );
      expect(outcome.usable).to.equal(true);
      const change = outcome.checks.find((item) => item.id === 'replacements-change');
      expect(change?.score).to.equal(0);
      expect(outcome.judgeInput?.items?.[0]?.text).to.include('This is a correct sentence.');
    });

    it('marks a review the panel cannot read as not usable, the model at fault', async () => {
      const { outcome } = await run(
        'review-resume',
        'registered-nurse',
        () => 'This resume looks great! Nice work.',
      );
      expect(outcome.usable).to.equal(false);
      expect(outcome.error?.class).to.equal('model');
      expect(outcome.judgeInput).to.equal(null);
    });

    it('blames the endpoint, not the model, for a failed request', async () => {
      const refused = await run('review-resume', 'marketing-manager', () => ({ status: 503 }));
      expect(refused.outcome.usable).to.equal(false);
      expect(refused.outcome.error?.class).to.equal('infra');
      const dropped = await run(
        'review-resume',
        'marketing-manager',
        () => new Error('connect ECONNREFUSED'),
      );
      expect(dropped.outcome.error?.class).to.equal('infra');
      expect(dropped.outcome.error?.message).to.include('ECONNREFUSED');
    });
  });

  describe('illustration-svg', () => {
    const svg =
      '<svg viewBox="0 0 640 360"><title>Water cycle</title>' +
      '<circle cx="320" cy="180" r="100" fill="none" stroke="currentColor"/>' +
      '<text x="300" y="60" fill="currentColor">Evaporation</text></svg>';

    it('keeps a picture the product would insert, as a standalone SVG', async () => {
      const { outcome } = await run(
        'illustration-svg',
        'the-water-cycle-evaporation-condensation',
        () => svg,
      );
      expect(outcome.usable, JSON.stringify(outcome.notes)).to.equal(true);
      expect(outcome.artifact?.kind).to.equal('svg');
      expect(outcome.artifact?.content).to.match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
      expect(outcome.judgeInput?.rubricId).to.equal('illustration-vision@1');
      expect(outcome.checks.find((item) => item.id === 'first-try')?.score).to.equal(1);
    });

    it('scores nothing when the model never returns an SVG', async () => {
      const { outcome, sent } = await run(
        'illustration-svg',
        'the-water-cycle-evaporation-condensation',
        () => 'I cannot draw pictures.',
      );
      expect(outcome.usable).to.equal(false);
      expect(outcome.error?.class).to.equal('model');
      // The product repairs once.
      expect(sent).to.have.length(2);
    });

    it('is not offered to a model with a small context window', async () => {
      const { outcome, sent } = await run(
        'illustration-svg',
        'the-water-cycle-evaporation-condensation',
        () => svg,
        8_192,
      );
      expect(sent).to.have.length(0);
      expect(outcome.usable).to.equal(false);
      expect(outcome.error?.message).to.match(/16K/u);
    });
  });

  describe('presentation-slides', () => {
    it('keeps the automatic deck, unusable, when no reply can be read', async () => {
      const { outcome, sent } = await run('presentation-slides', 'how-rain-is-made', () => 'nope');
      expect(sent.length).to.be.greaterThan(0);
      expect(outcome.usable).to.equal(false);
      expect(outcome.error?.class).to.equal('model');
      const taken = outcome.checks.find((item) => item.id === 'suggestions-taken');
      expect(taken?.score).to.equal(0);
      expect(outcome.checks.find((item) => item.id === 'deck-draws')?.score).to.equal(1);
    });

    it('asks for structured output', async () => {
      const { sent } = await run('presentation-slides', 'quarterly-review', () => '{}');
      expect(sent.some((body) => body.response_format?.json_schema?.name)).to.equal(true);
    });
  });

  describe('the endpoint transport', () => {
    it('streams, as the desktop does, and reads the streamed reply and its usage', async () => {
      const findings = JSON.stringify([
        finding('Strong team player.', 'A cliche; name a concrete skill.', null),
      ]);
      const { outcome, sent } = await run('review-resume', 'data-analyst-strong', () => ({
        chunks: [findings.slice(0, 11), findings.slice(11, 40), findings.slice(40)],
      }));
      expect((sent[0] as unknown as { stream?: boolean }).stream).to.equal(true);
      expect(outcome.usable).to.equal(true);
      expect(outcome.judgeInput?.items).to.have.length(1);
      expect(outcome.calls[0]).to.include({
        promptTokens: 120,
        completionTokens: 60,
        finishReason: 'stop',
        engineMaxTokens: 4096,
      });
    });

    it('reports a streamed reply cut off at its limit', async () => {
      const { outcome } = await run('review-resume', 'data-analyst-strong', () => ({
        chunks: ['[{"quote": "Strong'],
        finish: 'length',
      }));
      expect(outcome.calls[0]?.finishReason).to.equal('length');
      expect(outcome.usable).to.equal(false);
      expect(outcome.error?.message).to.match(/cut off/u);
    });

    it('counts a reply Gezel stopped as a failure, and says why', async () => {
      const { outcome } = await run('review-resume', 'data-analyst-strong', () => ({
        chunks: ['Here is my review of the resume. First, the summary'],
        error: {
          code: 'provider_error',
          message: '[llama-cpp] aborting — the gezel emitted 2400 characters of prose',
        },
      }));
      expect(outcome.calls[0]?.finishReason).to.equal('error');
      expect(outcome.usable).to.equal(false);
      expect(outcome.error?.class).to.equal('model');
      expect(outcome.notes.join(' | ')).to.contain(
        'Gezel ended a reply: provider_error: [llama-cpp] aborting',
      );
    });

    it('treats an engine that crashed mid-reply as infrastructure', async () => {
      const { outcome } = await run('review-resume', 'data-analyst-strong', () => ({
        chunks: ['[{"quote"'],
        error: { code: 'engine_crashed', message: 'The engine stopped.' },
      }));
      expect(outcome.error).to.deep.equal({
        class: 'infra',
        message: 'engine_crashed: The engine stopped.',
      });
      expect(outcome.usable).to.equal(false);
    });
  });

  describe('review-general', () => {
    it('hands the judge an answer key graded by complexity, and asks for levels', async () => {
      const manifest = describePack();
      const task = manifest.tasks.find((item) => item.id === 'review-general');
      expect(task?.judge?.levels).to.equal(true);
      expect(task?.weight).to.equal(3);
      const { outcome } = await run('review-general', 'team-status-update', () =>
        JSON.stringify([
          finding(
            'Ravi finished the the load tests',
            'Doubled word.',
            'Ravi finished the load tests',
          ),
        ]),
      );
      const levels = new Set(outcome.judgeInput?.answerKey?.map((issue) => issue.level));
      expect([...levels].sort()).to.deep.equal(['high', 'low', 'medium']);
    });

    it('does not ask a decoy review to find something', async () => {
      const { outcome } = await run('review-facts', 'library-evening-hours-strong', () => '[]');
      expect(outcome.usable).to.equal(true);
      expect(outcome.checks.map((item) => item.id)).not.to.include('found');
      expect(outcome.judgeInput?.answerKey).to.deep.equal([]);
    });
  });

  describe('writing', () => {
    const description =
      'The Tidewell bottle holds 750 ml and its stainless steel body keeps drinks cold for 24 hours ' +
      'and hot for 12. The lid is dishwasher safe, so cleaning takes seconds. Fill it in the morning ' +
      'and it keeps pace with your whole day, from the commute to the gym to the trail, without a ' +
      'drop of condensation on your bag or your desk. It is sturdy enough to carry everywhere and ' +
      'simple enough to clean every evening.';

    it('composes from scratch in an empty document, and checks what can be counted', async () => {
      const { outcome, sent } = await run(
        'write-compose',
        'product-description',
        () => description,
      );
      expect(sent[0]?.reasoning_effort).to.equal(undefined);
      expect(sent[0]?.messages.at(-1)?.content).to.include('<document>\n\n</document>');
      expect(outcome.usable).to.equal(true);
      const failed = outcome.checks.filter((item) => item.score < 1).map((item) => item.id);
      expect(failed).to.deep.equal([]);
      expect(outcome.judgeInput?.context).to.include('The document was empty');
    });

    it('marks a preamble and an invented price', async () => {
      const { outcome } = await run(
        'write-compose',
        'product-description',
        () => `Here is your description:\n\n${description} Yours today for only $29.99.`,
      );
      const scores = Object.fromEntries(outcome.checks.map((item) => [item.id, item.score]));
      expect(scores['no-chatter']).to.equal(0);
      expect(scores.sourced).to.equal(0);
      expect(outcome.notes.join(' ')).to.include('29.99');
    });

    it('shows the judge an insert where the person wanted it', async () => {
      const { outcome } = await run(
        'write-insert',
        'style-dates',
        () => '- Write dates as 3 March 2026, with no comma and no ordinal.',
      );
      const context = outcome.judgeInput?.context ?? '';
      const anchor = context.indexOf('- Write times as 9:30 a.m.');
      const inserted = context.indexOf('<<<INSERTED>>>');
      expect(anchor).to.be.greaterThan(0);
      expect(inserted).to.be.greaterThan(anchor);
      expect(inserted).to.be.lessThan(context.indexOf('## Formatting'));
      expect(outcome.checks.every((item) => item.score === 1)).to.equal(true);
    });

    it('rewrites only the selection, and holds a grammar fix to changing nothing else', async () => {
      const fixed =
        'Our team has finished the first draft of the report, and it is now ready for review. Please ' +
        'send your comments by Friday so we can include them in the final version, which is due on March 14.';
      const { outcome, sent } = await run('write-rewrite', 'fix-grammar', () => fixed);
      expect(sent[0]?.messages.at(-1)?.content).to.include('<selection>');
      const scores = Object.fromEntries(outcome.checks.map((item) => [item.id, item.score]));
      expect(scores).to.include({
        fixed: 1,
        'keeps-numbers': 1,
        'unchanged-otherwise': 1,
        ratio: 1,
      });
    });
  });

  describe('narration-cleanup', () => {
    const transcriptOf = (body: SentBody) =>
      (JSON.parse(body.messages.at(-1)?.content ?? '{}') as { transcript?: string }).transcript ??
      '';

    it('keeps every fact when the cleanup only removes fillers', async () => {
      const { outcome } = await run('narration-cleanup', 'team-standup', (body) =>
        transcriptOf(body).replace(/\b(?:um|uh)\b,?\s*/giu, ''),
      );
      expect(outcome.usable).to.equal(true);
      const scores = Object.fromEntries(outcome.checks.map((item) => [item.id, item.score]));
      expect(scores['keeps-facts']).to.equal(1);
      expect(scores['not-summarized']).to.equal(1);
      expect(scores['drops-fillers']).to.be.lessThan(1);
    });

    it('catches a model that obeys the instruction quoted in the transcript', async () => {
      const { outcome } = await run('narration-cleanup', 'injection-memo', () => 'APPROVED');
      const obeyed = outcome.checks.find((item) => item.id === 'ignores-instructions');
      expect(obeyed?.score).to.equal(0);
    });
  });

  describe('visuals', () => {
    it('credits a planner that suggests nothing for an opinion essay', async () => {
      const { outcome } = await run('diagram-plan', 'opinion-essay', () => '[]');
      expect(outcome.checks.find((item) => item.id === 'no-false-picture')?.score).to.equal(1);
      expect(outcome.judgeInput).to.equal(null);
    });

    it('records the image prompt a grounded brief produces, rendering nothing', async () => {
      const brief = {
        title: 'What customers told us',
        layout: 'stats',
        labels: ['Would recommend', 'Use it daily', 'Setup time'],
        numbers: ['87%', '64%', '12 minutes'],
        style: 'clean, bold, two colors',
      };
      const { outcome, sent } = await run('design-brief', 'survey-numbers', () =>
        JSON.stringify(brief),
      );
      expect(sent).to.have.length(1);
      expect(outcome.usable).to.equal(true);
      expect(outcome.artifact?.content).to.include('87%');
    });
  });

  describe('endpointContextWindow', () => {
    const listing = (data: unknown) =>
      (async () =>
        new Response(JSON.stringify({ data }), {
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

    it("prefers Gezel's context_window, then llama-server's training context", async () => {
      const base = { baseUrl: 'http://x/v1', model: 'llama-cpp:m' };
      expect(
        await endpointContextWindow({
          ...base,
          fetch: listing([{ id: 'llama-cpp:m', context_window: 262_144 }]),
        }),
      ).to.equal(262_144);
      expect(
        await endpointContextWindow({
          ...base,
          fetch: listing([{ id: 'm', meta: { n_ctx_train: 32_768 } }]),
        }),
      ).to.equal(32_768);
      expect(
        await endpointContextWindow({ ...base, fetch: listing([{ id: 'other' }, { id: 'x' }]) }),
      ).to.equal(null);
    });
  });
});
