/**
 * Runs `tsup --watch --no-clean` for each locally-linked squisq package in parallel.
 *
 * Use after `npm run link:squisq` so that edits to squisq source are
 * rebuilt to `dist/` automatically. Watch builds must not clean `dist/`:
 * DocBlocks can resolve declarations from these linked packages at the same
 * time, and removing the previous `.d.ts` files until tsup emits replacements
 * creates a transient TS7016 failure. Output from each package is prefixed
 * with the package name so streams are easy to attribute. Ctrl-C stops every
 * child process.
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

const packages: [string, string][] = [
  ['core', '@bendyline/squisq'],
  ['react', '@bendyline/squisq-react'],
  ['editor-react', '@bendyline/squisq-editor-react'],
  ['formats', '@bendyline/squisq-formats'],
  ['video', '@bendyline/squisq-video'],
  ['video-react', '@bendyline/squisq-video-react'],
];

const root = path.resolve(import.meta.dirname, '..');
const squisqRoot = path.resolve(root, '..', 'squisq', 'packages');

if (!fs.existsSync(squisqRoot)) {
  console.error(`squisq not found at ${squisqRoot}`);
  process.exit(1);
}

const children: ChildProcess[] = [];

function prefix(name: string, color: number) {
  return `\x1b[${color}m[${name}]\x1b[0m`;
}

function pipeWithPrefix(stream: NodeJS.ReadableStream, tag: string) {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${tag} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) process.stdout.write(`${tag} ${buffer}\n`);
  });
}

for (let i = 0; i < packages.length; i++) {
  const [dir, pkg] = packages[i];
  const cwd = path.resolve(squisqRoot, dir);
  if (!fs.existsSync(cwd)) {
    console.warn(`  SKIP ${pkg} — ${cwd} not found`);
    continue;
  }

  const tag = prefix(pkg, 31 + (i % 6));
  const child = spawn('npx', ['tsup', '--watch', '--no-clean'], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  pipeWithPrefix(child.stdout!, tag);
  pipeWithPrefix(child.stderr!, tag);

  child.on('exit', (code) => {
    process.stdout.write(`${tag} exited (code ${code})\n`);
  });

  process.stdout.write(`${tag} watching ${path.relative(root, cwd)}\n`);
}

function shutdown() {
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
