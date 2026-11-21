/**
 * Ground AI requests in the person's own workspace: passages the index finds
 * by meaning travel with the request, and the host offers them to the model
 * beside its knowledge catalogs' (see `withWorkspacePassages` in core).
 *
 * Grounding never blocks a request: no index, no ranking, no meaning, a slow
 * search or a failure all send the request without workspace passages.
 */
import { useEffect, useState } from 'react';
import {
  AI_WIRE_LIMITS,
  workspacePassageUri,
  type AiChatRequest,
  type AiStatus,
  type AiWorkspacePassage,
  type DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import type { WorkspaceIndex } from '@bendyline/docblocks/workspace-index';

/**
 * How long a request waits for workspace passages. Covers embedding the
 * query, including reloading an idle embedding model (~0.6 s on a laptop).
 */
export const WORKSPACE_GROUNDING_DEADLINE_MS = 1_200;

/** Passages per note: several notes say more than one note said thrice. */
const PER_DOCUMENT = 2;

/**
 * A DNS-label catalog id for a workspace, as citation URIs require
 * (`knowledge://local/<catalog>/<path>`): `ws-` and a 64-bit FNV-1a hash.
 */
export function workspaceCatalogId(workspaceId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of workspaceId) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `ws-${hash.toString(16).padStart(16, '0')}`;
}

/** The note's title and the headings above the passage, as one label. */
function passageTitle(title: string, headingPath: readonly string[]): string {
  const headings = headingPath[0] === title ? headingPath.slice(1) : headingPath;
  return [title, ...headings]
    .filter(Boolean)
    .join(' › ')
    .slice(0, AI_WIRE_LIMITS.knowledgeTitleCharacters);
}

export interface WorkspacePassageOptions {
  /** Notes to leave out, such as the one the request is about. */
  readonly exclude?: ReadonlySet<string>;
  readonly deadlineMs?: number;
}

/**
 * Up to {@link AI_WIRE_LIMITS.workspacePassages} passages found by meaning,
 * within the wire's character budget; empty when there are none in time.
 */
export async function findWorkspacePassages(
  index: WorkspaceIndex | null,
  workspaceId: string,
  query: string,
  options: WorkspacePassageOptions = {},
): Promise<AiWorkspacePassage[]> {
  const text = query.trim();
  if (!index?.find || !index.getStatus().ranked || !text) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.deadlineMs ?? WORKSPACE_GROUNDING_DEADLINE_MS);
  });
  let hits: Awaited<ReturnType<NonNullable<WorkspaceIndex['find']>>> | null;
  try {
    hits = await Promise.race([
      index.find(text.slice(0, AI_WIRE_LIMITS.knowledgeQueryCharacters), {
        limit: AI_WIRE_LIMITS.workspacePassages * 2,
        perDocument: PER_DOCUMENT,
        text: true,
        ...(options.exclude ? { exclude: options.exclude } : {}),
      }),
      late,
    ]);
  } catch {
    hits = null;
  } finally {
    clearTimeout(timer);
  }
  if (!hits) return [];
  const catalogId = workspaceCatalogId(workspaceId);
  const passages: AiWorkspacePassage[] = [];
  let characters = 0;
  for (const hit of hits) {
    // Only what meaning found clears the bar Gezel holds unjudged passages to.
    if (!hit.meaning || !hit.text?.trim()) continue;
    if (passages.length >= AI_WIRE_LIMITS.workspacePassages) break;
    const passageText = hit.text.slice(0, AI_WIRE_LIMITS.workspacePassageCharacters);
    if (characters + passageText.length > AI_WIRE_LIMITS.workspacePassagesCharacters) continue;
    // A note whose path the citation grammar cannot name is not offered.
    const uri = workspacePassageUri(catalogId, hit.path, hit.lineStart, hit.lineEnd);
    if (!uri) continue;
    passages.push({
      uri,
      title: passageTitle(hit.title || hit.path, hit.headingPath),
      text: passageText,
    });
    characters += passageText.length;
  }
  return passages;
}

/**
 * Words from a passage that Find can land on in its note: its first line, cut
 * at a word boundary. The passage text is the index's search text, which is
 * the text a reader sees, so it matches the rendered note.
 */
export function findTextForPassage(text: string): string {
  const line =
    text
      .split('\n')
      .find((entry) => entry.trim())
      ?.trim() ?? '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return space > 20 ? cut.slice(0, space) : cut;
}

type ChatApi = Pick<DocBlocksHostAiAPI, 'chat'>;

/**
 * `ai` whose requests that search knowledge (`knowledgeQuery` set) also carry
 * workspace passages from `ground`. Cancelling while passages are found
 * cancels the request before it starts.
 */
export function withWorkspaceGrounding<A extends ChatApi>(
  ai: A,
  ground: (request: AiChatRequest) => Promise<readonly AiWorkspacePassage[]>,
): A {
  const chat: ChatApi['chat'] = (request, onEvent) => {
    if (!request.knowledgeQuery || request.workspacePassages) return ai.chat(request, onEvent);
    let inner: ReturnType<ChatApi['chat']> | null = null;
    let cancelled = false;
    const done = (async () => {
      const passages = await ground(request).catch(() => []);
      if (cancelled) {
        return {
          ok: false as const,
          error: { code: 'cancelled' as const, message: 'The request was cancelled.' },
        };
      }
      inner = ai.chat(
        passages.length ? { ...request, workspacePassages: [...passages] } : request,
        onEvent,
      );
      return inner.done;
    })();
    return {
      done,
      cancel() {
        cancelled = true;
        inner?.cancel();
      },
    };
  };
  return { ...ai, chat };
}

/** True while the AI provider runs remotely (its requests leave this device). */
export function useAiProviderRemote(
  ai: Pick<DocBlocksHostAiAPI, 'status' | 'onStatus'> | undefined,
): boolean {
  const [remote, setRemote] = useState(false);
  useEffect(() => {
    if (!ai) {
      setRemote(false);
      return;
    }
    let live = true;
    const apply = (status: AiStatus) => {
      if (live) setRemote(status.kind === 'ready' && status.provider.mode === 'remote');
    };
    void ai.status().then(apply, () => undefined);
    const stop = ai.onStatus(apply);
    return () => {
      live = false;
      stop();
    };
  }, [ai]);
  return remote;
}
