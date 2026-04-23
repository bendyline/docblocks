#!/usr/bin/env node
/**
 * Electron launcher that scrubs the environment before spawning.
 *
 * VSCode's JS debug terminal (and Claude Code's shell) set
 * `ELECTRON_RUN_AS_NODE=1` so `require('electron')` returns the Electron
 * binary path (as it does in a normal Node process) — but if that env var
 * leaks into the spawned Electron process itself, Electron runs as Node
 * instead of as the GUI app, the BrowserWindow never opens, and the
 * developer spends an hour wondering what's wrong. We strip the variable
 * before spawning.
 *
 * Pattern: /Volumes/Bendyline/gh/qualla-internal/app/scripts/run-electron.js
 */

const { spawn } = require('child_process');
const path = require('path');

// require('electron') returns the binary path (string) when the current
// process has ELECTRON_RUN_AS_NODE=1 — exactly the case we're in.
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

// Launch the packaged entry point from the repo root (tsup writes
// dist/main/main.cjs which Electron resolves via package.json "main").
const appDir = path.join(__dirname, '..');

// Forward any additional args the caller passed through.
const extraArgs = process.argv.slice(2);
const args = [appDir, ...extraArgs];

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('Failed to start Electron:', err);
  process.exit(1);
});
