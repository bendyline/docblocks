/**
 * `ai.chat` over an OpenAI-compatible endpoint, sending exactly the request
 * body the desktop host sends (`buildChatCompletionBody`), plus a seed.
 *
 * Every call is recorded, and transport failures are told apart from model
 * failures: a refused connection, an HTTP error or a timeout is the
 * endpoint's fault, and a harness should retry or exclude that case rather
 * than score the model on it.
 */

import {
  buildChatCompletionBody,
  type AiChatCompletion,
  type AiChatRequest,
  type AiResult,
  type DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import type { BenchCall } from './contract.js';

export interface EndpointOptions {
  /** The OpenAI-compatible base URL, ending in `/v1`. */
  readonly baseUrl: string;
  /** The model id to send, such as `llama-cpp:gemma4-12b-q4`. */
  readonly model: string;
  readonly token?: string;
  readonly seed?: number;
  /** The context window the product would size budgets for. */
  readonly contextWindow: number | null;
  /** Longest one request may take before it counts as an endpoint failure. */
  readonly requestTimeoutMs: number;
  readonly fetch: typeof fetch;
  readonly AbortController: typeof AbortController;
}

export interface RecordedCall extends BenchCall {
  /** The failure was the endpoint's, not the model's. */
  readonly infra: boolean;
  readonly error: string | null;
  readonly request: AiChatRequest;
  readonly text: string;
}

/** A completion body, or one streamed chunk of one. */
interface CompletionBody {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly delta?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly gezel_max_tokens?: number;
  /** Gezel ends a failed stream with `{ error }` instead of a finish reason. */
  readonly error?: { readonly message?: unknown; readonly code?: unknown };
}

/**
 * Gezel failure codes that are the engine's or the machine's, not the
 * model's: the case is retried and, failing again, excluded. Anything else a
 * stream ends with — the ramble guard, a grammar the template rejects — is
 * what a person using that model in DocBlocks would get, so it counts.
 */
const INFRA_FAILURE_CODES: ReadonlySet<string> = new Set([
  'capacity_denied',
  'engine_busy',
  'engine_launch_failed',
  'engine_crashed',
  'engine_out_of_memory',
  'engine_not_ready',
  'model_not_ready',
]);

interface CompletionReply {
  readonly text: string;
  readonly truncated: boolean;
  /** The stream ended in an error instead of a reply. */
  readonly failure: { readonly message: string; readonly infra: boolean } | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly engineMaxTokens: number | null;
}

/** The blank line that ends a server-sent event. */
const EVENT_END = /\r?\n\r?\n/u;

/**
 * Read a completion, streamed (server-sent events) or not: a server may
 * ignore `stream`, and both shapes carry the same fields.
 */
async function readCompletion(response: Response): Promise<CompletionReply> {
  const reply = {
    text: '',
    finish: null as string | null,
    promptTokens: null as number | null,
    completionTokens: null as number | null,
    engineMaxTokens: null as number | null,
    failure: null as { message: string; infra: boolean } | null,
  };
  const take = (body: CompletionBody, streamed: boolean) => {
    if (body.error) {
      const code = typeof body.error.code === 'string' ? body.error.code : '';
      const message =
        typeof body.error.message === 'string' && body.error.message
          ? body.error.message
          : 'The stream ended in an error.';
      reply.failure = {
        message: `${code ? `${code}: ` : ''}${message}`.slice(0, 500),
        infra: INFRA_FAILURE_CODES.has(code),
      };
      return;
    }
    const choice = body.choices?.[0];
    const piece = streamed ? choice?.delta?.content : choice?.message?.content;
    if (typeof piece === 'string') reply.text += piece;
    if (choice?.finish_reason) reply.finish = choice.finish_reason;
    reply.promptTokens = nonNegative(body.usage?.prompt_tokens) ?? reply.promptTokens;
    reply.completionTokens = nonNegative(body.usage?.completion_tokens) ?? reply.completionTokens;
    reply.engineMaxTokens = nonNegative(body.gezel_max_tokens) ?? reply.engineMaxTokens;
  };
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    take((await response.json()) as CompletionBody, false);
  } else {
    let buffer = '';
    const flush = (block: string) => {
      for (const line of block.split(/\r?\n/u)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        take(JSON.parse(data) as CompletionBody, true);
      }
    };
    const decoder = new TextDecoder();
    const reader = response.body?.getReader();
    for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
      buffer += decoder.decode(read.value, { stream: true });
      for (let event = EVENT_END.exec(buffer); event; event = EVENT_END.exec(buffer)) {
        flush(buffer.slice(0, event.index));
        buffer = buffer.slice(event.index + event[0].length);
      }
    }
    flush(buffer + decoder.decode());
  }
  return {
    text: reply.text,
    truncated: reply.finish === 'length',
    failure: reply.failure,
    promptTokens: reply.promptTokens,
    completionTokens: reply.completionTokens,
    engineMaxTokens: reply.engineMaxTokens,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, '');
}

function headers(token: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** A count a server reported, or null when it reported none or nonsense. */
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function endpointChat(
  options: EndpointOptions,
  calls: RecordedCall[],
): Pick<DocBlocksHostAiAPI, 'chat'> {
  const chat: DocBlocksHostAiAPI['chat'] = (request) => {
    const controller = new options.AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.requestTimeoutMs);
    const started = Date.now();
    const record = (call: Omit<RecordedCall, 'ms' | 'request'>) =>
      calls.push({ ...call, ms: Date.now() - started, request });

    const done = (async (): Promise<AiResult<AiChatCompletion>> => {
      const body = buildChatCompletionBody(
        { ...request, model: options.model, contextWindow: options.contextWindow },
        options.seed === undefined ? {} : { seed: options.seed },
      );
      try {
        const response = await options.fetch(`${trimSlash(options.baseUrl)}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: headers(options.token),
          // Streamed, as the desktop sends it. It also keeps a slow model's
          // reply inside Node fetch's limits: headers arrive at once, and
          // chunks keep coming, where a buffered reply sends nothing for many
          // minutes and fetch gives up on it at five.
          body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
        });
        if (!response.ok) {
          const message = `HTTP ${String(response.status)}: ${(await response.text()).slice(0, 500)}`;
          // A 4xx about the request body is ours to fix, but never the model's fault either.
          record({
            promptTokens: null,
            completionTokens: null,
            finishReason: 'error',
            infra: true,
            error: message,
            text: '',
          });
          return { ok: false, error: { code: 'unknown', message } };
        }
        const reply = await readCompletion(response);
        const { text, truncated, engineMaxTokens } = reply;
        if (reply.failure) {
          // The product shows this as an error, not as an empty reply.
          record({
            promptTokens: reply.promptTokens,
            completionTokens: reply.completionTokens,
            finishReason: 'error',
            infra: reply.failure.infra,
            error: reply.failure.message,
            text,
          });
          return { ok: false, error: { code: 'unknown', message: reply.failure.message } };
        }
        record({
          promptTokens: reply.promptTokens,
          completionTokens: reply.completionTokens,
          finishReason: truncated ? 'length' : 'stop',
          ...(engineMaxTokens === null ? {} : { engineMaxTokens }),
          infra: false,
          error: null,
          text,
        });
        return {
          ok: true,
          value: {
            text,
            finishReason: truncated ? 'length' : 'stop',
            model: options.model,
            usage: null,
          },
        };
      } catch (error: unknown) {
        const message = timedOut
          ? `The request took longer than ${String(options.requestTimeoutMs)} ms.`
          : error instanceof Error
            ? error.message
            : String(error);
        if (controller.signal.aborted && !timedOut) {
          record({
            promptTokens: null,
            completionTokens: null,
            finishReason: 'cancelled',
            infra: false,
            error: null,
            text: '',
          });
          return {
            ok: true,
            value: { text: '', finishReason: 'cancelled', model: options.model, usage: null },
          };
        }
        record({
          promptTokens: null,
          completionTokens: null,
          finishReason: 'error',
          infra: true,
          error: message,
          text: '',
        });
        return { ok: false, error: { code: 'unknown', message } };
      } finally {
        clearTimeout(timer);
      }
    })();
    return { done, cancel: () => controller.abort() };
  };
  return { chat };
}

interface ModelListing {
  readonly id?: unknown;
  readonly context_window?: unknown;
  readonly meta?: { readonly n_ctx_train?: unknown };
}

/**
 * The context window the endpoint reports for `model`: Gezel's
 * `context_window` (what the desktop sizes its budgets from), else
 * llama-server's training context. Null when the endpoint says nothing.
 */
export async function endpointContextWindow(
  options: Pick<EndpointOptions, 'baseUrl' | 'model' | 'token' | 'fetch'>,
): Promise<number | null> {
  try {
    const response = await options.fetch(`${trimSlash(options.baseUrl)}/models`, {
      headers: headers(options.token),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { readonly data?: readonly ModelListing[] };
    const entries = body.data ?? [];
    const bare = options.model.replace(/^[a-z0-9-]+:/u, '');
    const entry =
      entries.find((item) => item.id === options.model) ??
      entries.find((item) => item.id === bare) ??
      (entries.length === 1 ? entries[0] : undefined);
    if (!entry) return null;
    const window = nonNegative(entry.context_window) ?? nonNegative(entry.meta?.n_ctx_train);
    return window && window > 0 ? Math.floor(window) : null;
  } catch {
    return null;
  }
}
