interface ProgressExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  sendNotification(notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total: number;
      message: string;
    };
  }): Promise<void>;
}

interface ProgressState {
  lastPercent: number;
  lastMessage: string | null;
  tail: Promise<void>;
}

const states = new WeakMap<object, ProgressState>();

/** Serialize request progress and project every producer onto one monotonic 0..100 scale. */
export function reportMcpProgress(
  extra: ProgressExtra,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return Promise.resolve();
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 1;
  const safeProgress = Number.isFinite(progress) ? progress : 0;
  const percent = Math.max(0, Math.min(100, (safeProgress / safeTotal) * 100));
  let state = states.get(extra);
  if (!state) {
    state = { lastPercent: -1, lastMessage: null, tail: Promise.resolve() };
    states.set(extra, state);
  }
  const monotonic = Math.max(state.lastPercent, percent);
  if (monotonic === state.lastPercent && message === state.lastMessage) return state.tail;
  state.lastPercent = monotonic;
  state.lastMessage = message;
  state.tail = state.tail
    .then(() =>
      extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: monotonic, total: 100, message },
      }),
    )
    .catch(() => undefined);
  return state.tail;
}
