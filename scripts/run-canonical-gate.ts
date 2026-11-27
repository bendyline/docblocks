import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
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

/**
 * Steps after the gate's own `build` get DOCBLOCKS_E2E_PREBUILT, so the E2E
 * web servers start from that build instead of repeating it inside their
 * startup timeouts.
 */
export function gateStepEnvironment(
  afterBuild: boolean,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = npmChildEnvironment(source);
  if (afterBuild) environment.DOCBLOCKS_E2E_PREBUILT = '1';
  return environment;
}

export function runNpmStep(
  script: string,
  environment: NodeJS.ProcessEnv = npmChildEnvironment(),
): number {
  const result = spawnSync(process.execPath, [npmCli, ...canonicalGateArguments(script)], {
    cwd: repoRoot,
    env: environment,
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

/**
 * The local servers the root E2E configs start and, off CI, reuse
 * (`reuseExistingServer`) when something already answers on the port:
 * playwright.config.ts and playwright.cross-browser.config.ts (site dev
 * server), playwright.offline.config.ts (production preview).
 */
export const E2E_SERVER_PORTS = [
  { port: 5220, purpose: 'site dev server' },
  { port: 5230, purpose: 'offline preview server' },
] as const;

export interface BusyE2EPort {
  readonly port: number;
  readonly purpose: string;
  /** What is listening (`pid 123, started …: command`), where the OS can say. */
  readonly listener: string | null;
}

/** Whether anything accepts connections on `port` at localhost. */
export function isPortListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** The listening process's pid, start time and command, via lsof and ps; null where unavailable. */
function describeListener(port: number): string | null {
  if (process.platform === 'win32') return null;
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  const pid = lsof.status === 0 ? lsof.stdout.split(/\s+/u).find(Boolean) : undefined;
  if (!pid) return null;
  const ps = spawnSync('ps', ['-o', 'lstart=,command=', '-p', pid], { encoding: 'utf8' });
  const line = ps.status === 0 ? ps.stdout.trim() : '';
  // `lstart` is a fixed 24-character date: "Tue Nov 24 12:07:16 2026".
  return line.length > 24
    ? `pid ${pid}, started ${line.slice(0, 24)}: ${line.slice(24).trim()}`
    : `pid ${pid}`;
}

export async function findBusyE2EPorts(): Promise<BusyE2EPort[]> {
  const busy: BusyE2EPort[] = [];
  for (const { port, purpose } of E2E_SERVER_PORTS) {
    if (await isPortListening(port)) busy.push({ port, purpose, listener: describeListener(port) });
  }
  return busy;
}

/** Why the gate will not run its E2E steps while these ports are taken. */
export function describeBusyE2EPorts(busy: readonly BusyE2EPort[], before: string): string {
  const lines = busy.map(
    ({ port, purpose, listener }) =>
      `  port ${port} (${purpose}): ${listener ?? 'something is listening'}`,
  );
  return [
    `Canonical gate stopped before ${before}: a server is already running where the E2E suites start their own.`,
    ...lines,
    'Off CI, Playwright reuses a server it finds there, so the E2E steps would test that server instead of this checkout.',
    'One started before a Squisq link, unlink, or npm install keeps serving the old dependencies and fails every outside-in document test.',
    'Stop it, then run the gate again.',
    '',
  ].join('\n');
}

/**
 * The command that keeps this machine awake for the gate, or null where none
 * is needed. The gate runs for 40 minutes or more, long enough for a Mac on
 * battery with its display off to idle-sleep mid-run. Every test in flight
 * then freezes, and its waits all expire together on wake, as unrelated
 * failures written in the same second (burn-ins on 2026-11-23 and
 * 2026-11-26). `caffeinate -i` holds an assertion against idle sleep, on
 * battery too, without keeping the display on; `-w` ends it when the gate's
 * process exits, however it exits. Closing the lid still sleeps the Mac.
 */
export function idleSleepGuardCommand(
  platform: NodeJS.Platform,
  pid: number,
): { command: string; args: string[] } | null {
  if (platform !== 'darwin') return null;
  return { command: 'caffeinate', args: ['-i', '-w', String(pid)] };
}

function preventIdleSleep(): void {
  const guard = idleSleepGuardCommand(process.platform, process.pid);
  if (!guard) return;
  const child = spawn(guard.command, guard.args, { stdio: 'ignore' });
  // Without caffeinate the gate runs as it always has.
  child.on('error', () => undefined);
  child.unref();
}

export async function runCanonicalGate(): Promise<number> {
  preventIdleSleep();
  // Checked before anything runs, so a stale server costs seconds rather than
  // the build and test steps ahead of the first E2E step, and again before
  // each E2E step in case one was started meanwhile.
  const blocked = async (before: string): Promise<boolean> => {
    const busy = await findBusyE2EPorts();
    if (busy.length === 0) return false;
    process.stderr.write(describeBusyE2EPorts(busy, before));
    return true;
  };
  if (await blocked('its first step')) return 1;

  let built = false;
  for (const script of canonicalGateScripts) {
    if (script.startsWith('test:e2e') && (await blocked(canonicalGateCommand(script)))) return 1;
    const status = runNpmStep(script, gateStepEnvironment(built));
    if (status !== 0) {
      process.stderr.write(
        `Canonical gate stopped because ${canonicalGateCommand(script)} failed with exit code ${status}. Later steps were not run.\n`,
      );
      return status;
    }
    if (script === 'build') built = true;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runCanonicalGate();
}
