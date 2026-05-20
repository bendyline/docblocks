/**
 * Minimal hook tester — a lightweight alternative to @testing-library/react's
 * `renderHook`. Creates a React root, renders a host component that calls the
 * hook, and exposes the latest return value via `result.current`.
 *
 * Use `act(...)` to wrap any code that triggers state updates (including
 * advancing real timers past a debounce).
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export { act };

export interface HookHandle<P, R> {
  result: { current: R };
  rerender: (nextProps: P) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function renderHook<P, R>(
  hook: (props: P) => R,
  initialProps: P,
): Promise<HookHandle<P, R>> {
  const result = { current: undefined as unknown as R };
  let root: Root | null = null;
  const container = document.createElement('div');

  function HookHost({ p }: { p: P }): ReactElement | null {
    result.current = hook(p);
    return null;
  }

  await act(async () => {
    root = createRoot(container);
    root.render(createElement(HookHost, { p: initialProps }));
  });

  return {
    result,
    rerender: async (nextProps: P) => {
      await act(async () => {
        root?.render(createElement(HookHost, { p: nextProps }));
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
    },
  };
}

/** Sleep `ms` real milliseconds inside an `act` so React doesn't warn. */
export async function advanceTime(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
