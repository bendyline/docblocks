import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { ProcessCapture } from './types.js';

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export interface ResolvedCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export async function resolveCodexCommand(command: string): Promise<ResolvedCommand> {
  if (process.platform !== 'win32') return { command, prefixArgs: [] };
  const normalized = command.toLowerCase();
  if (normalized !== 'codex' && normalized !== 'codex.cmd' && !normalized.endsWith('codex.cmd')) {
    return { command, prefixArgs: [] };
  }

  const npmRoot = path.isAbsolute(command)
    ? path.dirname(command)
    : process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : null;
  if (!npmRoot) return { command, prefixArgs: [] };
  const script = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try {
    await access(script);
    return { command: process.execPath, prefixArgs: [script] };
  } catch {
    return { command, prefixArgs: [] };
  }
}

export async function runCapturedProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeoutMs: number;
}): Promise<ProcessCapture> {
  const started = Date.now();
  return new Promise<ProcessCapture>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let captureError: Error | null = null;
    const timer = setTimeout(() => {
      captureError = new Error(`Process timed out after ${options.timeoutMs}ms`);
      child.kill();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        captureError = new Error(`Process stdout exceeded ${MAX_CAPTURE_BYTES} bytes`);
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_CAPTURE_BYTES) {
        captureError = new Error(`Process stderr exceeded ${MAX_CAPTURE_BYTES} bytes`);
        child.kill();
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (captureError) {
        reject(captureError);
        return;
      }
      resolve({
        command: options.command,
        args: options.args,
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
      });
    });
    child.stdin.end(options.stdin ?? '');
  });
}
