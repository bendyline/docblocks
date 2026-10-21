// Draw from 20000-32767, below every common ephemeral range (Linux starts at
// 32768, macOS and Windows at 49152). Inside those ranges an open client
// connection can hold the drawn port: the availability probe only sees
// listeners, and the server then fails to bind ::1 with EADDRINUSE.
const minimumDynamicPort = 20_000;
const dynamicPortCount = 12_768;

function parseConfiguredPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('VSCODE_TEST_WEB_PORT must be an integer between 1024 and 65535.');
  }
  return port;
}

function chooseVscodeWebPort(): number {
  const configured = process.env.VSCODE_TEST_WEB_PORT;
  if (configured !== undefined) return parseConfiguredPort(configured);

  const seed = process.pid * 7_919 + Date.now();
  const port = minimumDynamicPort + (seed % dynamicPortCount);
  process.env.VSCODE_TEST_WEB_PORT = String(port);
  return port;
}

export const vscodeWebHost = 'localhost';
export const vscodeWebPort = chooseVscodeWebPort();
export const vscodeWebUrl = `http://${vscodeWebHost}:${vscodeWebPort}`;
