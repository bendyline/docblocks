#!/usr/bin/env node
'use strict';

const concurrently = require('concurrently');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const { SUPERVISOR_PORT_ENV, SUPERVISOR_TOKEN_ENV } = require('./dev-lifecycle.cjs');

const MAX_LIFECYCLE_MESSAGE_BYTES = 128;

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Desktop dev lifecycle server did not bind a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function runDesktopDev({ concurrentlyImpl = concurrently, processRef = process } = {}) {
  let shutdownRequested = false;
  let requestedExitCode = 0;
  let commands = [];
  const lifecycleToken = randomBytes(32).toString('hex');

  const lifecycleServer = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(2_000, () => socket.destroy());
    let message = '';
    socket.on('data', (chunk) => {
      message += chunk;
      if (Buffer.byteLength(message, 'utf8') > MAX_LIFECYCLE_MESSAGE_BYTES) {
        socket.destroy();
      }
    });
    socket.once('end', () => {
      const match = /^([a-f\d]{64}):(\d{1,3})\n$/u.exec(message);
      if (!match || match[1] !== lifecycleToken || shutdownRequested) return;
      const exitCode = Number(match[2]);
      if (!Number.isSafeInteger(exitCode) || exitCode > 255) return;

      shutdownRequested = true;
      requestedExitCode = exitCode;
      for (const command of commands) command.kill('SIGTERM');
    });
  });
  const lifecyclePort = await listenOnLoopback(lifecycleServer);

  const handleShutdownSignal = () => {
    shutdownRequested = true;
  };

  // Register first so terminal shutdown is recorded before concurrently
  // observes the same signal and settles its result promise.
  processRef.on('SIGINT', handleShutdownSignal);
  processRef.on('SIGTERM', handleShutdownSignal);
  processRef.on('SIGHUP', handleShutdownSignal);

  try {
    const run = concurrentlyImpl(
      [
        {
          command: 'vite --config vite.config.ts',
          name: 'vite',
          prefixColor: 'blue',
        },
        {
          command: 'npm run dev:electron',
          name: 'electron',
          prefixColor: 'green',
          env: {
            [SUPERVISOR_PORT_ENV]: String(lifecyclePort),
            [SUPERVISOR_TOKEN_ENV]: lifecycleToken,
          },
        },
      ],
      {
        killOthers: ['failure'],
        prefix: 'name',
      },
    );
    commands = run.commands;

    try {
      await run.result;
      return requestedExitCode;
    } catch {
      return shutdownRequested ? requestedExitCode : 1;
    }
  } finally {
    processRef.off('SIGINT', handleShutdownSignal);
    processRef.off('SIGTERM', handleShutdownSignal);
    processRef.off('SIGHUP', handleShutdownSignal);
    await closeServer(lifecycleServer);
  }
}

if (require.main === module) {
  void runDesktopDev().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = { runDesktopDev };
