/**
 * Windows update signature check.
 *
 * electron-updater verifies a downloaded NSIS update by running
 * Get-AuthenticodeSignature under a fixed 20 s timeout. The Windows feed
 * publishes the combined x64 + arm64 installer (about 1.3 GB), and Windows can
 * take longer than that to verify a file it has only just written — one
 * machine measured 24 s. The timeout discarded every completed download and
 * surfaced as a generic update failure on each launch.
 *
 * This makes the same check — Authenticode status plus electron-updater's
 * publisher matching — with a timeout sized for that installer. It is wired in
 * through NsisUpdater's documented `verifyUpdateCodeSignature` hook.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseDn } from 'builder-util-runtime';
import type { VerifyUpdateCodeSignature } from 'electron-updater';

/** Generous on purpose: a slow check only delays an error, a short one discards a 1 GB download. */
export const SIGNATURE_CHECK_TIMEOUT_MS = 5 * 60_000;

/** Code on every failure to run the check; updater-result.ts reports it as an unverified update. */
export const SIGNATURE_CHECK_ERROR_CODE = 'ERR_DOCBLOCKS_SIGNATURE_CHECK';

/** System.Management.Automation.SignatureStatus.Valid */
const AUTHENTICODE_VALID = 0;

/** The update path travels in the environment so it is never parsed as PowerShell. */
const UPDATE_FILE_VARIABLE = 'DOCBLOCKS_UPDATE_FILE';

// Errors are written as plain text: left to PowerShell, -EncodedCommand
// reports them on stderr as CLIXML.
const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'try {',
  `  $signature = Get-AuthenticodeSignature -LiteralPath $env:${UPDATE_FILE_VARIABLE}`,
  '  [pscustomobject]@{ Status = [int]$signature.Status; StatusMessage = $signature.StatusMessage; Subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

/** -EncodedCommand sidesteps powershell.exe's command-line quoting rules entirely. */
const ENCODED_SIGNATURE_SCRIPT = Buffer.from(SIGNATURE_SCRIPT, 'utf16le').toString('base64');

export type RunPowerShell = (
  encodedCommand: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string>;

interface SignatureReport {
  readonly status: number;
  readonly statusMessage: string;
  readonly subject: string | null;
}

function signatureCheckError(detail: string): Error {
  return Object.assign(new Error(`Windows update signature check failed: ${detail}`), {
    code: SIGNATURE_CHECK_ERROR_CODE,
  });
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const windows = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function signatureCheckEnvironment(
  updateFile: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // A PowerShell 7 module path stops Windows PowerShell from loading
    // Get-AuthenticodeSignature; without one it uses its own default.
    if (key.toUpperCase() !== 'PSMODULEPATH') env[key] = value;
  }
  env[UPDATE_FILE_VARIABLE] = updateFile;
  return env;
}

const runWindowsPowerShell: RunPowerShell = (encodedCommand, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      windowsPowerShellPath(env),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', encodedCommand],
      { env, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else if (error.killed) {
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
        } else {
          // Not error.message: it echoes the whole encoded command line.
          const detail = stderr.trim().slice(0, 1_000);
          reject(
            new Error(
              `powershell.exe failed (${error.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
            ),
          );
        }
      },
    );
  });

function parseSignatureReport(output: string): SignatureReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const { Status, StatusMessage, Subject } = parsed as Record<string, unknown>;
    if (typeof Status === 'number' && (Subject === null || typeof Subject === 'string')) {
      return {
        status: Status,
        statusMessage: typeof StatusMessage === 'string' ? StatusMessage : '',
        subject: Subject,
      };
    }
  }
  throw signatureCheckError(`unexpected PowerShell output: ${output.trim().slice(0, 200)}`);
}

/**
 * electron-updater's publisher rule: a full distinguished name must match the
 * signer on every attribute it names; a bare name is compared with the
 * signer's common name.
 */
export function signerMatchesPublisher(
  subject: string,
  publisherNames: readonly string[],
): boolean {
  const signer = parseDn(subject);
  return publisherNames.some((name) => {
    const expected = parseDn(name);
    if (expected.size === 0) return name === signer.get('CN');
    return [...expected].every(([key, value]) => signer.get(key) === value);
  });
}

/**
 * Resolves null when the update is validly signed by one of `publisherNames`,
 * or a description of the mismatch, which electron-updater raises as
 * ERR_UPDATER_INVALID_SIGNATURE. Rejects when the check itself cannot run.
 */
export function createWindowsUpdateSignatureVerifier(
  run: RunPowerShell = runWindowsPowerShell,
  timeoutMs: number = SIGNATURE_CHECK_TIMEOUT_MS,
): VerifyUpdateCodeSignature {
  return async (publisherNames, updateFile) => {
    let output: string;
    try {
      output = await run(
        ENCODED_SIGNATURE_SCRIPT,
        signatureCheckEnvironment(updateFile),
        timeoutMs,
      );
    } catch (error: unknown) {
      throw signatureCheckError(error instanceof Error ? error.message : String(error));
    }

    const report = parseSignatureReport(output);
    if (report.status !== AUTHENTICODE_VALID) {
      return `Authenticode status ${report.status}: ${report.statusMessage}`;
    }
    if (report.subject === null || !signerMatchesPublisher(report.subject, publisherNames)) {
      return `signed by "${report.subject ?? 'nobody'}", expected ${publisherNames.join(' | ')}`;
    }
    return null;
  };
}

export const verifyWindowsUpdateSignature = createWindowsUpdateSignatureVerifier();
