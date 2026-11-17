import { spawnSync } from 'node:child_process';
import process from 'node:process';

// On a fresh CI runner Gradle downloads the Android Gradle plugin and every
// library from Google Maven and Maven Central, and Maven Central has failed
// release gates for reasons a later attempt does not share: it briefly
// answered 404 for artifacts it hosts, and it rate limited a shared runner
// (HTTP 429) straight through an immediate retry. So a run that failed while
// downloading is retried after a wait long enough for a rate limit to clear.
// Any other failure, such as a compile or build-script error, fails at once.
// The rate limit then outlasted all of these waits, so hosted CI jobs now
// fetch Maven Central's artifacts from Google's mirror instead (see
// .github/actions/maven-central-mirror); these retries remain for whatever
// transient download failure is left.
export const RETRY_DELAYS_SECONDS = [30, 90, 180];

// Gradle's failure report names each dependency it could not fetch. Requiring
// a group:name: coordinate keeps a build-script error such as
// "Could not find method foo()" out of the not-found case.
const NOT_FOUND = /Could not find [\w.-]+:[\w.-]+:/;
const DOWNLOAD_FAILURE = /Could not (?:resolve|download|GET|HEAD) /;

/**
 * Classifies a failed Gradle run from its stderr, which carries Gradle's
 * failure report. Returns undefined for a failure that a retry would repeat.
 */
export function classifyGradleFailure(stderr) {
  const notFound = NOT_FOUND.test(stderr);
  if (!notFound && !DOWNLOAD_FAILURE.test(stderr)) return undefined;
  // Gradle caches a "not found" answer, and only --refresh-dependencies asks
  // again. It also revalidates every artifact already cached, which under a
  // rate limit only adds requests, so it is reserved for that case.
  return { refresh: notFound };
}

const sleep = (seconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

function spawnGradle(args, { cwd, env }) {
  const windows = process.platform === 'win32';
  // stdout streams; stderr is captured to classify a failure, then replayed.
  const result = spawnSync(windows ? 'gradlew.bat' : './gradlew', args, {
    cwd,
    env,
    shell: windows,
    stdio: ['inherit', 'inherit', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  process.stderr.write(result.stderr);
  return result;
}

/**
 * Runs the project's Gradle wrapper, retrying with backoff only when it failed
 * to download dependencies. The error names no arguments, which can carry
 * release properties.
 */
export function runGradle(args, options) {
  const {
    delays = RETRY_DELAYS_SECONDS,
    spawn = spawnGradle,
    wait = sleep,
    log = (message) => process.stderr.write(message),
  } = options;
  let refresh = false;
  for (let attempt = 0; ; attempt++) {
    const result = spawn(refresh ? ['--refresh-dependencies', ...args] : args, options);
    if (result.status === 0) return;
    const failure = classifyGradleFailure(result.stderr ?? '');
    if (!failure || attempt >= delays.length)
      throw new Error(`Gradle failed (${result.status ?? result.signal}).`);
    refresh = failure.refresh;
    log(
      `Gradle could not download dependencies; retrying in ${delays[attempt]}s ` +
        `(attempt ${attempt + 2} of ${delays.length + 1}).\n`,
    );
    wait(delays[attempt]);
  }
}
