import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalGateArguments,
  canonicalGateCommand,
  canonicalGateScripts,
} from './canonical-gate.js';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const npmCli = path.join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');

export function npmChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };

  // npm 12 exports this former npm configuration default to lifecycle scripts.
  // The repository-pinned npm 11.19.1 correctly owns nested commands, but it
  // treats the inherited npm-12-only value as an unknown environment setting
  // and repeats a warning for every nested `npm run`. It has no npm 11 meaning,
  // so remove exactly this compatibility artifact before starting that CLI.
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase().replaceAll('-', '_') === 'npm_config_global_ignore_file') {
      delete environment[name];
    }
  }

  return environment;
}

export function runNpmStep(script: string): number {
  const result = spawnSync(process.execPath, [npmCli, ...canonicalGateArguments(script)], {
    cwd: repoRoot,
    env: npmChildEnvironment(),
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.signal) {
    process.stderr.write(`${canonicalGateCommand(script)} terminated by ${result.signal}.\n`);
    return 1;
  }
  return result.status ?? 1;
}

export function runCanonicalGate(): number {
  for (const script of canonicalGateScripts) {
    const status = runNpmStep(script);
    if (status !== 0) {
      process.stderr.write(
        `Canonical gate stopped because ${canonicalGateCommand(script)} failed with exit code ${status}. Later steps were not run.\n`,
      );
      return status;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runCanonicalGate();
}
