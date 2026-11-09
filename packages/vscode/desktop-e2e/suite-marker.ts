/**
 * Names the file the desktop suite creates as soon as VS Code hands it control.
 * run.ts relaunches VS Code only when this file is missing, meaning the editor
 * failed before any test ran; a failure after it exists is never retried.
 */
export const SUITE_STARTED_MARKER = 'DOCBLOCKS_DESKTOP_E2E_STARTED_MARKER';

/**
 * Run `launch` until it succeeds, relaunching only while it fails before the
 * suite starts. A failure once `suiteStarted` reports true is the suite's own
 * and is rethrown at once, as is the failure of the final attempt.
 */
export async function retryUntilSuiteStarts(
  launch: (attempt: number) => Promise<void>,
  suiteStarted: (attempt: number) => boolean,
  options: { attempts: number; onRetry: (error: unknown) => void },
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await launch(attempt);
      return;
    } catch (error) {
      if (suiteStarted(attempt) || attempt >= options.attempts) throw error;
      options.onRetry(error);
    }
  }
}
