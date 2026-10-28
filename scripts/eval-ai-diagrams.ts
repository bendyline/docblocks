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
 *
 * `--illustrations` evaluates "Illustration" instead: each prompt in the
 * corpus's illustrations.json is drawn as SVG by the model, and the report
 * gives how many became usable pictures, on the first try or after a retry,
 * which needed markup stripped, and which used fixed colors. The pictures are
 * written beside the report for judging by eye. The context window defaults
 * to 32K, since the kind is only offered from 16K.
 *
 * `--images <image-model>` evaluates "Design graphic": every document is
 * planned with design graphics offered, and each design pick runs the same
 * brief, grounding check and compiled prompt as the panel, rendered by the
 * image model on a Gezel that serves `/v1/images`:
 *
 *   DOCBLOCKS_EVAL_IMAGES_BASE_URL=http://127.0.0.1:6228 \
 *   DOCBLOCKS_EVAL_IMAGES_TOKEN=<token with the images scope> \
 *   npm run eval:ai-diagrams -- --images sd-cpp:ming-image-0.1-design-bf16
 *
 * `--design-all` draws every pick as a design graphic, whatever kind the
 * planner chose, to exercise the brief and the render on a corpus written for
 * diagrams. The report places each render beside the compiled diagram the
 * same passage would get, in index.html. With DOCBLOCKS_EVAL_JUDGE_BASE_URL and
 * DOCBLOCKS_EVAL_JUDGE_MODEL (an OpenAI-compatible vision model), each render
 * is read back and scored: brief text spelled correctly, and text the brief
 * never asked for. Spelling is compared here, not by the judge.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AiChatCompletion,
  AiChatRequest,
  AiImageResult,
  AiImagesAPI,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

/**
 * Node's fetch, kept before the DOM is registered: happy-dom replaces the
 * global with a browser fetch that sends CORS preflights, which a model
 * server or Gezel does not answer. Node's fetch also only accepts Node's own
 * AbortSignal, so its AbortController is kept too.
 */
const nodeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const NodeAbortController = globalThis.AbortController;

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
    const controller = new NodeAbortController();
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
  if (process.argv.includes('--illustrations')) {
    await evaluateIllustrations({ baseUrl, models, context: context ?? 32_768, label });
    return;
  }
  const imageModel = option('images');
  if (imageModel) {
    await evaluateDesigns({
      baseUrl,
      models,
      context: context ?? 32_768,
      label,
      imageModel,
      designAll: process.argv.includes('--design-all'),
      only,
    });
    return;
  }

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

interface IllustrationPrompt {
  readonly description: string;
  readonly material?: string;
}

async function evaluateIllustrations(options: {
  baseUrl: string;
  models: readonly string[];
  context: number;
  label: string;
}): Promise<void> {
  const { realizeIllustration } = await import('../packages/react/src/Ai/illustration.js');
  const prompts = JSON.parse(
    fs.readFileSync(path.join(corpusDir, 'illustrations.json'), 'utf8'),
  ) as IllustrationPrompt[];
  const outDir = path.join(root, 'reports/ai-diagram-evals', options.label);
  fs.mkdirSync(outDir, { recursive: true });
  const summary: string[] = [
    `# AI illustration eval: ${options.label}`,
    '',
    `Endpoint: ${options.baseUrl}; context window: ${String(options.context)}`,
    '',
  ];
  for (const model of options.models) {
    const rows: string[] = [];
    let ready = 0;
    let firstTry = 0;
    let stripped = 0;
    let fixedColors = 0;
    let seconds = 0;
    for (const [index, prompt] of prompts.entries()) {
      const log: AiChatRequest[] = [];
      const ai = endpointChat(options.baseUrl, model, process.env.DOCBLOCKS_EVAL_AI_TOKEN, log);
      const started = Date.now();
      const outcome = await realizeIllustration({
        ai,
        material: prompt.material ?? '',
        description: prompt.description,
        title: prompt.description.slice(0, 60),
        ground: Boolean(prompt.material),
        contextWindow: options.context,
      });
      const elapsed = Math.round((Date.now() - started) / 100) / 10;
      seconds += elapsed;
      const notes = outcome.status === 'ready' ? outcome.notes : [];
      if (outcome.status === 'ready') {
        ready += 1;
        if (log.length === 1) firstTry += 1;
        if (notes.some((note) => note.startsWith('Removed markup'))) stripped += 1;
        if (notes.some((note) => note.includes('fixed colors'))) fixedColors += 1;
        const markdown = outcome.compiled.render(2, new Set());
        const svg = markdown.slice(markdown.indexOf('\n') + 1, markdown.lastIndexOf('\n'));
        fs.writeFileSync(
          path.join(outDir, `${model.replace(/[^\w.-]+/gu, '_')}-${String(index + 1)}.svg`),
          svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'),
        );
      }
      const status = outcome.status === 'failed' ? `failed: ${outcome.message}` : outcome.status;
      rows.push(
        `| ${prompt.description.slice(0, 50)} | ${status}${notes.length ? ` (${notes.join(' ')})` : ''} | ` +
          `${String(log.length)} | ${String(elapsed)}s |`,
      );
      console.warn(
        `${model} illustration ${String(index + 1)}: ${status} calls=${String(log.length)}`,
      );
    }
    summary.push(
      `## ${model}`,
      '',
      `- Usable pictures: ${String(ready)}/${String(prompts.length)}; first try: ${String(firstTry)}`,
      `- Needed markup stripped: ${String(stripped)}; fixed colors: ${String(fixedColors)}`,
      `- Total time: ${String(Math.round(seconds))}s`,
      '',
      '| Prompt | Outcome | Calls | Time |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    );
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
  console.warn(`\nReport: ${path.relative(root, path.join(outDir, 'summary.md'))}`);
}

/** An `ai.images.generate` against a Gezel's `/v1/images/generations` stream. */
function endpointImages(baseUrl: string, token: string | undefined): Pick<AiImagesAPI, 'generate'> {
  return {
    generate(request) {
      const controller = new NodeAbortController();
      const done = (async (): Promise<AiResult<AiImageResult>> => {
        try {
          const response = await nodeFetch(`${baseUrl.replace(/\/$/u, '')}/v1/images/generations`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              prompt: request.prompt,
              ...(request.model ? { model: request.model } : {}),
              ...(request.aspect ? { aspect_ratio: request.aspect } : {}),
              ...(request.seed !== undefined ? { seed: request.seed } : {}),
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
          for (const line of (await response.text()).split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            const event = JSON.parse(data) as
              | { type: 'progress' }
              | {
                  type: 'done';
                  b64_png: string;
                  width: number;
                  height: number;
                  seed: number;
                  model: string;
                  duration_ms: number;
                }
              | { type: 'error'; error: { code: string; message: string } };
            if (event.type === 'error') {
              return { ok: false, error: { code: 'unknown', message: event.error.message } };
            }
            if (event.type === 'done') {
              const png = Buffer.from(event.b64_png, 'base64');
              return {
                ok: true,
                value: {
                  mimeType: 'image/png',
                  data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
                  width: event.width,
                  height: event.height,
                  seed: event.seed,
                  model: event.model,
                  durationMs: event.duration_ms,
                },
              };
            }
          }
          return {
            ok: false,
            error: { code: 'unknown', message: 'The render stream ended early.' },
          };
        } catch (error) {
          return { ok: false, error: { code: 'unknown', message: String(error) } };
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
  };
}

/** Every piece of text a vision model reads in the picture, or null without a judge. */
async function readBack(png: Buffer): Promise<string[] | null> {
  const baseUrl = process.env.DOCBLOCKS_EVAL_JUDGE_BASE_URL?.trim();
  const model = process.env.DOCBLOCKS_EVAL_JUDGE_MODEL?.trim();
  if (!baseUrl || !model) return null;
  const response = await nodeFetch(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.DOCBLOCKS_EVAL_JUDGE_TOKEN
        ? { authorization: `Bearer ${process.env.DOCBLOCKS_EVAL_JUDGE_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'List every separate piece of text visible in this image, copied exactly as it is ' +
                'spelled, including mistakes. Reply with only a JSON array of strings.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : null;
  } catch {
    return null;
  }
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/gu, ' ').trim();

/** How much of the brief the picture spells right, and what it adds. */
function scoreText(intended: readonly string[], seen: readonly string[]) {
  const read = normalized(seen.join(' \n '));
  const spelled = intended.filter((text) => read.includes(normalized(text)));
  const invented = seen.filter(
    (text) =>
      normalized(text).length > 2 &&
      !intended.some(
        (wanted) =>
          normalized(wanted).includes(normalized(text)) ||
          normalized(text).includes(normalized(wanted)),
      ),
  );
  return { spelled: spelled.length, total: intended.length, invented };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (character) =>
    character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : '&quot;',
  );
}

async function evaluateDesigns(options: {
  baseUrl: string;
  models: readonly string[];
  context: number;
  label: string;
  imageModel: string;
  /** Draw every pick as a design graphic, not only the planner's design picks. */
  designAll: boolean;
  only: string | undefined;
}): Promise<void> {
  const imagesBaseUrl = process.env.DOCBLOCKS_EVAL_IMAGES_BASE_URL?.trim();
  if (!imagesBaseUrl) {
    console.error('Set DOCBLOCKS_EVAL_IMAGES_BASE_URL to a Gezel that serves /v1/images.');
    process.exitCode = 2;
    return;
  }
  const { validateMermaidSource } = await import('@bendyline/squisq-editor-react');
  const { drawDiagram, findIdeas } =
    await import('../packages/react/src/Ai/illustrate-pipeline.js');
  const { inferKind, promptBudget } =
    await import('../packages/react/src/Ai/illustrate-prompts.js');
  const { documentTitle } = await import('../packages/react/src/Ai/illustrate-passages.js');
  const { realizeDesign } = await import('../packages/react/src/Ai/design-brief.js');
  const images = endpointImages(imagesBaseUrl, process.env.DOCBLOCKS_EVAL_IMAGES_TOKEN);
  const gold = JSON.parse(fs.readFileSync(path.join(corpusDir, 'gold.json'), 'utf8')) as Record<
    string,
    GoldEntry
  >;
  const outDir = path.join(root, 'reports/ai-diagram-evals', options.label);
  fs.mkdirSync(outDir, { recursive: true });
  const summary: string[] = [
    `# AI design graphic eval: ${options.label}`,
    '',
    `Chat: ${options.baseUrl}; images: ${imagesBaseUrl} (${options.imageModel}); context: ${String(options.context)}`,
    '',
    ...(options.designAll ? ['Every pick drawn as a design graphic (`--design-all`).', ''] : []),
  ];
  const cards: string[] = [];
  for (const model of options.models) {
    const ai = endpointChat(options.baseUrl, model, process.env.DOCBLOCKS_EVAL_AI_TOKEN, []);
    const rows: string[] = [];
    let designs = 0;
    let rendered = 0;
    let spelled = 0;
    let textTotal = 0;
    let invented = 0;
    let judged = 0;
    let overDiagram = 0;
    for (const document of Object.keys(gold)) {
      if (options.only && !document.includes(options.only)) continue;
      const source = fs.readFileSync(path.join(corpusDir, document), 'utf8');
      const found = await findIdeas({
        ai,
        source,
        title: documentTitle(source),
        budget: promptBudget(options.context),
        design: true,
      });
      if (found.status !== 'found') {
        const reason = found.status === 'failed' ? `: ${found.message.slice(0, 120)}` : '';
        rows.push(`| ${document} | plan ${found.status}${reason} | | | |`);
        console.warn(`${model} ${document}: plan ${found.status}${reason}`);
        continue;
      }
      const kinds = found.picks.map((pick) => pick.kind);
      if (kinds.length === 0 || (!options.designAll && !kinds.includes('design'))) {
        rows.push(`| ${document} | no design pick (${kinds.join(', ') || 'no picks'}) | | | |`);
        continue;
      }
      for (const [index, pick] of found.picks.entries()) {
        if (pick.kind === 'design') {
          designs += 1;
          const wanted = gold[document]?.expect.find((entry) =>
            pick.passage.text.includes(entry.marker),
          );
          if (wanted && !wanted.kinds.includes('design')) overDiagram += 1;
        } else if (!options.designAll) {
          continue;
        }
        const started = Date.now();
        const outcome = await realizeDesign({
          ai,
          images,
          model: options.imageModel,
          material: pick.passage.plain,
          title: pick.title,
          prompt: pick.prompt,
        });
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        const name = `${model.replace(/[^\w.-]+/gu, '_')}-${document.replace(/\.md$/u, '')}-${String(index + 1)}`;
        if (outcome.status !== 'ready' || !outcome.compiled.image) {
          const status =
            outcome.status === 'failed' ? `failed: ${outcome.message}` : outcome.status;
          rows.push(`| ${document} (${pick.kind}) | ${status} | | | ${String(seconds)}s |`);
          console.warn(`${model} ${document} design ${String(index + 1)}: ${status}`);
          continue;
        }
        rendered += 1;
        const png = Buffer.from(outcome.compiled.image.data);
        fs.writeFileSync(path.join(outDir, `${name}.png`), png);
        // The first note quotes every piece of text the brief asked for.
        const intended = [...(outcome.notes[0] ?? '').matchAll(/"([^"]+)"/gu)].map(
          (match) => match[1] ?? '',
        );
        const seen = await readBack(png);
        let score = 'not judged';
        if (seen) {
          judged += 1;
          const result = scoreText(intended, seen);
          spelled += result.spelled;
          textTotal += result.total;
          invented += result.invented.length;
          score = `${String(result.spelled)}/${String(result.total)} spelled; ${String(result.invented.length)} invented`;
        }
        // The same passage as a compiled diagram, for comparison by eye.
        const diagram = await drawDiagram(
          {
            passage: pick.passage,
            kind: pick.kind === 'design' ? inferKind(pick.prompt, pick.passage.plain) : pick.kind,
            title: pick.title,
            prompt: pick.prompt,
          },
          { ai, budget: promptBudget(options.context), validateMermaid: validateMermaidSource },
        );
        const diagramMarkdown =
          diagram.status === 'ready'
            ? diagram.compiled.render(2, new Set())
            : `(${diagram.status})`;
        rows.push(
          `| ${document} (${pick.kind}) | ready | ${intended.join(', ')} | ${score} | ${String(seconds)}s |`,
        );
        cards.push(
          `<section><h2>${escapeHtml(`${model} · ${document} · ${pick.title}`)}</h2>` +
            `<p>${escapeHtml(pick.passage.plain)}</p>` +
            `<div class="pair"><figure><img src="${escapeHtml(name)}.png" alt=""><figcaption>` +
            `Intended: ${escapeHtml(intended.join(' · '))}<br>Judge: ${escapeHtml(seen ? seen.join(' · ') : 'none')}` +
            `<br>${escapeHtml(score)}</figcaption></figure>` +
            `<pre>${escapeHtml(diagramMarkdown)}</pre></div>` +
            `<details><summary>Prompt</summary><p>${escapeHtml(outcome.compiled.image.prompt)}</p></details></section>`,
        );
        console.warn(`${model} ${document} design ${String(index + 1)}: ready ${score}`);
      }
    }
    summary.push(
      `## ${model}`,
      '',
      `- Design picks: ${String(designs)}; rendered: ${String(rendered)}`,
      `- On a passage gold-labelled for a compiled diagram: ${String(overDiagram)}`,
      judged > 0
        ? `- Judged ${String(judged)}: ${String(spelled)}/${String(textTotal)} pieces of text spelled right; ${String(invented)} invented`
        : '- Not judged: set DOCBLOCKS_EVAL_JUDGE_BASE_URL and DOCBLOCKS_EVAL_JUDGE_MODEL',
      '',
      '| Document | Outcome | Intended text | Text score | Time |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    );
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
  fs.writeFileSync(
    path.join(outDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>Design graphic eval</title>' +
      '<style>body{font:14px system-ui;margin:24px;max-width:1200px}.pair{display:grid;' +
      'grid-template-columns:1fr 1fr;gap:16px}img{max-width:100%;border:1px solid #ccc}' +
      'pre{white-space:pre-wrap;background:#f6f6f6;padding:8px}</style>' +
      cards.join('\n'),
  );
  console.warn(`\nReport: ${path.relative(root, path.join(outDir, 'index.html'))}`);
}

await main();
