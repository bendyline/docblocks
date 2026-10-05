import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ProviderModelEntry } from './ai-models.js';

export const APPLE_MODEL_ID = 'apple-foundation-models:apple-foundation-models';

export function parseAppleModelHello(value: unknown): ProviderModelEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Apple AI readiness response.');
  const hello = value as Record<string, unknown>;
  const keys = [
    'type',
    'version',
    'os',
    'available',
    'reason',
    'contextTokens',
    'maxOutputTokens',
    'supportsTokenUsage',
    'modelCapabilities',
  ];
  if (
    Object.keys(hello).some((key) => !keys.includes(key)) ||
    hello.type !== 'hello' ||
    typeof hello.available !== 'boolean' ||
    typeof hello.version !== 'string' ||
    hello.version.length > 64 ||
    typeof hello.os !== 'string' ||
    hello.os.length > 256 ||
    typeof hello.contextTokens !== 'number' ||
    !Number.isSafeInteger(hello.contextTokens) ||
    hello.contextTokens < 1 ||
    hello.contextTokens > 1_000_000 ||
    typeof hello.maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(hello.maxOutputTokens) ||
    hello.maxOutputTokens < 1 ||
    hello.maxOutputTokens > 1_000_000 ||
    (hello.reason !== undefined &&
      (typeof hello.reason !== 'string' || hello.reason.length > 2000)) ||
    (hello.supportsTokenUsage !== undefined && typeof hello.supportsTokenUsage !== 'boolean') ||
    (hello.modelCapabilities !== undefined &&
      (!hello.modelCapabilities ||
        typeof hello.modelCapabilities !== 'object' ||
        Array.isArray(hello.modelCapabilities) ||
        Object.entries(hello.modelCapabilities).some(
          ([key, enabled]) =>
            !['tools', 'guidedGeneration', 'vision', 'reasoning'].includes(key) ||
            typeof enabled !== 'boolean',
        )))
  ) {
    throw new Error('Invalid Apple AI readiness response.');
  }
  return {
    id: APPLE_MODEL_ID,
    name: 'Apple Intelligence',
    owned_by: 'apple-foundation-models',
    locality: 'on-device',
    availability: hello.available ? 'available' : 'unavailable',
    context_window: hello.contextTokens,
    ...(hello.available
      ? {}
      : {
          unavailable_reason:
            typeof hello.reason === 'string'
              ? hello.reason
              : 'Apple Intelligence is not ready. Check System Settings.',
        }),
  };
}

/** Readiness only, after AI opt-in and native payload verification. Never installs a model. */
export async function appleModelEntry(
  nativeBinDir: string,
  signal?: AbortSignal,
): Promise<ProviderModelEntry> {
  try {
    signal?.throwIfAborted();
    return await new Promise<ProviderModelEntry>((resolve, reject) => {
      const child = spawn(path.join(nativeBinDir, 'darwin-arm64', 'gezel-apple-fm'), [], {
        stdio: 'pipe',
      });
      let output = '';
      const decoder = new StringDecoder('utf8');
      let bytes = 0;
      let result: ProviderModelEntry | undefined;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new Error('Apple AI readiness check was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(
        () => stop(new Error('Apple Intelligence did not answer its readiness check.')),
        15_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024)
          return stop(new Error('Apple AI readiness response exceeds its limit.'));
        output += decoder.write(chunk);
        const newline = output.indexOf('\n');
        if (newline < 0 || result || failure) return;
        try {
          const value: unknown = JSON.parse(output.slice(0, newline));
          result = parseAppleModelHello(value);
          child.stdin.end();
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) stop(new Error('Apple AI readiness output exceeds its limit.'));
      });
      child.stdin.on('error', (error: Error) => stop(error));
      child.on('error', (error: Error) => {
        failure ??= error;
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (!result || code !== 0)
          reject(new Error('Apple Intelligence readiness helper failed.'));
        else resolve(result);
      });
      child.stdin.write('{"type":"hello"}\n');
    });
  } catch (error) {
    return {
      id: APPLE_MODEL_ID,
      name: 'Apple Intelligence',
      owned_by: 'apple-foundation-models',
      locality: 'on-device',
      availability: 'unavailable',
      unavailable_reason: error instanceof Error ? error.message : String(error),
    };
  }
}
