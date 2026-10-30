import { expect } from 'chai';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { userFacingUpdaterErrorMessage } from '../main/updater-result.js';
import {
  createWindowsUpdateSignatureVerifier,
  signatureCheckEnvironment,
  signerMatchesPublisher,
  SIGNATURE_CHECK_ERROR_CODE,
  SIGNATURE_CHECK_TIMEOUT_MS,
  verifyWindowsUpdateSignature,
  type RunPowerShell,
} from '../main/updater-signature.js';

const BENDYLINE_SUBJECT = 'CN=Bendyline LLC, O=Bendyline LLC, L=Sammamish, S=Washington, C=US';
const UPDATE_FILE =
  'C:\\Users\\someone\\AppData\\Local\\docblocks-desktop-updater\\pending\\temp-DocBlocks-2.7.9-win.exe';

function reporting(report: unknown): RunPowerShell {
  return async () => JSON.stringify(report);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the signature check to reject.');
}

describe('desktop Windows update signature check', () => {
  it('accepts a valid signature from the configured publisher', async () => {
    const verify = createWindowsUpdateSignatureVerifier(
      reporting({ Status: 0, StatusMessage: 'Signature verified.', Subject: BENDYLINE_SUBJECT }),
    );
    expect(await verify(['Bendyline LLC'], UPDATE_FILE)).to.equal(null);
  });

  it('allows far longer than electron-updater and never puts the path in the script', async () => {
    let received: { command: string; env: NodeJS.ProcessEnv; timeoutMs: number } | null = null;
    const verify = createWindowsUpdateSignatureVerifier(async (command, env, timeoutMs) => {
      received = { command, env, timeoutMs };
      return JSON.stringify({ Status: 0, StatusMessage: '', Subject: BENDYLINE_SUBJECT });
    });

    await verify(['Bendyline LLC'], UPDATE_FILE);

    expect(received).to.not.equal(null);
    const { command, env, timeoutMs } = received!;
    expect(timeoutMs).to.equal(SIGNATURE_CHECK_TIMEOUT_MS);
    expect(timeoutMs).to.be.at.least(10 * 20_000);
    const script = Buffer.from(command, 'base64').toString('utf16le');
    expect(script).to.contain('Get-AuthenticodeSignature -LiteralPath $env:DOCBLOCKS_UPDATE_FILE');
    expect(script).to.not.contain('temp-DocBlocks');
    expect(env.DOCBLOCKS_UPDATE_FILE).to.equal(UPDATE_FILE);
  });

  it('drops a PowerShell 7 module path whatever its casing', () => {
    const env = signatureCheckEnvironment(UPDATE_FILE, {
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      PSMODULEPATH: 'C:\\Program Files\\PowerShell\\7\\Modules',
      Path: 'C:\\Windows\\System32',
    });
    expect(env).to.deep.equal({
      Path: 'C:\\Windows\\System32',
      DOCBLOCKS_UPDATE_FILE: UPDATE_FILE,
    });
  });

  it('reports invalid, unsigned, and foreign signatures as mismatches', async () => {
    const tampered = createWindowsUpdateSignatureVerifier(
      reporting({
        Status: 3,
        StatusMessage: 'The hash does not match.',
        Subject: BENDYLINE_SUBJECT,
      }),
    );
    expect(await tampered(['Bendyline LLC'], UPDATE_FILE)).to.equal(
      'Authenticode status 3: The hash does not match.',
    );

    const unsigned = createWindowsUpdateSignatureVerifier(
      reporting({ Status: 2, StatusMessage: 'The file is not signed.', Subject: null }),
    );
    expect(await unsigned(['Bendyline LLC'], UPDATE_FILE)).to.match(/^Authenticode status 2/);

    const foreign = createWindowsUpdateSignatureVerifier(
      reporting({
        Status: 0,
        StatusMessage: '',
        Subject: 'CN=Bendyline LLC Imposter, O=Elsewhere',
      }),
    );
    expect(await foreign(['Bendyline LLC'], UPDATE_FILE)).to.equal(
      'signed by "CN=Bendyline LLC Imposter, O=Elsewhere", expected Bendyline LLC',
    );
  });

  it('matches publishers the way electron-updater does', () => {
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['Bendyline LLC'])).to.equal(true);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['Bendyline'])).to.equal(false);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['Other', 'Bendyline LLC'])).to.equal(true);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, [])).to.equal(false);
    // A full distinguished name must agree on every attribute it names.
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['CN=Bendyline LLC, C=US'])).to.equal(true);
    expect(signerMatchesPublisher(BENDYLINE_SUBJECT, ['CN=Bendyline LLC, C=CA'])).to.equal(false);
    // Quoted values keep their commas.
    expect(signerMatchesPublisher('CN="Bendyline, LLC", C=US', ['Bendyline, LLC'])).to.equal(true);
  });

  it('rejects as an unverified update when the check cannot run or answer', async () => {
    const timedOut = createWindowsUpdateSignatureVerifier(async () => {
      throw new Error('timed out after 300 s');
    });
    const timeoutError = await rejectionOf(timedOut(['Bendyline LLC'], UPDATE_FILE));
    expect(timeoutError).to.be.instanceOf(Error);
    expect((timeoutError as Error & { code?: string }).code).to.equal(SIGNATURE_CHECK_ERROR_CODE);
    expect((timeoutError as Error).message).to.contain('timed out after 300 s');
    expect(userFacingUpdaterErrorMessage(timeoutError)).to.equal(
      'The downloaded update couldn\u2019t be verified, so DocBlocks did not install it. Try again later.',
    );

    for (const output of ['', 'WARNING: something else', '{"Status":"Valid"}', '[0]']) {
      const garbled = createWindowsUpdateSignatureVerifier(async () => output);
      const error = await rejectionOf(garbled(['Bendyline LLC'], UPDATE_FILE));
      expect((error as Error & { code?: string }).code).to.equal(SIGNATURE_CHECK_ERROR_CODE);
    }
  });

  describe('with Windows PowerShell', function () {
    let directory = '';

    before(function () {
      if (process.platform !== 'win32') this.skip();
    });

    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('verifies a real signed file through an awkward path', async function () {
      this.timeout(60_000);
      // Quotes, `$`, and brackets would each break a path spliced into the script.
      directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-signature-'));
      const awkward = path.join(directory, "it's $(not run) [x]");
      await mkdir(awkward);
      const signed = path.join(awkward, 'cmd.exe');
      await copyFile(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        signed,
      );

      expect(await verifyWindowsUpdateSignature(['Microsoft Windows'], signed)).to.equal(null);
      expect(await verifyWindowsUpdateSignature(['Bendyline LLC'], signed)).to.match(
        /^signed by "CN=Microsoft Windows,/,
      );
    });

    it('reports a failed check in plain text', async function () {
      this.timeout(60_000);
      directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-signature-'));
      const missing = path.join(directory, 'missing.exe');

      const error = await rejectionOf(verifyWindowsUpdateSignature(['Bendyline LLC'], missing));
      expect((error as Error & { code?: string }).code).to.equal(SIGNATURE_CHECK_ERROR_CODE);
      expect((error as Error).message).to.equal(
        `Windows update signature check failed: powershell.exe failed (1): File ${missing} was not found.`,
      );
    });
  });
});
