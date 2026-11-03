/**
 * Size libuv's worker pool before anything queues work on it.
 *
 * Every async file read, stat and listing in the main process runs on this
 * pool, four threads by default. Reading a OneDrive or iCloud placeholder
 * holds a thread until the download finishes, so a few slow downloads could
 * leave no thread for opening the document the person just clicked. libuv
 * reads the size once, on first use, which is why main.ts imports this module
 * before anything else. An explicit environment value still wins.
 */

export const DESKTOP_THREADPOOL_SIZE = 16;

export function configureThreadPool(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.UV_THREADPOOL_SIZE) env.UV_THREADPOOL_SIZE = String(DESKTOP_THREADPOOL_SIZE);
}

configureThreadPool();
