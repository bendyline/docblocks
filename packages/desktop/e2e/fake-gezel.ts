/**
 * A stand-in for the person's installed Gezel, speaking only the parts of the
 * local app protocol DocBlocks uses: health, app registration with a typed
 * verification code, grant polling, model listing, and streamed chat.
 *
 * Discovery reads `<GEZEL_HOME>/runtime/port` and uses plain HTTP when there
 * is no `cert.pem`, so no TLS is involved. Chat answers are scripted from the
 * request itself so the editor flows are deterministic; pass `upstream` to
 * forward chat to a real OpenAI-compatible server instead.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export const FAKE_GEZEL_TOKEN = 'fake-gezel-token';
export const FAKE_GEZEL_CODE = '428-913';
export const FAKE_GEZEL_MODEL = 'mlx:fake-writer-q4';
export const FAKE_COMPOSE_TEXT = 'This closing paragraph was drafted by the fake Gezel.';
export const FAKE_REWRITE_TEXT = 'The fake Gezel rewrote this sentence.';
export const FAKE_REVIEW_SUFFIX = ' (reviewed)';

interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface RecordedChat {
  readonly authorization: string | undefined;
  readonly model: unknown;
  readonly stream: unknown;
  readonly maxTokens: unknown;
  readonly messages: readonly ChatMessage[];
}

export interface FakeGezel {
  readonly home: string;
  readonly chats: readonly RecordedChat[];
  readonly registrations: number;
  /** Chat streams the client closed before the last chunk. */
  readonly abandonedStreams: number;
  /** Approve the pending connection, as a person typing the code would. */
  approve(): void;
  close(): Promise<void>;
}

export interface FakeGezelOptions {
  readonly home: string;
  /** Forward chat to this OpenAI-compatible base URL instead of scripting it. */
  readonly upstream?: { readonly baseUrl: string; readonly model: string };
  /** Pause between scripted chunks, so a test can stop a stream midway. */
  readonly chunkDelayMs?: number;
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function documentFrom(messages: readonly ChatMessage[]): string {
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  const match = /<document>\n([\s\S]*?)\n<\/document>/u.exec(user);
  return match?.[1] ?? '';
}

/** One finding on the first plain prose line that occurs exactly once. */
function scriptedReview(source: string): string {
  const line = source
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.length > 24 &&
        /^[A-Za-z]/u.test(candidate) &&
        source.indexOf(candidate) === source.lastIndexOf(candidate),
    );
  if (!line) return '[]';
  return JSON.stringify([
    {
      quote: line,
      replacement: `${line}${FAKE_REVIEW_SUFFIX}`,
      category: 'Clarity',
      severity: 'suggestion',
      message: 'Mark this sentence as reviewed.',
      rationale: 'A deterministic finding from the fake Gezel.',
    },
    {
      quote: line,
      replacement: null,
      category: 'Tone',
      severity: 'info',
      message: 'An informational note with nothing to apply.',
      rationale: null,
    },
  ]);
}

const YEAR = /\b(1\d{3}|2\d{3})\b/gu;
const FILLER = new Set(['the', 'a', 'an', 'and', 'in', 'its', 'of', 'to', 'then', 'was', 'it']);

/** Up to `count` words from `text` that are not filler, for grounded labels. */
function words(text: string, count: number, fromEnd = false): string {
  const kept = (text.match(/[A-Za-z][A-Za-z-]*/gu) ?? []).filter(
    (word) => !FILLER.has(word.toLowerCase()),
  );
  return (fromEnd ? kept.slice(-count) : kept.slice(0, count)).join(' ');
}

/**
 * The planner's picks: the first two passages offered, a timeline for one
 * with several years in it and a flowchart otherwise.
 */
function scriptedPlan(messages: readonly ChatMessage[]): string {
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  const passages = [...user.matchAll(/<passage id="(P\d+)"[^>]*>\n([\s\S]*?)\n<\/passage>/gu)];
  return JSON.stringify(
    passages.slice(0, 2).map(([, id, text]) => {
      const dated = (text?.match(YEAR) ?? []).length >= 2;
      return {
        passage: id,
        kind: dated ? 'timeline' : 'flow',
        title: dated ? 'Milestones' : 'How it works',
        why: 'A deterministic pick from the fake Gezel.',
      };
    }),
  );
}

/** A diagram spec built only from the passage's own words, so it is grounded. */
function scriptedDiagram(messages: readonly ChatMessage[]): string {
  const system = messages.find((message) => message.role === 'system')?.content ?? '';
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  const passage = /<passage>\n([\s\S]*?)\n<\/passage>/u.exec(user)?.[1] ?? '';
  if (system.includes('into a timeline')) {
    const segments = passage.split(YEAR);
    const events: { when: string; label: string }[] = [];
    for (let index = 1; index < segments.length; index += 2) {
      events.push({
        when: segments[index] ?? '',
        label: words(segments[index - 1] ?? '', 3, true),
      });
    }
    return JSON.stringify({ events });
  }
  const sentences = passage.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim());
  const nodes = sentences.slice(0, 4).map((sentence, index) => ({
    id: `n${String(index + 1)}`,
    label: words(sentence, 3),
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]?.id, to: node.id }));
  return JSON.stringify({ direction: 'LR', nodes, edges });
}

function scriptedAnswer(messages: readonly ChatMessage[]): string {
  const system = messages.find((message) => message.role === 'system')?.content ?? '';
  if (system.includes('You plan illustrations')) return scriptedPlan(messages);
  if (system.includes('You turn one passage into')) return scriptedDiagram(messages);
  if (system.includes('document reviewer')) return scriptedReview(documentFrom(messages));
  if (system.includes('Rewrite only the supplied selection')) return FAKE_REWRITE_TEXT;
  return FAKE_COMPOSE_TEXT;
}

function chunk(content: string | null, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 0,
    model: FAKE_GEZEL_MODEL,
    choices: [
      { index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason },
    ],
  })}\n\n`;
}

/** Stream `text` in small deltas; false when the client went away first. */
async function streamScripted(
  response: http.ServerResponse,
  text: string,
  delayMs: number,
): Promise<boolean> {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  // Several deltas, so the renderer's streaming path is exercised.
  const pieces = text.match(/[\s\S]{1,16}/gu) ?? [];
  for (const piece of pieces) {
    if (response.destroyed) return false;
    response.write(chunk(piece, null));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (response.destroyed) return false;
  response.write(chunk(null, 'stop'));
  response.end('data: [DONE]\n\n');
  return true;
}

async function streamUpstream(
  response: http.ServerResponse,
  body: Record<string, unknown>,
  upstream: NonNullable<FakeGezelOptions['upstream']>,
): Promise<void> {
  const forwarded = await fetch(`${upstream.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, model: upstream.model, stream: true }),
  });
  if (!forwarded.ok || !forwarded.body) {
    sendJson(response, 502, { error: { code: 'upstream_failed', message: forwarded.statusText } });
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for await (const piece of forwarded.body) response.write(piece);
  response.end();
}

export async function startFakeGezel(options: FakeGezelOptions): Promise<FakeGezel> {
  const chats: RecordedChat[] = [];
  let registrations = 0;
  let abandonedStreams = 0;
  let approved = false;
  const waiters = new Set<() => void>();

  const authorized = (request: http.IncomingMessage) =>
    request.headers.authorization === `Bearer ${FAKE_GEZEL_TOKEN}`;

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { status: 'ok', version: '0.0.0-fake' });
      } else if (request.method === 'POST' && url.pathname === '/v1/apps/register') {
        await readJson(request);
        registrations += 1;
        sendJson(response, 202, {
          status: 'pending',
          grantRequestId: 'grant-1',
          verificationRequired: true,
          verificationCode: FAKE_GEZEL_CODE,
        });
      } else if (request.method === 'GET' && url.pathname === '/v1/apps/grant/grant-1') {
        if (!approved) {
          const waitMs = Math.min(Number(url.searchParams.get('wait') ?? '1'), 5) * 1_000;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            };
            const timer = setTimeout(done, waitMs);
            waiters.add(done);
          });
        }
        sendJson(
          response,
          200,
          approved ? { status: 'approved', token: FAKE_GEZEL_TOKEN } : { status: 'pending' },
        );
      } else if (request.method === 'DELETE' && url.pathname.startsWith('/v1/apps/')) {
        response.writeHead(204).end();
      } else if (!authorized(request)) {
        sendJson(response, 401, { error: { code: 'unauthorized', message: 'Unauthorized' } });
      } else if (request.method === 'GET' && url.pathname === '/v1/knowledge/state') {
        sendJson(response, 200, {
          catalogs: [],
          reranker: { ready: true, downloading: false, message: null },
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/knowledge/retrieve') {
        const query = await readJson(request);
        if (query.rerank !== 'required') {
          sendJson(response, 400, {
            error: { code: 'reranker_required', message: 'Reranking is required.' },
          });
        } else sendJson(response, 200, { reranked: true, passages: [] });
      } else if (request.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(response, 200, {
          object: 'list',
          data: [
            {
              id: FAKE_GEZEL_MODEL,
              object: 'model',
              // The App SDK validates the listing, and `created` is required.
              created: 0,
              owned_by: 'mlx',
              name: 'Fake Writer',
              context_window: 32_768,
            },
          ],
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(request);
        const messages = (body.messages ?? []) as ChatMessage[];
        chats.push({
          authorization: request.headers.authorization,
          model: body.model,
          stream: body.stream,
          maxTokens: body.max_tokens,
          messages,
        });
        if (options.upstream) await streamUpstream(response, body, options.upstream);
        else if (
          !(await streamScripted(response, scriptedAnswer(messages), options.chunkDelayMs ?? 0))
        ) {
          abandonedStreams += 1;
        }
      } else {
        sendJson(response, 404, { error: { code: 'not_found', message: url.pathname } });
      }
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: { code: 'fake_failed', message: String(error) } });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fs.mkdirSync(path.join(options.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(options.home, 'runtime', 'port'), String(port), 'utf8');

  return {
    home: options.home,
    chats,
    get registrations() {
      return registrations;
    },
    get abandonedStreams() {
      return abandonedStreams;
    },
    approve() {
      approved = true;
      for (const wake of [...waiters]) wake();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
