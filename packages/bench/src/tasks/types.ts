import type { AiChatRequest } from '@bendyline/docblocks/host';
import type { ChatApi } from '@bendyline/docblocks-react/ai';
import type {
  BenchArtifact,
  BenchCaseInfo,
  BenchCheck,
  BenchJudgeInput,
  BenchTaskInfo,
} from '../contract.js';

/** What a task case runs with. */
export interface TaskContext {
  /** The model under test, behind the product's `ai.chat` contract. */
  readonly ai: ChatApi;
  readonly contextWindow: number | null;
  /** "Today" for prompts that state the date. */
  readonly now: Date;
  readonly signal?: AbortSignal;
}

/** What a task reports for one case; the runner adds the calls and timing. */
export interface TaskCaseResult {
  readonly usable: boolean;
  readonly checks: readonly BenchCheck[];
  readonly artifact: BenchArtifact | null;
  readonly judgeInput: BenchJudgeInput | null;
  readonly notes: readonly string[];
  /** The model's output broke the pipeline, with the product's own message. */
  readonly modelError?: string;
}

export interface BenchTask<Case extends BenchCaseInfo = BenchCaseInfo> {
  readonly info: Omit<BenchTaskInfo, 'cases'>;
  /** The task's cases, read from its fixtures. */
  cases(): readonly Case[];
  run(testCase: Case, context: TaskContext): Promise<TaskCaseResult>;
}

/** One request a task made, with the reply text it got. */
export interface ObservedCall {
  readonly request: AiChatRequest;
  readonly text: string;
  readonly truncated: boolean;
  readonly error: string | null;
}

/** Wrap `ai` so a task can look at its own requests and replies. */
export function observeChat(ai: ChatApi): { ai: ChatApi; calls: ObservedCall[] } {
  const calls: ObservedCall[] = [];
  return {
    calls,
    ai: {
      chat(request, onEvent) {
        const handle = ai.chat(request, onEvent);
        return {
          cancel: () => handle.cancel(),
          done: handle.done.then((result) => {
            calls.push(
              result.ok
                ? {
                    request,
                    text: result.value.text,
                    truncated: result.value.finishReason === 'length',
                    error: null,
                  }
                : { request, text: '', truncated: false, error: result.error.message },
            );
            return result;
          }),
        };
      },
    },
  };
}

/** A check that is simply met or not. */
export function check(
  id: string,
  label: string,
  pass: boolean,
  weight = 1,
  detail?: string,
): BenchCheck {
  return { id, label, score: pass ? 1 : 0, weight, ...(detail ? { detail } : {}) };
}

/** A check scored by the share of items that meet it; full marks when there are none. */
export function shareCheck(
  id: string,
  label: string,
  met: number,
  total: number,
  weight = 1,
): BenchCheck {
  return {
    id,
    label,
    score: total === 0 ? 1 : met / total,
    weight,
    detail: `${String(met)}/${String(total)}`,
  };
}
