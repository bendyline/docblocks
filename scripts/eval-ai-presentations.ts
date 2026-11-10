/**
 * Evaluate AI slide suggestions against a real model.
 *
 * Runs the pipeline the presentation designer uses ("Suggest with AI") over a
 * small corpus of documents (packages/react/test/fixtures/ai-presentations):
 * Squisq plans the deck from the prose, the model storyboards it and words
 * each slide, and every reply passes the same gates as in the app. Per model
 * the report gives:
 *
 * - shape: how many replies were JSON, and how many had exactly the fields
 *   and layout names asked for, so a small model's output can be read at all;
 * - acceptance: how many slides took the model's suggestion, on the first
 *   try or after the one correction, and why the rest were refused;
 * - layouts: for passages with a relationship worth drawing (a cycle, a
 *   funnel, key numbers…), whether the slide drew it, against gold.json;
 * - faithfulness: shapes on prose that has none, a range cut to one end, a
 *   passage that tries to give the model instructions;
 * - slides: whether the suggested deck compiles and every slide draws.
 *
 * Not part of `npm run all`; it needs a running model:
 *
 *   DOCBLOCKS_EVAL_AI_BASE_URL=http://127.0.0.1:8080/v1 \
 *   DOCBLOCKS_EVAL_AI_MODELS=gemma4-e4b-q4 \
 *   npm run eval:ai-presentations -- --label gemma-e4b
 *
 * The base URL is any OpenAI-compatible endpoint (llama-server, a Gezel
 * daemon with a token in DOCBLOCKS_EVAL_AI_TOKEN). Requests are sent as the
 * desktop host sends them, with the structured-output schema; `--no-schema`
 * leaves it out, as a host that cannot enforce one would. `--only <name>`
 * runs the documents whose file name contains it.
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

// Node's fetch and AbortController, kept before the DOM is registered: the
// browser fetch happy-dom installs sends CORS preflights a model server does
// not answer.
const nodeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const NodeAbortController = globalThis.AbortController;

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  GlobalRegistrator.register({ url: 'http://localhost/' });
}

const root = path.resolve(import.meta.dirname, '..');
const corpusDir = path.join(root, 'packages/react/test/fixtures/ai-presentations');

interface GoldEntry {
  /** Passages with a relationship worth drawing, and the layouts that show it. */
  readonly expect: readonly {
    readonly marker: string;
    readonly ideal: string;
    readonly layouts: readonly string[];
  }[];
  /** Layouts that would claim a relationship this document does not have. */
  readonly forbid?: readonly string[];
  /** A word the document tries to make the model say. */
  readonly injection?: string;
  /** The ends of a range the document states; neither may stand alone as a key number. */
  readonly rangeOnly?: readonly string[];
}

interface CallRecord {
  readonly kind: 'storyboard' | 'slide';
  /** The slide a wording request was for; -1 for the storyboard. */
  readonly index: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly milliseconds: number;
  readonly json: boolean;
  /** Exactly the fields asked for, with a known layout. */
  readonly shape: boolean;
}

interface SlideRecord {
  readonly index: number;
  readonly passage: string;
  readonly automatic: string;
  readonly planned: string | null;
  readonly final: string;
  readonly refined: boolean;
  readonly attempts: number;
  /** Why each refused reply was refused, when the pipeline says. */
  readonly problems: readonly string[];
  readonly headline: string;
  readonly points: readonly string[];
  /** What the layout draws beyond its points: a hub's centre, a matrix's axes. */
  readonly extras: Readonly<Record<string, string>>;
  readonly gold: {
    readonly ideal: string;
    readonly accepted: boolean;
    readonly hit: boolean;
  } | null;
}

interface DocRecord {
  readonly document: string;
  readonly slides: readonly SlideRecord[];
  readonly calls: readonly CallRecord[];
  readonly storyboard: 'valid' | 'invalid' | 'skipped';
  readonly forbidden: readonly string[];
  readonly injected: boolean;
  readonly rangeCut: boolean;
  readonly compiled: boolean;
  readonly compileError: string | null;
  /** Slides whose template had nothing to draw and fell back to content. */
  readonly drewNothing: number;
  readonly templates: readonly string[];
  readonly seconds: number;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function unfenced(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/u, '').replace(/\s*```\s*$/u, '');
}

/** Whether a reply is JSON, and whether it is exactly what the request asked for. */
function shapeOf(
  kind: CallRecord['kind'],
  text: string,
  layouts: ReadonlySet<string>,
): { json: boolean; shape: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(unfenced(text));
  } catch {
    return { json: false, shape: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { json: true, shape: false };
  const record = value as Record<string, unknown>;
  if (kind === 'storyboard') {
    return {
      json: true,
      shape:
        Object.keys(record).join() === 'layouts' &&
        Array.isArray(record.layouts) &&
        record.layouts.every((layout) => typeof layout === 'string' && layouts.has(layout)),
    };
  }
  const optional = new Set(['center', 'xAxis', 'yAxis']);
  const keys = Object.keys(record);
  return {
    json: true,
    shape:
      ['layout', 'headline', 'points'].every((key) => keys.includes(key)) &&
      keys.every((key) => ['layout', 'headline', 'points'].includes(key) || optional.has(key)) &&
      typeof record.layout === 'string' &&
      layouts.has(record.layout) &&
      typeof record.headline === 'string' &&
      Array.isArray(record.points) &&
      record.points.every((point) => typeof point === 'string'),
  };
}

/** An `ai.chat` that calls an OpenAI-compatible endpoint as the desktop host does. */
function endpointChat(
  baseUrl: string,
  model: string,
  token: string | undefined,
  schema: boolean,
  layouts: ReadonlySet<string>,
  calls: CallRecord[],
) {
  const chat: DocBlocksHostAiAPI['chat'] = (request: AiChatRequest) => {
    const controller = new NodeAbortController();
    const kind: CallRecord['kind'] =
      request.responseFormat?.name === 'presentation_storyboard' ? 'storyboard' : 'slide';
    let index = -1;
    if (kind === 'slide') {
      try {
        const user = JSON.parse(request.messages[request.messages.length - 1]?.content ?? '{}') as {
          position?: string;
        };
        index = Number(/^(\d+) of/u.exec(user.position ?? '')?.[1] ?? 0) - 1;
      } catch {
        index = -1;
      }
    }
    const started = Date.now();
    const record = (
      text: string,
      truncated: boolean,
      error: string | null,
      usage?: { prompt_tokens?: number; completion_tokens?: number },
    ) =>
      calls.push({
        kind,
        index,
        text,
        truncated,
        error,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        milliseconds: Date.now() - started,
        ...shapeOf(kind, text, layouts),
      });
    const done = (async (): Promise<AiResult<AiChatCompletion>> => {
      try {
        const response = await nodeFetch(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
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
            // As the desktop host sends it: only writing may spend its budget reasoning.
            ...(request.purpose === 'write' ? {} : { reasoning_effort: 'none' }),
            ...(schema && request.responseFormat
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: {
                      name: request.responseFormat.name,
                      schema: request.responseFormat.schema,
                      strict: true,
                    },
                  },
                }
              : {}),
            stream: false,
          }),
        });
        if (!response.ok) {
          const message = `HTTP ${String(response.status)}: ${await response.text()}`;
          record('', false, message);
          return { ok: false, error: { code: 'unknown', message } };
        }
        const body = (await response.json()) as {
          choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = body.choices?.[0];
        const text = choice?.message?.content ?? '';
        const truncated = choice?.finish_reason === 'length';
        record(text, truncated, null, body.usage);
        return {
          ok: true,
          value: { text, finishReason: truncated ? 'length' : 'stop', model, usage: null },
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: true, value: { text: '', finishReason: 'cancelled', model, usage: null } };
        }
        record('', false, String(error));
        return { ok: false, error: { code: 'unknown', message: String(error) } };
      }
    })();
    return { done, cancel: () => controller.abort() };
  };
  return { chat };
}

const percent = (part: number, whole: number) =>
  whole ? `${String(Math.round((part / whole) * 100))}%` : 'n/a';

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
  const label = option('label') ?? `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const only = option('only');
  const schema = !process.argv.includes('--no-schema');

  const { parseMarkdown } = await import('@bendyline/squisq/markdown');
  const { markdownToDoc, expandDocBlocks } = await import('@bendyline/squisq/doc');
  const transform = await import('@bendyline/squisq/transform');
  const { refinePresentationPlan } =
    await import('../packages/react/src/Presentation/presentation-ai.js');
  const layouts = new Set<string>(transform.PRESENTATION_LAYOUTS);
  const drawn = new Set<string>(transform.CONCEPT_TEMPLATES);

  const gold = JSON.parse(fs.readFileSync(path.join(corpusDir, 'gold.json'), 'utf8')) as Record<
    string,
    GoldEntry
  >;
  const documents = Object.keys(gold).filter((name) => !only || name.includes(only));
  const outDir = path.join(root, 'reports/ai-presentation-evals', label);
  fs.mkdirSync(outDir, { recursive: true });
  const summary: string[] = [
    `# AI presentation eval: ${label}`,
    '',
    `Endpoint: ${baseUrl}. Structured output: ${schema ? 'sent' : 'not sent'}.`,
    '',
  ];

  for (const model of models) {
    const records: DocRecord[] = [];
    for (const name of documents) {
      const source = fs.readFileSync(path.join(corpusDir, name), 'utf8');
      const entry = gold[name] as GoldEntry;
      const doc = markdownToDoc(parseMarkdown(source), { generateCoverBlock: false });
      const plan = transform.createPresentationPlan(doc);
      const calls: CallRecord[] = [];
      const ai = endpointChat(
        baseUrl,
        model,
        process.env.DOCBLOCKS_EVAL_AI_TOKEN,
        schema,
        layouts,
        calls,
      );
      const problems = new Map<number, string[]>();
      const started = Date.now();
      const options = {
        // Reported by pipelines that say why a reply was refused.
        onAttempt: (index: number, _attempt: number, outcome: { problem: string | null }) => {
          if (outcome.problem)
            problems.set(index, [...(problems.get(index) ?? []), outcome.problem]);
        },
      };
      const result = await refinePresentationPlan(ai, plan, options);
      const seconds = Math.round((Date.now() - started) / 100) / 10;

      const storyboardCall = calls.find((call) => call.kind === 'storyboard');
      // The slides the pipeline asked about: Squisq says which when it can
      // (it leaves out a passage that addresses the model); an older pipeline
      // asked about every slide that is not authored or hidden.
      const slidesToWord = (
        transform as { presentationSlidesToWord?: (plan: typeof result.plan) => number[] }
      ).presentationSlidesToWord;
      const asked = slidesToWord
        ? slidesToWord(plan)
        : plan.beats.flatMap((beat, index) =>
            beat.layout === 'authored' || beat.hidden ? [] : [index],
          );
      let planned: string[] | null = null;
      if (storyboardCall?.shape) {
        planned = (JSON.parse(unfenced(storyboardCall.text)) as { layouts: string[] }).layouts;
        if (planned.length !== asked.length) planned = null;
      }
      const slides: SlideRecord[] = result.plan.beats.map((beat, index) => {
        const passage = plan.sourceText.slice(beat.sourceStart, beat.sourceEnd);
        const expected = entry.expect.find((item) => passage.includes(item.marker));
        return {
          index,
          passage,
          automatic: plan.beats[index]!.layout,
          planned: planned?.[asked.indexOf(index)] ?? null,
          final: beat.layout,
          refined: result.refined.includes(index),
          attempts: calls.filter((call) => call.kind === 'slide' && call.index === index).length,
          problems: problems.get(index) ?? [],
          headline: beat.headline,
          points: beat.points,
          extras: Object.fromEntries(
            (['center', 'xAxis', 'yAxis'] as const).flatMap((key) => {
              const value = (beat as unknown as Record<string, unknown>)[key];
              return typeof value === 'string' ? [[key, value]] : [];
            }),
          ),
          gold: expected
            ? {
                ideal: expected.ideal,
                accepted: expected.layouts.includes(beat.layout),
                // Steps and a process are one drawing under two names.
                hit:
                  beat.layout === expected.ideal ||
                  (expected.ideal === 'process' && beat.layout === 'steps'),
              }
            : null,
        };
      });

      // The deck a person would get: it must compile, and every slide must draw.
      let compiled = true;
      let compileError: string | null = null;
      let drewNothing = 0;
      let templates: string[] = [];
      try {
        const deck = transform.compilePresentationPlan(doc, result.plan);
        templates = deck.blocks.map((block) => String(block.template ?? ''));
        expandDocBlocks(deck.blocks, {
          splitLongBlocks: false,
          mergeShortBlocks: false,
          onDiagnostic: (diagnostic) => {
            if (diagnostic.code === 'template-drew-nothing') drewNothing += 1;
          },
        });
      } catch (error) {
        compiled = false;
        compileError = error instanceof Error ? error.message : String(error);
      }

      const shown = (slide: SlideRecord) => [slide.headline, ...slide.points].join('\n');
      const rangeCut =
        !!entry.rangeOnly &&
        slides.some((slide) => {
          if (slide.final !== 'stat' && slide.final !== 'stats') return false;
          const figures =
            slide.final === 'stat'
              ? [transform.presentationStat(slide.headline, slide.points)?.match.value ?? '']
              : slide.points.map((point) => point.split(':')[0] ?? '');
          return figures.some((figure) => {
            const numbers = transform.numbersIn(figure);
            return numbers.length === 1 && entry.rangeOnly!.includes(numbers[0]!);
          });
        });
      records.push({
        document: name,
        slides,
        calls,
        storyboard: !storyboardCall ? 'skipped' : planned ? 'valid' : 'invalid',
        forbidden: slides
          .filter((slide) => entry.forbid?.includes(slide.final))
          .map((slide) => slide.final),
        // An automatic slide shows the passage's own sentences, so the word
        // counts only on a slide the model worded.
        injected:
          !!entry.injection &&
          slides.some((slide) => slide.refined && shown(slide).includes(entry.injection!)),
        rangeCut,
        compiled,
        compileError,
        drewNothing,
        templates,
        seconds,
      });
      console.warn(
        `${model} ${name}: slides=${String(slides.length)} refined=${String(result.refined.length)} ` +
          `retained=${String(result.retained)} storyboard=${records.at(-1)!.storyboard} ` +
          `layouts=${slides.map((slide) => slide.final).join(',')} ${String(seconds)}s` +
          (compileError ? ` compile=${compileError}` : ''),
      );
    }

    const slides = records.flatMap((record) => record.slides);
    const calls = records.flatMap((record) => record.calls);
    const slideCalls = calls.filter((call) => call.kind === 'slide');
    const storyboards = records.filter((record) => record.storyboard !== 'skipped');
    const refined = slides.filter((slide) => slide.refined);
    const golds = slides.filter((slide) => slide.gold);
    const reasons = new Map<string, number>();
    for (const slide of slides)
      for (const problem of slide.problems) reasons.set(problem, (reasons.get(problem) ?? 0) + 1);
    const promptTokens = calls.flatMap((call) => (call.promptTokens ? [call.promptTokens] : []));

    summary.push(
      `## ${model}`,
      '',
      `- Slides: ${String(slides.length)} across ${String(records.length)} documents; ` +
        `${String(refined.length)} took the model's suggestion (${percent(refined.length, slides.length)}), ` +
        `${String(refined.filter((slide) => slide.attempts <= 1).length)} of them on the first try.`,
      `- Reply shape: ${String(slideCalls.filter((call) => call.json).length)}/${String(slideCalls.length)} slide replies were JSON, ` +
        `${String(slideCalls.filter((call) => call.shape).length)}/${String(slideCalls.length)} had exactly the fields and a known layout ` +
        `(${percent(slideCalls.filter((call) => call.shape).length, slideCalls.length)}). ` +
        `Truncated: ${String(calls.filter((call) => call.truncated).length)}. Errors: ${String(calls.filter((call) => call.error).length)}.`,
      `- Storyboard: ${String(storyboards.filter((record) => record.storyboard === 'valid').length)}/${String(storyboards.length)} decks got one layout per slide.`,
      `- Drawn slides (${[...drawn].join(', ')}): ${String(slides.filter((slide) => drawn.has(slide.final)).length)} after suggestions, ` +
        `${String(slides.filter((slide) => drawn.has(slide.automatic)).length)} in the automatic deck.`,
      `- Gold passages: ${String(golds.filter((slide) => slide.gold!.accepted).length)}/${String(golds.length)} shown with a layout that fits, ` +
        `${String(golds.filter((slide) => slide.gold!.hit).length)}/${String(golds.length)} with the ideal one.`,
      `- Faithfulness: ${String(records.reduce((sum, record) => sum + record.forbidden.length, 0))} shapes on prose that has none, ` +
        `${String(records.filter((record) => record.rangeCut).length)} ranges cut to one end, ` +
        `${String(records.filter((record) => record.injected).length)} injected instructions followed.`,
      `- Decks: ${String(records.filter((record) => record.compiled).length)}/${String(records.length)} compiled; ` +
        `${String(records.reduce((sum, record) => sum + record.drewNothing, 0))} slides had nothing to draw.`,
      `- Requests: ${String(calls.length)}, largest prompt ${promptTokens.length ? String(Math.max(...promptTokens)) : 'unknown'} tokens, ` +
        `${String(Math.round(calls.reduce((sum, call) => sum + call.milliseconds, 0) / Math.max(1, calls.length)))} ms each on average.`,
      '',
      '| Passage | Ideal | Automatic | Planned | Final | Suggestion |',
      '| --- | --- | --- | --- | --- | --- |',
      ...golds.map(
        (slide) =>
          `| ${slide.passage.replace(/\s+/gu, ' ').slice(0, 48)}… | ${slide.gold!.ideal} | ${slide.automatic} | ${slide.planned ?? ''} | ${slide.final}${slide.gold!.hit ? ' ✓' : slide.gold!.accepted ? ' ~' : ' ✗'} | ${slide.refined ? `taken (${String(slide.attempts)})` : 'refused'} |`,
      ),
      '',
    );
    if (reasons.size) {
      summary.push('Refused replies:', '');
      for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]))
        summary.push(`- ${String(count)} × ${reason}`);
      summary.push('');
    }
    fs.writeFileSync(
      path.join(outDir, `${model.replace(/[^\w.-]+/gu, '_')}.json`),
      `${JSON.stringify(records, null, 2)}\n`,
    );
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
  console.warn(`\n${summary.join('\n')}\n\nWrote ${outDir}`);
}

await main();
