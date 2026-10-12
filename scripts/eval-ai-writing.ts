/**
 * A/B DocBlocks' AI writing with the model's thinking phase off and on.
 *
 * Sends the exact requests the Rewrite and Add-content dialog sends
 * (`buildDraftRequest`) twice per case: once with `reasoning_effort: 'none'`,
 * which is what DocBlocks sends today, and once with the model's default,
 * which thinks first on a thinking model. Each response is streamed so the
 * report can separate the wait for the first words from the whole answer.
 *
 * Writes to reports/ai-writing-evals/<label>/:
 *   results.json  timings, finish reasons, and every output
 *   summary.md    the timing table, per case and as medians
 *   judge.html    blind side-by-side pairs; pick the better draft, then reveal
 *
 * Not part of `npm run all` — it needs a running model and takes a while:
 *
 *   DOCBLOCKS_EVAL_AI_BASE_URL=http://127.0.0.1:8080/v1 \
 *   DOCBLOCKS_EVAL_AI_MODELS=mlx:qwen3.8-27b-q4 \
 *   npm run eval:ai-writing -- --label thinking-ab
 *
 * The base URL is any OpenAI-compatible endpoint; a Gezel daemon needs a token
 * in DOCBLOCKS_EVAL_AI_TOKEN, and its loopback TLS certificate is self-signed
 * (NODE_TLS_REJECT_UNAUTHORIZED=0 for this run only). `--docs <dir>` adds a
 * whole-document rewrite for every Markdown file in that folder; `--only
 * <text>` runs the cases whose id contains it.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AiChatRequest } from '@bendyline/docblocks/host';

import { buildDraftRequest } from '../packages/react/src/Ai/ai-assistant.js';

const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(root, 'packages/react/test/fixtures/ai-diagrams');

type Arm = 'thinking-off' | 'model-default';
const ARMS: readonly Arm[] = ['thinking-off', 'model-default'];

interface Case {
  readonly id: string;
  readonly mode: 'rewrite' | 'compose';
  readonly instructions: string;
  readonly document: string;
  readonly selection: string;
}

interface Run {
  readonly arm: Arm;
  readonly firstTextSeconds: number | null;
  readonly totalSeconds: number;
  readonly finishReason: string | null;
  readonly text: string;
  /** Characters of reasoning, when the endpoint forwards it at all. */
  readonly reasoningCharacters: number;
  readonly error: string | null;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The first paragraph long enough to be worth rewriting. */
function firstParagraph(markdown: string): string {
  const paragraphs = markdown
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter((block) => !/^(#|\||```|- |\* |\d+\. |>)/u.test(block));
  return paragraphs.find((block) => block.length >= 200) ?? paragraphs[0] ?? markdown;
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function cases(extraDocs: string | undefined): Case[] {
  const doc = (name: string) => read(path.join(fixtures, `${name}.md`));
  const speech = read(path.join(root, 'docs/speech.md'));
  const desktop = read(path.join(root, 'packages/desktop/README.md'));
  const list: Case[] = [
    {
      id: 'rewrite-shorter-company-history',
      mode: 'rewrite',
      instructions: 'Make this shorter and more direct.',
      document: doc('company-history'),
      selection: firstParagraph(doc('company-history')),
    },
    {
      id: 'rewrite-plain-hosting-options',
      mode: 'rewrite',
      instructions: 'Rewrite this for a reader who is not technical.',
      document: doc('hosting-options'),
      selection: firstParagraph(doc('hosting-options')),
    },
    {
      id: 'rewrite-persuasive-opinion-essay',
      mode: 'rewrite',
      instructions: 'Make the argument more persuasive without adding new claims.',
      document: doc('opinion-essay'),
      selection: firstParagraph(doc('opinion-essay')),
    },
    {
      id: 'rewrite-tighten-speech-section',
      mode: 'rewrite',
      instructions: 'Tighten the wording and fix any grammar.',
      document: speech,
      selection: firstParagraph(speech),
    },
    {
      id: 'compose-intro-release-process',
      mode: 'compose',
      instructions: 'Add a concise introduction for this document.',
      document: doc('release-process'),
      selection: '',
    },
    {
      // The shape that timed out in the app: a long selection, whole document.
      id: 'rewrite-whole-desktop-readme',
      mode: 'rewrite',
      instructions: 'Make this whole document more concise and easier to scan.',
      document: desktop,
      selection: desktop,
    },
  ];
  if (extraDocs) {
    for (const name of fs.readdirSync(extraDocs).filter((file) => file.endsWith('.md'))) {
      const markdown = read(path.join(extraDocs, name));
      list.push({
        id: `rewrite-whole-${name.replace(/\.md$/u, '')}`,
        mode: 'rewrite',
        instructions: 'Make this whole document more concise and easier to scan.',
        document: markdown,
        selection: markdown,
      });
    }
  }
  return list;
}

/** Stream one request, timing the first text and the whole answer. */
async function stream(
  baseUrl: string,
  token: string | undefined,
  model: string,
  request: AiChatRequest,
  arm: Arm,
  timeoutMs: number,
): Promise<Run> {
  const started = performance.now();
  const seconds = (at: number) => Math.round((at - started) / 100) / 10;
  let firstText: number | null = null;
  let text = '';
  let reasoning = 0;
  let finishReason: string | null = null;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        ...(arm === 'thinking-off' ? { reasoning_effort: 'none' } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${String(response.status)}: ${await response.text()}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const chunk = JSON.parse(data) as {
          error?: { message?: string };
          choices?: {
            delta?: { content?: string | null; reasoning_content?: string | null };
            finish_reason?: string | null;
          }[];
        };
        if (chunk.error) throw new Error(chunk.error.message ?? 'stream error');
        const choice = chunk.choices?.[0];
        const piece = choice?.delta?.content ?? '';
        if (piece) {
          firstText ??= performance.now();
          text += piece;
        }
        reasoning += choice?.delta?.reasoning_content?.length ?? 0;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return {
      arm,
      firstTextSeconds: firstText === null ? null : seconds(firstText),
      totalSeconds: seconds(performance.now()),
      finishReason,
      text,
      reasoningCharacters: reasoning,
      error: null,
    };
  } catch (error) {
    return {
      arm,
      firstTextSeconds: firstText === null ? null : seconds(firstText),
      totalSeconds: seconds(performance.now()),
      finishReason,
      text,
      reasoningCharacters: reasoning,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const escape = (value: string) =>
  value.replace(/[&<>"']/gu, (char) => `&#${String(char.charCodeAt(0))};`);

/** A stable shuffle, so rerendering a report never reshuffles a judged page. */
function flip(id: string): boolean {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash & 1) === 1;
}

function judgePage(model: string, results: readonly { case: Case; runs: readonly Run[] }[]) {
  const pairs = results
    .map(({ case: item, runs }, index) => {
      const ordered = flip(`${model}:${item.id}`) ? [...runs].reverse() : runs;
      const drafts = ordered
        .map(
          (run, slot) => `
        <div class="draft">
          <label><input type="radio" name="pick-${String(index)}" value="${run.arm}"> Draft ${String(slot + 1)} is better</label>
          <pre>${escape(run.error ? `Error: ${run.error}\n\n${run.text}` : run.text)}</pre>
          <p class="arm" hidden>${run.arm} · first text ${String(run.firstTextSeconds ?? '–')}s · total ${String(run.totalSeconds)}s · ${String(run.finishReason ?? 'no finish')}</p>
        </div>`,
        )
        .join('');
      return `
    <section>
      <h2>${escape(item.id)}</h2>
      <p><strong>Instructions:</strong> ${escape(item.instructions)}</p>
      <details><summary>${item.mode === 'rewrite' ? 'Selection' : 'Document'}</summary><pre>${escape(item.selection || item.document)}</pre></details>
      <label class="tie"><input type="radio" name="pick-${String(index)}" value="tie"> About the same</label>
      <div class="pair">${drafts}</div>
    </section>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Writing A/B</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --panel: #f5f5f7; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #f2f2f2; --muted: #a1a1a6; --line: #3a3a3c; --panel: #1f1f1f; } }
  body { margin: 0 auto; max-width: 1200px; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  section { border-top: 1px solid var(--line); padding: 16px 0; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .draft { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px; min-width: 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, monospace; max-height: 28em; overflow: auto; }
  .arm, .tie { color: var(--muted); }
  #tally { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: 12px 0; }
</style>
</head>
<body>
<h1>Writing A/B: ${escape(model)}</h1>
<p>Each pair is the same request with thinking off and with the model's default. Their order is shuffled. Pick the better draft, then reveal.</p>
${pairs}
<div id="tally"><button type="button" id="reveal">Reveal arms and tally</button> <span id="score"></span></div>
<script>
  document.getElementById('reveal').addEventListener('click', () => {
    document.querySelectorAll('.arm').forEach((node) => { node.hidden = false; });
    const counts = { 'thinking-off': 0, 'model-default': 0, tie: 0 };
    document.querySelectorAll('input[type=radio]:checked').forEach((input) => { counts[input.value] += 1; });
    document.getElementById('score').textContent =
      'Thinking off: ' + counts['thinking-off'] + ' · Model default: ' + counts['model-default'] + ' · Same: ' + counts.tie;
  });
</script>
</body>
</html>
`;
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
  const token = process.env.DOCBLOCKS_EVAL_AI_TOKEN;
  const label = option('label') ?? `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const only = option('only');
  const timeoutMs = Number(option('timeout-minutes') ?? '30') * 60_000;
  const selected = cases(option('docs')).filter((item) => !only || item.id.includes(only));
  const outDir = path.join(root, 'reports/ai-writing-evals', label);
  fs.mkdirSync(outDir, { recursive: true });
  const summary = [`# Writing A/B: ${label}`, '', `Endpoint: ${baseUrl}`, ''];

  for (const model of models) {
    const results: { case: Case; runs: Run[] }[] = [];
    for (const [index, item] of selected.entries()) {
      const request = buildDraftRequest({
        mode: item.mode,
        instructions: item.instructions,
        documentSource: item.document,
        selectedText: item.selection,
      });
      // Alternate which arm runs first: the second can reuse the first's
      // prompt cache, and that advantage must not always go to one arm.
      const order = index % 2 ? [...ARMS].reverse() : ARMS;
      const runs: Run[] = [];
      for (const arm of order) {
        const run = await stream(baseUrl, token, model, request, arm, timeoutMs);
        runs.push(run);
        console.warn(
          `${model} ${item.id} ${arm}: first text ${String(run.firstTextSeconds ?? '–')}s, ` +
            `total ${String(run.totalSeconds)}s, ${String(run.text.length)} chars, ` +
            `${run.error ?? run.finishReason ?? 'no finish'}`,
        );
      }
      results.push({ case: item, runs: ARMS.map((arm) => runs.find((run) => run.arm === arm)!) });
    }

    summary.push(
      `## ${model}`,
      '',
      '| Case | Arm | First text (s) | Total (s) | Output chars | Finish |',
      '| --- | --- | ---: | ---: | ---: | --- |',
    );
    for (const { case: item, runs } of results) {
      for (const run of runs) {
        summary.push(
          `| ${item.id} | ${run.arm} | ${String(run.firstTextSeconds ?? '–')} | ` +
            `${String(run.totalSeconds)} | ${String(run.text.length)} | ` +
            `${run.error ? `error: ${run.error.replace(/\|/gu, '/')}` : (run.finishReason ?? '–')} |`,
        );
      }
    }
    summary.push('', '| Arm | Median first text (s) | Median total (s) | Errors | Hit the limit |');
    summary.push('| --- | ---: | ---: | ---: | ---: |');
    for (const arm of ARMS) {
      const runs = results.map((result) => result.runs.find((run) => run.arm === arm)!);
      const first = runs.flatMap((run) =>
        run.firstTextSeconds === null ? [] : [run.firstTextSeconds],
      );
      summary.push(
        `| ${arm} | ${String(median(first) ?? '–')} | ${String(median(runs.map((run) => run.totalSeconds)))} | ` +
          `${String(runs.filter((run) => run.error).length)} | ` +
          `${String(runs.filter((run) => run.finishReason === 'length').length)} |`,
      );
    }
    summary.push('');

    const slug = model.replace(/[^\w.-]+/gu, '_');
    fs.writeFileSync(path.join(outDir, `${slug}.json`), `${JSON.stringify(results, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, `${slug}-judge.html`), judgePage(model, results));
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
  console.warn(`\nWrote ${path.relative(root, outDir)}/`);
}

await main();
