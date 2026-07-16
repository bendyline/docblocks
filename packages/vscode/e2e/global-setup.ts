import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import path from 'node:path';
import { vscodeWebHost, vscodeWebPort, vscodeWebUrl } from './web-test-settings.js';

const startupTimeoutMs = 60_000;
const shutdownTimeoutMs = 5_000;
const probeTimeoutMs = 1_000;
const probeIntervalMs = 100;
const extensionPath = path.resolve(__dirname, '..');
const fixturesPath = path.resolve(extensionPath, 'test-fixtures');
const testRunnerDataDir = path.resolve(__dirname, '.vscode-test-web');
const require = createRequire(__filename);
const testWebCli = require.resolve('@vscode/test-web/out/server/index.js');
// Keep the E2E runtime reproducible and let @vscode/test-web reuse its local
// cache without first reaching the mutable "latest insiders" endpoint.
const vscodeWebCommit =
  process.env.VSCODE_TEST_WEB_COMMIT ?? 'e8a3eada3426fa6848c7494ebe2291702fef4a61';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.setTimeout(probeTimeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function isPortOccupied(port: number): Promise<boolean> {
  return (await canConnect('127.0.0.1', port)) || (await canConnect('::1', port));
}

export async function assertVscodeWebPortAvailable(port = vscodeWebPort): Promise<void> {
  if (await isPortOccupied(port)) {
    throw new Error(
      `http://localhost:${port} is already used. Stop the existing process before running VS Code web E2E tests.`,
    );
  }
}

function isHttpAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = request(vscodeWebUrl, { method: 'HEAD' }, (response) => {
      response.resume();
      resolve(true);
    });
    probe.setTimeout(probeTimeoutMs, () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => resolve(false));
    probe.end();
  });
}

async function waitForHttpServer(): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpAvailable()) return;
    await delay(probeIntervalMs);
  }
  throw new Error(`Timed out waiting ${startupTimeoutMs}ms for ${vscodeWebUrl}.`);
}

async function waitForPortToClose(): Promise<void> {
  const deadline = Date.now() + shutdownTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOccupied(vscodeWebPort))) return;
    await delay(probeIntervalMs);
  }
  throw new Error(`Timed out waiting ${shutdownTimeoutMs}ms for ${vscodeWebUrl} to stop.`);
}

function startVscodeWebServer(): ChildProcess {
  return spawn(
    process.execPath,
    [
      testWebCli,
      '--quality=insiders',
      `--commit=${vscodeWebCommit}`,
      `--extensionDevelopmentPath=${extensionPath}`,
      '--browser=none',
      `--host=${vscodeWebHost}`,
      `--port=${vscodeWebPort}`,
      '--headless',
      `--testRunnerDataDir=${testRunnerDataDir}`,
      fixturesPath,
    ],
    {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    },
  );
}

function waitForUnexpectedExit(server: ChildProcess): Promise<never> {
  return new Promise((_, reject) => {
    server.once('error', reject);
    server.once('exit', (code, signal) => {
      reject(
        new Error(
          `VS Code web server exited before it became ready (code ${String(code)}, signal ${String(signal)}).`,
        ),
      );
    });
  });
}

async function stopVscodeWebServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;

  const closed = new Promise<void>((resolve) => server.once('close', () => resolve()));
  if (!server.kill()) {
    throw new Error('Failed to terminate the VS Code web server.');
  }

  const timedOut = await Promise.race([
    closed.then(() => false),
    delay(shutdownTimeoutMs).then(() => true),
  ]);
  if (timedOut) {
    throw new Error(`Timed out waiting ${shutdownTimeoutMs}ms for the VS Code web server to exit.`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertVscodeWebPortAvailable();
  const server = startVscodeWebServer();
  const killServerOnExit = (): void => {
    if (server.exitCode === null && server.signalCode === null) server.kill();
  };
  process.once('exit', killServerOnExit);

  try {
    await Promise.race([waitForHttpServer(), waitForUnexpectedExit(server)]);
  } catch (error) {
    process.off('exit', killServerOnExit);
    await stopVscodeWebServer(server);
    throw error;
  }

  return async () => {
    process.off('exit', killServerOnExit);
    await stopVscodeWebServer(server);
    await waitForPortToClose();
  };
}
