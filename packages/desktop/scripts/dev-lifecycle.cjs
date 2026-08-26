'use strict';

const net = require('node:net');

const SUPERVISOR_PORT_ENV = 'DOCBLOCKS_DESKTOP_DEV_SUPERVISOR_PORT';
const SUPERVISOR_TOKEN_ENV = 'DOCBLOCKS_DESKTOP_DEV_SUPERVISOR_TOKEN';

function parseSupervisorPort(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/u.test(value)) return undefined;
  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

function parseSupervisorToken(value) {
  return typeof value === 'string' && /^[a-f\d]{64}$/u.test(value) ? value : undefined;
}

function notifyDevSupervisor(exitCode, environment = process.env, connect = net.connect) {
  const port = parseSupervisorPort(environment[SUPERVISOR_PORT_ENV]);
  const token = parseSupervisorToken(environment[SUPERVISOR_TOKEN_ENV]);
  if (port === undefined || token === undefined) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (notified) => {
      if (settled) return;
      settled = true;
      resolve(notified);
    };
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.end(`${token}:${exitCode}\n`, () => finish(true));
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      finish(false);
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

module.exports = {
  SUPERVISOR_PORT_ENV,
  SUPERVISOR_TOKEN_ENV,
  notifyDevSupervisor,
  parseSupervisorPort,
  parseSupervisorToken,
};
