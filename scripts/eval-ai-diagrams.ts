/**
 * Evaluate AI diagram suggestions against a real model.
 *
 * Runs the same pipeline the Illustrate panel uses over a small corpus of
 * documents (packages/react/test/fixtures/ai-diagrams) and reports, per
 * model: whether the plan could be read, how many picks matched the gold
 * passages and kinds, how often a pick produced a usable diagram on the
 * first try or after the one repair, why the rest failed, and false
 * positives on documents that need no diagram.
 *
 * Not part of `npm run all` — it needs a running model:
 *
 *   DOCBLOCKS_EVAL_AI_BASE_URL=http://127.0.0.1:8080/v1 \
 *   DOCBLOCKS_EVAL_AI_MODELS=my-model \
 *   npm run eval:ai-diagrams -- --context 4096 --label small-budget
 *
 * The base URL is any OpenAI-compatible endpoint (llama-server, mlx_vlm,
 * a Gezel daemon with a token in DOCBLOCKS_EVAL_AI_TOKEN). `--context` forces
 * the prompt budget a model with that context window would get.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  // Mermaid parses through DOM APIs, as it does in the app.
  GlobalRegistrator.register({ url: 'http://localhost/' });
}

const root = path.resolve(import.meta.dirname, '..');
const corpusDir = path.join(root, 'packages/react/test/fixtures/ai-diagrams');

interface GoldEntry {
  readonly expect: readonly { readonly marker: string; readonly kinds: readonly string[] }[];
  readonly negative?: boolean;
  readonly injection?: string;
}

interface PickRecord {
  readonly passage: string;
  readonly kind: string;
  readonly title: string;
  readonly status: 'ready' | 'failed' | 'cancelled';
  readonly message: string | null;
  readonly gold: boolean;
  readonly calls: number;
  /** The markdown that would be inserted, for judging the content by eye. */
  readonly markdown: string | null;
}

interface DocRecord {
  readonly document: string;
  readonly planRead: boolean;
  readonly error: string | null;
  readonly picks: readonly PickRecord[];
  readonly goldFound: number;
  readonly goldTotal: number;
  readonly falsePositive: boolean;
  readonly injected: boolean;
  readonly calls: number;
  readonly seconds: number;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** An `ai.chat` that calls an OpenAI-compatible endpoint, without streaming. */
function endpointChat(
  baseUrl: string,
  model: string,
  token: string | undefined,
  log: AiChatRequest[],
) {
  const chat: DocBlocksHostAiAPI['chat'] = (request) => {
    log.push(request);
    const controller = new AbortController();
    const done = (async (): Promise<AiResult<AiChatCompletion>> => {
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stream: false,
          }),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: 'unknown',
              message: `HTTP ${String(response.status)}: ${await response.text()}`,
            },
          };
        }
        const body = (await response.json()) as {
          choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
        };
        const choice = body.choices?.[0];
        return {
          ok: true,
          value: {
            text: choice?.message?.content ?? '',
            finishReason: choice?.finish_reason === 'length' ? 'length' : 'stop',
            model,
            usage: null,
          },
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: true, value: { text: '', finishReason: 'cancelled', model, usage: null } };
        }
        return { ok: false, error: { code: 'unknown', message: String(error) } };
      }
    })();
    return { done, cancel: () => controller.abort() };
  };
  return { chat };
}

async function main(): Promise<void> {
  const baseUrl = process.env.DOCBLOCKS_EVAL_AI_BASE_URL?.trim();
  const models = (process.env.DOCBLOCKS_EVAL_AI_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (!baseUrl || models.length === 0) {
    console.error('Set DOCBLOCKS_EVAL_AI_BASE_URL and DOCBLOCKS_EVAL_AI_MODELS.');
    process.exitCode = 2;
    return;
  }
  const context = option('context') ? Number(option('context')) : null;
  const label = option('label') ?? `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const only = option('only');

  // Imported after the DOM is registered: Mermaid reads it at load time.
  const { validateMermaidSource } = await import('@bendyline/squisq-editor-react');
  const { startIllustrationRun } = await import('../packages/react/src/Ai/illustrate-pipeline.js');
  const { promptBudget } = await import('../packages/react/src/Ai/illustrate-prompts.js');
  const { documentTitle } = await import('../packages/react/src/Ai/illustrate-passages.js');

  const gold = JSON.parse(fs.readFileSync(path.join(corpusDir, 'gold.json'), 'utf8')) as Record<
    string,
    GoldEntry
  >;
  const documents = Object.keys(gold).filter((name) => !only || name.includes(only));
  const outDir = path.join(root, 'reports/ai-diagram-evals', label);
  fs.mkdirSync(outDir, { recursive: true });
  const summary: string[] = [`# AI diagram eval: ${label}`, '', `Endpoint: ${baseUrl}`, ''];

  for (const model of models) {
    const records: DocRecord[] = [];
    for (const name of documents) {
      const source = fs.readFileSync(path.join(corpusDir, name), 'utf8');
      const entry = gold[name] as GoldEntry;
      const log: AiChatRequest[] = [];
      const ai = endpointChat(baseUrl, model, process.env.DOCBLOCKS_EVAL_AI_TOKEN, log);
      const picks: PickRecord[] = [];
      let planRead = true;
      let error: string | null = null;
      let callsBefore = 0;
      const started = Date.now();
      await startIllustrationRun({
        ai,
        source,
        title: documentTitle(source),
        budget: promptBudget(context),
        validateMermaid: validateMermaidSource,
        onEvent: (event) => {
          if (event.type === 'drawing') callsBefore = log.length;
          if (event.type === 'error') {
            error = event.message;
            if (event.message.includes('plan could not be read')) planRead = false;
          }
          if (event.type === 'suggestion') {
            const outcome = event.outcome;
            const goldHit = entry.expect.some(
              (expected) =>
                event.pick.passage.text.includes(expected.marker) &&
                expected.kinds.includes(event.pick.kind),
            );
            picks.push({
              passage: event.pick.passage.plain.slice(0, 60),
              kind: event.pick.kind,
              title: event.pick.title,
              status: outcome.status,
              message: outcome.status === 'failed' ? outcome.message : null,
              gold: goldHit,
              calls: log.length - callsBefore,
              markdown: outcome.status === 'ready' ? outcome.compiled.render(3, new Set()) : null,
            });
          }
        },
      }).done;
      const goldFound = entry.expect.filter((expected) =>
        picks.some(
          (pick) =>
            pick.gold && source.includes(expected.marker) && expected.kinds.includes(pick.kind),
        ),
      ).length;
      const injected = entry.injection
        ? log.length > 0 && picks.some((pick) => pick.title.includes(entry.injection ?? ''))
        : false;
      records.push({
        document: name,
        planRead,
        error,
        picks,
        goldFound,
        goldTotal: entry.expect.length,
        falsePositive: Boolean(entry.negative) && picks.some((pick) => pick.status === 'ready'),
        injected,
        calls: log.length,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
      console.warn(
        `${model} ${name}: plan=${String(planRead)} picks=${String(picks.length)} ` +
          `ready=${String(picks.filter((pick) => pick.status === 'ready').length)} ` +
          `gold=${String(goldFound)}/${String(entry.expect.length)} calls=${String(log.length)} ` +
          `${String(records.at(-1)?.seconds)}s${error ? ` error=${error}` : ''}`,
      );
    }

    const allPicks = records.flatMap((record) => record.picks);
    const ready = allPicks.filter((pick) => pick.status === 'ready');
    const firstTry = ready.filter((pick) => pick.calls <= 1);
    const compilerFaults = allPicks.filter((pick) =>
      pick.message?.startsWith('DocBlocks could not draw'),
    );
    const percent = (part: number, whole: number) =>
      whole === 0 ? 'n/a' : `${String(Math.round((100 * part) / whole))}%`;
    const goldFound = records.reduce((sum, record) => sum + record.goldFound, 0);
    const goldTotal = records.reduce((sum, record) => sum + record.goldTotal, 0);
    summary.push(
      `## ${model}${context ? ` (budget for a ${String(context)}-token context)` : ''}`,
      '',
      `- Plans read: ${String(records.filter((record) => record.planRead).length)}/${String(records.length)}`,
      `- Gold passages found with an acceptable kind: ${String(goldFound)}/${String(goldTotal)} (${percent(goldFound, goldTotal)})`,
      `- Picks that became a usable diagram: ${String(ready.length)}/${String(allPicks.length)} (${percent(ready.length, allPicks.length)}); first try: ${String(firstTry.length)}`,
      `- Compiler or validation faults (must be 0): ${String(compilerFaults.length)}`,
      `- False positives on documents needing no diagram: ${String(records.filter((record) => record.falsePositive).length)}`,
      `- Prompt-injection text reaching a diagram title: ${String(records.filter((record) => record.injected).length)}`,
      `- Model calls: ${String(records.reduce((sum, record) => sum + record.calls, 0))}; total time: ${String(Math.round(records.reduce((sum, record) => sum + record.seconds, 0)))}s`,
      '',
      '| Document | Plan | Picks (kind → status) | Gold | Calls | Time |',
      '| --- | --- | --- | --- | --- | --- |',
      ...records.map(
        (record) =>
          `| ${record.document} | ${record.planRead ? 'read' : 'unreadable'} | ` +
          `${record.picks.map((pick) => `${pick.kind} → ${pick.status}${pick.gold ? ' ✓' : ''}`).join('; ') || (record.error ?? 'none')} | ` +
          `${String(record.goldFound)}/${String(record.goldTotal)} | ${String(record.calls)} | ${String(record.seconds)}s |`,
      ),
      '',
      ...allPicks
        .filter((pick) => pick.status === 'failed')
        .map((pick) => `- Failed ${pick.kind} ("${pick.passage}…"): ${pick.message ?? ''}`),
      '',
      '### Diagrams',
      '',
      ...records.flatMap((record) =>
        record.picks
          .filter((pick) => pick.markdown)
          .map((pick) => `#### ${record.document}: ${pick.kind}\n\n${pick.markdown ?? ''}\n`),
      ),
      '',
    );
    fs.writeFileSync(
      path.join(outDir, `${model.replace(/[^\w.-]+/gu, '_')}.json`),
      `${JSON.stringify(records, null, 2)}\n`,
    );
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
  console.warn(`\nReport: ${path.relative(root, path.join(outDir, 'summary.md'))}`);
}

await main();
