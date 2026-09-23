/**
 * Keep the VS Code under test from inheriting its parent editor's identity.
 *
 * `@vscode/test-electron` launches VS Code with a copy of this process's
 * environment. When the suite is started from inside VS Code itself — an
 * integrated terminal, a task, or an agent running in the extension host —
 * that environment describes the parent editor, and two parts of it break the
 * launch outright:
 *
 * - `ELECTRON_RUN_AS_NODE`, which the extension host always sets, turns the
 *   VS Code binary into plain Node. It then tries to execute the test
 *   workspace folder as a script and exits before any window opens.
 * - `VSCODE_*` variables such as `VSCODE_IPC_HOOK` point at the parent
 *   editor's sockets and caches, which can make the launched copy hand off to
 *   the editor the developer is using instead of starting its own.
 *
 * CI starts the suite from a plain shell and never sees either, which is why
 * this only failed on developer machines.
 */

/** Variables read by this runner itself, which must survive the scrub. */
const RUNNER_VARIABLES: ReadonlySet<string> = new Set(['VSCODE_DESKTOP_TEST_VERSION']);

/**
 * Remove inherited editor variables from `env` in place, and return their names.
 *
 * In place because `runTests` always starts from `process.env`: there is no
 * option to hand it a replacement environment.
 */
export function stripInheritedEditorEnvironment(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    const inherited =
      key === 'ELECTRON_RUN_AS_NODE' || (key.startsWith('VSCODE_') && !RUNNER_VARIABLES.has(key));
    if (!inherited) continue;
    delete env[key];
    removed.push(key);
  }
  return removed.sort();
}
