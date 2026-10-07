import { createConnection } from 'node:net';
import process from 'node:process';
const token = process.env.DOCBLOCKS_TEST_TOKEN;
const port = Number(process.env.DOCBLOCKS_TEST_PORT);
if (
  !token ||
  !/^[a-f0-9]{64}$/.test(token) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Missing native test connection.');
const socket = createConnection({ host: '127.0.0.1', port });
socket.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
socket.on('connect', () => {
  socket.write(`${token}\n`);
  process.stdin.pipe(socket);
});
socket.on('close', () => {
  process.stdin.destroy();
});
socket.pipe(process.stdout);
